//! A CBR read where it sits (docs/COMICS.md, section 12): a comic whose pages are in a
//! RAR archive rather than a zip.
//!
//! Three things are done with one, and each has a function here:
//!
//! - **Listing it** (`Cbr::open`, `entries`): every file's name and size. A RAR keeps no
//!   list of its files at one end, as a zip does, so this is a walk past every file's
//!   header: one small request for each (reader.rs).
//! - **Reading a page** (`read`): one file out of the archive, whole. In an archive whose
//!   files were packed one by one, as nearly every CBR's are, that is a jump to the page
//!   and nothing else is touched.
//! - **Writing it out as a CBZ** (`write_cbz`): the same files, under the same names, in a
//!   zip that squeezes nothing. The server keeps every comic as a CBZ, so that every
//!   device reads it with what it already has.
//!
//! The unpacking is the `rars` crate's, written in Rust alone. What is refused is
//! refused here, in a sentence: an archive locked with a password, one split across
//! several files, a page larger than a page could be.
//!
//! The app uses this crate as it is (src/comic_rar.rs); the server runs it as the
//! `ribbon-cbr` command (src/bin/ribbon-cbr.rs).

mod reader;

pub use reader::ReadAhead;

use rars::{Archive, ArchiveFamily, ArchiveReadOptions, ArchiveReader, ErrorKind, ExtractionDecision};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, Write};
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// The most files an archive may hold and still be a comic (core's `ARCHIVE_LIMITS.entries`).
pub const FILES_MAX: u64 = 20_000;
/// The most one page may unpack to (core's `ARCHIVE_LIMITS.pageBytes`).
pub const PAGE_MAX: u64 = 128 << 20;
/// The most a whole comic may unpack to (core's `ARCHIVE_LIMITS.totalBytes`).
pub const TOTAL_MAX: u64 = 16 << 30;
/// The most memory an archive may ask the unpacker to keep of what it has unpacked. RAR's
/// own default is 32 MB; an archive may claim gigabytes, and one that does isn't a comic.
const DICTIONARY_MAX: u64 = 256 << 20;

/// How every RAR archive starts: "Rar!", then two bytes that never change.
const SIGNATURE: &[u8] = b"Rar!\x1a\x07";

/// Why a locked CBR isn't opened. Core says it in the same words (`comic/cbr.ts`), and a test holds the two together.
pub const LOCKED: &str = "It is locked with a password, and Ribbon opens only comics that aren't.";
/// Why one part of a split CBR isn't opened.
pub const SPLIT: &str = "It is one part of an archive split across several files, and Ribbon reads a comic from one file.";

/// Why a file isn't opened as a CBR.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// It doesn't start as a RAR does: a zip, perhaps, under the wrong name.
    NotRar,
    Locked,
    Split,
    /// It starts as a RAR and can't be read as one: cut short, damaged, or holding more than a comic does.
    Broken(String),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::NotRar => write!(f, "It isn't a RAR archive."),
            Refusal::Locked => write!(f, "{LOCKED}"),
            Refusal::Split => write!(f, "{SPLIT}"),
            Refusal::Broken(why) => write!(f, "Its archive can't be read: {why}."),
        }
    }
}

/// What the RAR reader said, as a refusal: a password asked for is a locked archive, the rest is a broken one.
fn refusal(error: rars::Error) -> Refusal {
    match error.kind() {
        ErrorKind::PasswordRequired | ErrorKind::BadPassword => Refusal::Locked,
        // Built without passwords, the reader says an archive whose very list is locked wants a feature it hasn't.
        ErrorKind::UnsupportedFeature if error.to_string().contains("encryption") => Refusal::Locked,
        ErrorKind::ResourceLimit => Refusal::Broken("it holds more than a comic does".into()),
        _ => Refusal::Broken(error.to_string()),
    }
}

/// One file in a CBR.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Its name, with `/` between folders whichever way the archive wrote them.
    pub name: String,
    /// Its size once unpacked, in bytes.
    pub size: u64,
    /// Its size in the archive.
    pub packed: u64,
    /// Where it comes in the archive, which is how the RAR reader is asked for it.
    index: usize,
}

/// A CBR, opened: its list read, its file kept open for the pages.
pub struct Cbr {
    archive: Archive,
    entries: Vec<Entry>,
    by_name: HashMap<String, usize>,
    requests: Arc<AtomicU64>,
}

/// True when a file starts as a RAR archive does, whatever it is called. False when it can't be read.
pub fn is_rar(path: &Path) -> bool {
    let mut start = [0u8; 6];
    File::open(path).and_then(|mut file| file.read_exact(&mut start)).is_ok() && start == SIGNATURE
}

impl Cbr {
    /// Open the CBR at `path`, reading its list of files.
    pub fn open(path: &Path) -> Result<Cbr, Refusal> {
        Cbr::read(File::open(path).map_err(|e| Refusal::Broken(e.to_string()))?)
    }

    /// Open a CBR from anything that reads as a file does.
    pub fn read<R: Read + Seek + Send + 'static>(source: R) -> Result<Cbr, Refusal> {
        let broken = |e: std::io::Error| Refusal::Broken(e.to_string());
        let mut source = ReadAhead::new(source).map_err(broken)?;
        let requests = source.requests();
        // Told by its first bytes before the RAR reader is asked: it would search megabytes of a zip for a RAR inside.
        let mut start = [0u8; 6];
        if source.read_exact(&mut start).is_err() || start != SIGNATURE {
            return Err(Refusal::NotRar);
        }
        // A few more headers than files: the archive's own, and its end.
        let limits = ArchiveReadOptions::new().with_max_header_count(FILES_MAX + 16);
        let archive = ArchiveReader::read_reader_with_options(source, limits).map_err(refusal)?;
        let is_volume = match &archive {
            Archive::Rar13(a) => a.main.is_volume(),
            Archive::Rar15To40(a) => a.main.is_volume(),
            Archive::Rar50Plus(a) => a.main.is_volume(),
            _ => false,
        };
        if is_volume {
            return Err(Refusal::Split);
        }
        // Before RAR 5 folders were parted by a backslash, as on Windows.
        let backslashes = archive.family() != ArchiveFamily::Rar50Plus;
        let mut entries = Vec::new();
        for (index, member) in archive.members().enumerate() {
            let meta = &member.meta;
            if meta.is_directory || meta.is_redirection {
                continue;
            }
            if meta.is_encrypted {
                return Err(Refusal::Locked);
            }
            if meta.is_split_before || meta.is_split_after {
                return Err(Refusal::Split);
            }
            let name = String::from_utf8_lossy(&meta.name).into_owned();
            let name = if backslashes { name.replace('\\', "/") } else { name };
            entries.push(Entry { name, size: meta.unpacked_size, packed: meta.packed_size, index });
        }
        // Two files of one name: the later one, as RAR itself has it.
        let by_name = entries.iter().enumerate().map(|(i, e)| (e.name.clone(), i)).collect();
        Ok(Cbr { archive, entries, by_name, requests })
    }

    /// Every file in the archive, in the order it holds them. Folders aren't listed.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// How many times the file has been asked for bytes so far (reader.rs).
    pub fn requests(&self) -> u64 {
        self.requests.load(Ordering::Relaxed)
    }

    /// One file of the archive, whole. Refused when it would unpack to more than `most` bytes.
    pub fn read_entry(&self, name: &str, most: u64) -> Result<Vec<u8>, String> {
        let entry = self.by_name.get(name).map(|&i| &self.entries[i]).ok_or_else(|| format!("no such file in the archive: {name}"))?;
        if entry.size > most {
            return Err("it unpacks to more than a page could be".into());
        }
        // What the archive says a file's size is isn't trusted past the limit either: the unpacker stops there.
        let limits = ArchiveReadOptions::new().with_max_member_output_bytes(most).with_rar50_dictionary_size_limit(DICTIONARY_MAX);
        match self.archive.read_member_at_with_options(entry.index, limits) {
            Ok(Some(bytes)) => Ok(bytes),
            Ok(None) => Err(format!("no such file in the archive: {name}")),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Write the comic out as a CBZ at `target`: every file under its name, none squeezed, in one
    /// pass through the archive. A page barely shrinks, and a CBZ whose pages are stored is read
    /// a page at a time from where each one sits. Nothing is left at `target` when it fails.
    pub fn write_cbz(&self, target: &Path) -> Result<(), String> {
        let written = self.write_zip(target);
        if written.is_err() {
            let _ = std::fs::remove_file(target);
        }
        written
    }

    fn write_zip(&self, target: &Path) -> Result<(), String> {
        let said = |e: &dyn std::fmt::Display| e.to_string();
        let file = File::create(target).map_err(|e| said(&e))?;
        // Shared with the unpacker, which writes each file's bytes into the zip as it unpacks them.
        let zip = Rc::new(RefCell::new(zip::ZipWriter::new(BufWriter::new(file))));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let names: HashMap<usize, &str> = self.entries.iter().map(|e| (e.index, e.name.as_str())).collect();
        let limits = ArchiveReadOptions::new().with_max_member_output_bytes(PAGE_MAX).with_max_total_output_bytes(TOTAL_MAX).with_rar50_dictionary_size_limit(DICTIONARY_MAX);
        let mut index = 0;
        self.archive
            .extract_with_control(limits, |_| {
                let name = names.get(&index).copied();
                index += 1;
                // A folder has no bytes of its own; its files name it.
                let Some(name) = name else { return Ok(ExtractionDecision::Skip) };
                zip.borrow_mut().start_file(name, stored).map_err(|e| rars::Error::from(std::io::Error::other(e)))?;
                Ok(ExtractionDecision::Extract(Box::new(IntoZip(zip.clone()))))
            })
            .map_err(|e| said(&e))?;
        let zip = Rc::try_unwrap(zip).map_err(|_| "the archive was still being written".to_string())?.into_inner();
        zip.finish().and_then(|mut out| out.flush().map_err(Into::into)).map_err(|e| said(&e))
    }
}

/// The file being written in a zip, as somewhere to write.
struct IntoZip(Rc<RefCell<zip::ZipWriter<BufWriter<File>>>>);

impl Write for IntoZip {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.borrow_mut().write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
