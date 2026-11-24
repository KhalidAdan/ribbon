//! A CBR in the app (docs/COMICS.md, section 13): a comic in a RAR archive, read where
//! it sits as a CBZ is, through the same commands and the same `ribboncomic` address
//! (comic.rs). The reading itself is the `ribbon-cbr` crate's (../cbr).
//!
//! One thing differs from a zip, and it shapes this file. A RAR has no list of its files
//! at one end: listing one is a walk past every file in it, one small request each, and
//! over a share that is the wait. So an opened CBR is kept, and its list is walked once
//! for everything done with it: its pages named, its cover made, its pages read. Two are
//! kept, the one being read and the one a scan is making a cover of, so neither pushes
//! the other out.

use crate::comic::{base_name, is_litter, is_page, Entry, Listing, COMIC_INFO_MAX, PAGE_MAX};
use ribbon_cbr::Cbr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// An opened CBR, and the file it was opened from as it was then.
struct Kept {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    cbr: Arc<Cbr>,
}

/// The CBRs kept open, the latest used first.
static KEPT: Mutex<Vec<Kept>> = Mutex::new(Vec::new());
const KEPT_MOST: usize = 2;

/// True when the file starts as a RAR archive does, whatever it is called.
pub fn is_rar(path: &Path) -> bool {
    ribbon_cbr::is_rar(path)
}

/// The kept CBR of this file, if it is one and hasn't changed since.
fn kept(path: &Path, len: u64, modified: Option<SystemTime>) -> Option<Arc<Cbr>> {
    let mut all = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    let at = all.iter().position(|k| k.path == path && k.len == len && k.modified == modified)?;
    let found = all.remove(at);
    let cbr = found.cbr.clone();
    all.insert(0, found);
    Some(cbr)
}

/// The CBR at `path`, from those kept or opened now and kept. Refused in a sentence.
fn open(path: &Path) -> Result<Arc<Cbr>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let (len, modified) = (meta.len(), meta.modified().ok());
    if let Some(cbr) = kept(path, len, modified) {
        return Ok(cbr);
    }
    // Opened outside the lock: over a share it takes a while, and a page of another comic shouldn't wait for it.
    let cbr = Arc::new(Cbr::open(path).map_err(|e| e.to_string())?);
    let mut all = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    all.retain(|k| k.path != path);
    all.insert(0, Kept { path: path.to_path_buf(), len, modified, cbr: cbr.clone() });
    all.truncate(KEPT_MOST);
    Ok(cbr)
}

/// What a scan reads of a CBR: its page count and its ComicInfo.xml. None when the file is
/// no RAR, or is one Ribbon refuses: either way a comic with no pages, on the shelf.
/// Nothing is kept: a scan passes every comic once.
pub fn read_listing(path: &Path) -> Option<Listing> {
    let cbr = Cbr::open(path).ok()?;
    let pages = cbr.entries().iter().filter(|e| is_page(&e.name)).count();
    // The one nearest the top, as core's `comicInfoEntry` picks it.
    let info = cbr.entries().iter().filter(|e| !is_litter(&e.name) && base_name(&e.name).eq_ignore_ascii_case("comicinfo.xml")).min_by_key(|e| e.name.matches('/').count());
    let comic_info = info.and_then(|e| cbr.read_entry(&e.name, COMIC_INFO_MAX).ok()).map(|text| String::from_utf8_lossy(&text).into_owned());
    Some(Listing { pages, comic_info })
}

/// Every file in a CBR, with its sizes: a RAR's headers say them as they are walked, so
/// they cost nothing more, and core checks them (`archiveProblem`).
pub fn entries(path: &Path) -> Result<Vec<Entry>, String> {
    Ok(open(path)?.entries().iter().map(|e| Entry { name: e.name.clone(), size: Some(e.size), packed: Some(e.packed) }).collect())
}

/// One file of a CBR, whole. Refused when it would unpack to more than a page could be.
pub fn read_entry(path: &Path, entry: &str) -> Result<Vec<u8>, String> {
    open(path)?.read_entry(entry, PAGE_MAX)
}

/// A page of the file when the file is a CBR, or None when it isn't one. A CBR already
/// kept is known without asking the file anything.
pub fn page(path: &Path, len: u64, modified: Option<SystemTime>, entry: &str) -> Option<Result<Vec<u8>, String>> {
    if kept(path, len, modified).is_none() && !is_rar(path) {
        return None;
    }
    Some(read_entry(path, entry))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comic;
    use std::io::Write;

    /// A scratch folder of this test's own.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ribbon-comic-rar-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A page drawn for the test: one flat colour, as a PNG.
    fn page_png(width: u32, height: u32, shade: u8) -> Vec<u8> {
        let mut png = Vec::new();
        let picture = image::RgbImage::from_pixel(width, height, image::Rgb([shade, 90, 160]));
        image::DynamicImage::ImageRgb8(picture).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        png
    }

    /// A CBR of the given files, packed as real ones are. `old` writes the format before RAR 5.
    fn cbr(path: &Path, files: &[(&str, Vec<u8>)], old: bool) {
        let mut builder = rars::Builder::new(if old { rars::ArchiveVersion::Rar29 } else { rars::ArchiveVersion::Rar50 }).compression_level(Some(3));
        for (name, bytes) in files {
            builder.add_bytes(name.as_bytes().to_vec(), bytes.clone(), None, None).unwrap();
        }
        std::fs::write(path, builder.to_bytes().unwrap()).unwrap();
    }

    fn made() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("scans/page-2.png", page_png(20, 30, 10)),
            ("scans/page-10.png", page_png(1600, 2400, 20)),
            ("__MACOSX/._page-2.png", b"x".to_vec()),
            ("deep/ComicInfo.xml", b"<ComicInfo><Series>Deeper</Series></ComicInfo>".to_vec()),
            ("ComicInfo.xml", b"<ComicInfo><Series>Made Up</Series></ComicInfo>".to_vec()),
            ("notes.txt", b"hello".to_vec()),
        ]
    }

    #[test]
    fn a_cbr_is_scanned_listed_covered_and_read_as_a_cbz_is() {
        let dir = scratch("as-a-cbz");
        for old in [false, true] {
            let file = dir.join(if old { "old.cbr" } else { "new.cbr" });
            let files = made();
            cbr(&file, &files, old);

            let listing = comic::read_listing(&file).unwrap();
            assert_eq!(listing.pages, 2);
            assert_eq!(listing.comic_info.as_deref(), Some("<ComicInfo><Series>Made Up</Series></ComicInfo>"));

            let listed = comic::entries_of(&file).unwrap();
            assert_eq!(listed.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), files.iter().map(|(n, _)| *n).collect::<Vec<_>>());
            assert_eq!(listed[1].size, Some(files[1].1.len() as u64));

            assert_eq!(comic::page_bytes(&file, "scans/page-10.png").unwrap(), files[1].1);
            assert_eq!(comic::page_bytes(&file, "scans/page-2.png").unwrap(), files[0].1);
            assert!(comic::page_bytes(&file, "scans/page-3.png").is_err());

            let cover = dir.join("covers").join(if old { "old.jpg" } else { "new.jpg" });
            assert!(comic::make_cover(&file, "scans/page-10.png", &cover, 800).unwrap());
            let small = image::open(&cover).unwrap();
            assert_eq!((small.width(), small.height()), (800, 1200));
            assert!(!comic::make_cover(&file, "notes.txt", &dir.join("covers").join("no.jpg"), 800).unwrap());
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_is_what_its_first_bytes_say_whatever_it_is_called() {
        let dir = scratch("misnamed");
        // A RAR called .cbz, and a zip called .cbr: both are comics all the same.
        let rar_as_cbz = dir.join("really-a-rar.cbz");
        cbr(&rar_as_cbz, &made(), false);
        let zip_as_cbr = dir.join("really-a-zip.cbr");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_as_cbr).unwrap());
        zip.start_file("001.png", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
        zip.write_all(&page_png(20, 30, 5)).unwrap();
        zip.finish().unwrap();

        assert_eq!(comic::read_listing(&rar_as_cbz).unwrap().pages, 2);
        assert_eq!(comic::read_listing(&zip_as_cbr).unwrap().pages, 1);
        assert_eq!(comic::entries_of(&zip_as_cbr).unwrap().len(), 1);
        assert_eq!(comic::page_bytes(&zip_as_cbr, "001.png").unwrap(), page_png(20, 30, 5));
        assert_eq!(comic::page_bytes(&rar_as_cbz, "scans/page-2.png").unwrap(), made()[0].1);

        // Neither: no listing, as for any file that is no archive.
        let neither = dir.join("neither.cbr");
        std::fs::write(&neither, b"this is not an archive").unwrap();
        assert!(comic::read_listing(&neither).is_none());
        assert!(comic::entries_of(&neither).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cbr_that_changed_is_opened_again_and_one_refused_says_why() {
        let dir = scratch("changed");
        let file = dir.join("made.cbr");
        cbr(&file, &[("001.png", page_png(40, 60, 10))], false);
        assert_eq!(read_entry(&file, "001.png").unwrap(), page_png(40, 60, 10));
        // The same name, another comic of another size: the one kept isn't answered from.
        cbr(&file, &[("001.png", page_png(80, 60, 99)), ("002.png", page_png(40, 60, 10))], false);
        assert_eq!(read_entry(&file, "001.png").unwrap(), page_png(80, 60, 99));
        assert_eq!(entries(&file).unwrap().len(), 2);

        // One part of a split archive: refused in the sentence core knows (comic/cbr.ts).
        let mut builder = rars::Builder::new(rars::ArchiveVersion::Rar50).store(true).volume_size(Some(2_000));
        builder.add_bytes(b"001.png".to_vec(), vec![7u8; 9_000], None, None).unwrap();
        let split = dir.join("split.cbr");
        std::fs::write(&split, &builder.build_volumes(None).unwrap()[0]).unwrap();
        assert_eq!(comic::entries_of(&split).err().as_deref(), Some(ribbon_cbr::SPLIT));
        assert!(comic::read_listing(&split).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
