//! The fast path for library loading. One command walks the folder and
//! reads tags from every changed audio file in parallel, returning the
//! whole result in a single IPC round trip. No ffprobe, no per-file
//! chatter across the webview boundary.
//!
//! Tags are read from the format-specific containers rather than lofty's
//! generic `Tag`, because the generic view drops keys it does not know,
//! and audiobooks live on keys like `series` and `series-part`.

use lofty::config::ParseOptions;
use lofty::file::{AudioFile, FileType};
use lofty::flac::FlacFile;
use lofty::id3::v2::{Frame, Id3v2Tag};
use lofty::mp4::{AtomData, AtomIdent, Ilst, Mp4File};
use lofty::mpeg::MpegFile;
use lofty::ogg::tag::VorbisComments;
use lofty::ogg::{OggPictureStorage, OpusFile, VorbisFile};
use lofty::prelude::*;
use lofty::probe::Probe;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const AUDIO: &[&str] = &["m4b", "m4a", "mp3", "opus", "ogg", "oga", "flac", "wav", "aac", "mp4", "wma"];
const IMAGE: &[&str] = &["jpg", "jpeg", "png", "webp"];
const ODIO_DIR: &str = ".odio";
/// Block size for the caching reader used while reading tags.
const READ_BLOCK: usize = 32 * 1024;
/// Tag reading waits on I/O far more than it computes, and network shares
/// reward concurrency, so the pool is much wider than the core count.
const PROBE_THREADS: usize = 48;

fn probe_pool() -> rayon::ThreadPool {
    rayon::ThreadPoolBuilder::new().num_threads(PROBE_THREADS).thread_name(|i| format!("odio-probe-{i}")).build().expect("thread pool")
}
pub const PROGRESS_EVENT: &str = "odio://scan-progress";

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnownFile {
    pub path: String,
    pub size_bytes: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    /// Library-relative, forward slashes.
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size_bytes: u64,
    pub mtime_ms: i64,
    /// True when tags were read on this pass. False means "unchanged
    /// since `known`, reuse what you had".
    pub fresh: bool,
    pub duration_ms: u64,
    pub tags: HashMap<String, String>,
    pub has_cover: bool,
    /// This scanner never reads chapter markers; ffprobe does, lazily.
    pub chapters_known: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub files: Vec<ScannedFile>,
    pub walked: usize,
    pub probed: usize,
    pub reused: usize,
    pub elapsed_ms: u128,
}

/// A `Read + Seek` adapter that fetches fixed-size blocks from the inner
/// file and never fetches the same block twice. Sequential parsing inside
/// a block is free; a seek to somewhere already fetched is free; only new
/// regions touch the file. Files are small in count of distinct regions
/// (a header, maybe a trailer), so this is a handful of reads per file
/// whether the file is local or on a share with 10 ms round trips.
pub struct BlockReader<R: std::io::Read + std::io::Seek> {
    inner: R,
    len: u64,
    pos: u64,
    block: usize,
    blocks: HashMap<u64, Vec<u8>>,
}

impl<R: std::io::Read + std::io::Seek> BlockReader<R> {
    pub fn new(mut inner: R, block: usize) -> std::io::Result<Self> {
        let len = inner.seek(std::io::SeekFrom::End(0))?;
        Ok(Self { inner, len, pos: 0, block, blocks: HashMap::new() })
    }

    fn fetch(&mut self, index: u64) -> std::io::Result<&Vec<u8>> {
        if !self.blocks.contains_key(&index) {
            let start = index * self.block as u64;
            let want = (self.len.saturating_sub(start)).min(self.block as u64) as usize;
            let mut buf = vec![0u8; want];
            self.inner.seek(std::io::SeekFrom::Start(start))?;
            let mut filled = 0;
            while filled < want {
                let n = self.inner.read(&mut buf[filled..])?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            buf.truncate(filled);
            self.blocks.insert(index, buf);
        }
        Ok(&self.blocks[&index])
    }
}

impl<R: std::io::Read + std::io::Seek> std::io::Read for BlockReader<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.len || out.is_empty() {
            return Ok(0);
        }
        let index = self.pos / self.block as u64;
        let offset = (self.pos - index * self.block as u64) as usize;
        let block = self.fetch(index)?;
        if offset >= block.len() {
            return Ok(0);
        }
        let n = out.len().min(block.len() - offset);
        out[..n].copy_from_slice(&block[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl<R: std::io::Read + std::io::Seek> std::io::Seek for BlockReader<R> {
    fn seek(&mut self, from: std::io::SeekFrom) -> std::io::Result<u64> {
        let target = match from {
            std::io::SeekFrom::Start(p) => p as i128,
            std::io::SeekFrom::End(d) => self.len as i128 + d as i128,
            std::io::SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if target < 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = target as u64;
        Ok(self.pos)
    }
}

#[derive(Default)]
pub struct Probed {
    pub duration_ms: u64,
    pub tags: HashMap<String, String>,
    pub has_cover: bool,
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default()
}

fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Walk the tree once. Hidden entries and `.odio` are skipped. `seen` is
/// called every 500 files so a slow disk still shows movement.
pub fn walk(root: &Path, mut seen: impl FnMut(usize)) -> Vec<(PathBuf, String, u64, i64, &'static str)> {
    let mut out = Vec::new();
    let iter = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !(e.depth() > 0 && (name.starts_with('.') || name == ODIO_DIR))
    });
    for entry in iter.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = ext_of(entry.path());
        let kind = if AUDIO.contains(&ext.as_str()) {
            "audio"
        } else if IMAGE.contains(&ext.as_str()) {
            "image"
        } else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push((entry.path().to_path_buf(), name, meta.len(), mtime_ms(&meta), kind));
        if out.len() % 500 == 0 {
            seen(out.len());
        }
    }
    out
}

fn put(tags: &mut HashMap<String, String>, key: &str, value: &str) {
    let v = value.trim();
    if v.is_empty() {
        return;
    }
    tags.entry(key.to_ascii_lowercase()).or_insert_with(|| v.to_string());
}

fn id3_key(id: &str) -> Option<&'static str> {
    Some(match id {
        "TIT2" => "title",
        "TPE1" => "artist",
        "TALB" => "album",
        "TPE2" => "album_artist",
        "TCOM" => "composer",
        "TRCK" => "track",
        "TPOS" => "disc",
        "TDRC" | "TYER" | "TDOR" | "TORY" => "date",
        "TCON" => "genre",
        "TIT1" => "grouping",
        "TIT3" => "subtitle",
        "TPUB" => "publisher",
        _ => return None,
    })
}

fn read_id3(tag: &Id3v2Tag, out: &mut Probed) {
    for frame in tag {
        match frame {
            Frame::Text(t) => {
                if let Some(k) = id3_key(frame.id().as_str()) {
                    put(&mut out.tags, k, &t.value);
                }
            }
            Frame::UserText(u) => put(&mut out.tags, &u.description, &u.content),
            Frame::Picture(_) => out.has_cover = true,
            _ => {}
        }
    }
}

fn mp4_key(fourcc: &str) -> Option<&'static str> {
    Some(match fourcc {
        "\u{a9}nam" => "title",
        "\u{a9}ART" => "artist",
        "\u{a9}alb" => "album",
        "aART" => "album_artist",
        "\u{a9}wrt" => "composer",
        "\u{a9}nrt" => "narrator",
        "\u{a9}day" => "date",
        "\u{a9}gen" => "genre",
        "\u{a9}grp" => "grouping",
        "\u{a9}mvn" => "mvnm",
        "\u{a9}mvi" => "mvin",
        "tvsh" => "show",
        "\u{a9}pub" => "publisher",
        _ => return None,
    })
}

fn read_ilst(ilst: &Ilst, out: &mut Probed) {
    for atom in ilst {
        let key: Option<String> = match atom.ident() {
            AtomIdent::Fourcc(fourcc) => {
                let s: String = fourcc.iter().map(|b| *b as char).collect();
                if s == "covr" {
                    out.has_cover = true;
                    continue;
                }
                mp4_key(&s).map(str::to_string)
            }
            AtomIdent::Freeform { name, .. } => Some(name.to_ascii_lowercase()),
        };
        let Some(key) = key else { continue };
        for data in atom.data() {
            match data {
                AtomData::UTF8(s) | AtomData::UTF16(s) => put(&mut out.tags, &key, s),
                AtomData::SignedInteger(i) => put(&mut out.tags, &key, &i.to_string()),
                AtomData::Picture(_) => out.has_cover = true,
                _ => {}
            }
        }
    }
    if let Some(t) = ilst.track() {
        put(&mut out.tags, "track", &t.to_string());
    }
    if let Some(d) = ilst.disk() {
        put(&mut out.tags, "disc", &d.to_string());
    }
}

fn read_vorbis(vc: &VorbisComments, out: &mut Probed) {
    for (k, v) in vc.items() {
        if k.eq_ignore_ascii_case("metadata_block_picture") {
            out.has_cover = true;
            continue;
        }
        put(&mut out.tags, k, v);
    }
    if !vc.pictures().is_empty() {
        out.has_cover = true;
    }
}

/// Read duration and tags from one file. Never panics; unreadable files
/// come back empty and the caller reports them.
pub fn probe(path: &Path) -> Probed {
    let mut out = Probed::default();
    let Ok(probe) = Probe::open(path) else { return out };
    let Ok(probe) = probe.guess_file_type() else { return out };
    let file_type = probe.file_type();
    // Tag parsers issue many small reads and seeks. Over a network share
    // each one is a round trip, so read in blocks and keep every block.
    let Ok(mut reader) = BlockReader::new(probe.into_inner(), READ_BLOCK) else { return out };
    let opts = ParseOptions::new();
    match file_type {
        Some(FileType::Mpeg) => {
            if let Ok(f) = MpegFile::read_from(&mut reader, opts) {
                out.duration_ms = f.properties().duration().as_millis() as u64;
                if let Some(t) = f.id3v2() {
                    read_id3(t, &mut out);
                }
            }
        }
        Some(FileType::Mp4) => {
            if let Ok(f) = Mp4File::read_from(&mut reader, opts) {
                out.duration_ms = f.properties().duration().as_millis() as u64;
                if let Some(t) = f.ilst() {
                    read_ilst(t, &mut out);
                }
            }
        }
        Some(FileType::Flac) => {
            if let Ok(f) = FlacFile::read_from(&mut reader, opts) {
                out.duration_ms = f.properties().duration().as_millis() as u64;
                if let Some(t) = f.vorbis_comments() {
                    read_vorbis(t, &mut out);
                }
                if !f.pictures().is_empty() {
                    out.has_cover = true;
                }
            }
        }
        Some(FileType::Opus) => {
            if let Ok(f) = OpusFile::read_from(&mut reader, opts) {
                out.duration_ms = f.properties().duration().as_millis() as u64;
                read_vorbis(f.vorbis_comments(), &mut out);
            }
        }
        Some(FileType::Vorbis) => {
            if let Ok(f) = VorbisFile::read_from(&mut reader, opts) {
                out.duration_ms = f.properties().duration().as_millis() as u64;
                read_vorbis(f.vorbis_comments(), &mut out);
            }
        }
        _ => {
            // Anything else gets lofty's generic view: known keys only.
            if let Ok(tagged) = lofty::read_from_path(path) {
                out.duration_ms = tagged.properties().duration().as_millis() as u64;
                for tag in tagged.tags() {
                    if !tag.pictures().is_empty() {
                        out.has_cover = true;
                    }
                    for item in tag.items() {
                        let key = match item.key() {
                            ItemKey::TrackTitle => "title",
                            ItemKey::TrackArtist => "artist",
                            ItemKey::AlbumTitle => "album",
                            ItemKey::AlbumArtist => "album_artist",
                            ItemKey::Composer => "composer",
                            ItemKey::TrackNumber => "track",
                            ItemKey::DiscNumber => "disc",
                            ItemKey::Year | ItemKey::RecordingDate => "date",
                            ItemKey::Genre => "genre",
                            _ => continue,
                        };
                        if let Some(text) = item.value().text() {
                            put(&mut out.tags, key, text);
                        }
                    }
                }
            }
        }
    }
    out
}

/// Scan a library. `known` lists files from the last scan with their
/// size and mtime; matching files are returned without tags so the
/// caller reuses its cache. Progress is emitted every 250 files.
#[tauri::command]
pub async fn scan_library(app: AppHandle, root: String, known: Vec<KnownFile>) -> Result<ScanResult, String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let started = std::time::Instant::now();
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let walker = handle.clone();
        let entries = walk(&root, move |n| {
            let _ = walker.emit(PROGRESS_EVENT, serde_json::json!({ "walked": 0, "done": 0, "found": n }));
        });
        let walked = entries.len();
        let known: HashMap<String, (u64, i64)> = known.into_iter().map(|k| (k.path, (k.size_bytes, k.mtime_ms))).collect();
        let done = AtomicUsize::new(0);
        let probed = AtomicUsize::new(0);
        let reused = AtomicUsize::new(0);
        let _ = handle.emit(PROGRESS_EVENT, serde_json::json!({ "walked": walked, "done": 0 }));
        let pool = probe_pool();
        let files: Vec<ScannedFile> = pool.install(|| entries
            .into_par_iter()
            .map(|(abs, name, size, mtime, kind)| {
                let rel = rel_path(&root, &abs);
                let mut file = ScannedFile {
                    path: rel.clone(),
                    name,
                    kind,
                    size_bytes: size,
                    mtime_ms: mtime,
                    fresh: false,
                    duration_ms: 0,
                    tags: HashMap::new(),
                    has_cover: false,
                    chapters_known: false,
                };
                if kind == "audio" {
                    let unchanged = known.get(&rel).map(|(s, m)| *s == size && (*m - mtime).abs() <= 1000).unwrap_or(false);
                    if unchanged {
                        reused.fetch_add(1, Ordering::Relaxed);
                    } else {
                        let p = probe(&abs);
                        file.fresh = true;
                        file.duration_ms = p.duration_ms;
                        file.tags = p.tags;
                        file.has_cover = p.has_cover;
                        probed.fetch_add(1, Ordering::Relaxed);
                    }
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 250 == 0 {
                    let _ = handle.emit(PROGRESS_EVENT, serde_json::json!({ "walked": walked, "done": n }));
                }
                file
            })
            .collect());
        ScanResult {
            files,
            walked,
            probed: probed.load(Ordering::Relaxed),
            reused: reused.load(Ordering::Relaxed),
            elapsed_ms: 0,
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut result = result;
    result.elapsed_ms = started.elapsed().as_millis();
    let _ = app.emit(PROGRESS_EVENT, serde_json::json!({ "walked": result.walked, "done": result.walked }));
    Ok(result)
}

#[derive(Serialize)]
pub struct TextFile {
    pub name: String,
    pub text: String,
}

/// Every small text file in a directory, in one round trip. Used for
/// the positions and chapters folders, where one book is one file.
#[tauri::command]
pub async fn read_text_dir(dir: String) -> Result<Vec<TextFile>, String> {
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || meta.len() > 1_048_576 {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(entry.path()) {
            out.push(TextFile { name: entry.file_name().to_string_lossy().into_owned(), text });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};

    /// Wraps a reader and logs every read and seek, to see what a parser
    /// actually touches. Run with ODIO_TRACE=1 to print.
    struct Tracing<R> {
        inner: R,
        pos: u64,
        reads: usize,
        seeks: usize,
        bytes: u64,
        log: Vec<String>,
    }
    impl<R: Read> Read for Tracing<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.reads += 1;
            self.bytes += n as u64;
            self.log.push(format!("read {} @ {}", n, self.pos));
            self.pos += n as u64;
            Ok(n)
        }
    }
    impl<R: Seek> Seek for Tracing<R> {
        fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
            let p = self.inner.seek(from)?;
            self.seeks += 1;
            self.log.push(format!("seek -> {p}"));
            self.pos = p;
            Ok(p)
        }
    }

    #[test]
    fn trace_parser_access_pattern() {
        if std::env::var("ODIO_TRACE").is_err() {
            return;
        }
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        for name in ["Horus Rising/Chapter 10.m4a", "EgoIstheEnemy_ep6.mp3"] {
            let path = repo.join("books").join(name);
            let f = std::fs::File::open(&path).unwrap();
            let len = f.metadata().unwrap().len();
            let mut t = Tracing { inner: f, pos: 0, reads: 0, seeks: 0, bytes: 0, log: Vec::new() };
            let opts = ParseOptions::new();
            if name.ends_with(".mp3") {
                let _ = MpegFile::read_from(&mut t, opts);
            } else {
                let _ = Mp4File::read_from(&mut t, opts);
            }
            eprintln!("{name}: len {len}, {} reads, {} seeks, {} bytes", t.reads, t.seeks, t.bytes);
            let shown: Vec<&String> = t.log.iter().take(40).collect();
            eprintln!("  first ops: {shown:?}");
            if t.log.len() > 40 {
                let tail: Vec<&String> = t.log.iter().rev().take(8).collect();
                eprintln!("  last ops: {tail:?}");
            }
        }
    }

    #[test]
    fn block_reader_matches_plain_reads_across_boundaries_and_seeks() {
        let data: Vec<u8> = (0..10_007u32).map(|i| (i % 251) as u8).collect();
        let mut r = BlockReader::new(std::io::Cursor::new(data.clone()), 1000).unwrap();
        let mut buf = vec![0u8; 2500];
        r.seek(SeekFrom::Start(990)).unwrap();
        r.read_exact(&mut buf).unwrap();
        assert_eq!(&buf[..], &data[990..3490]);
        r.seek(SeekFrom::End(-7)).unwrap();
        let mut tail = Vec::new();
        r.read_to_end(&mut tail).unwrap();
        assert_eq!(&tail[..], &data[10_000..]);
        r.seek(SeekFrom::Start(0)).unwrap();
        let mut all = Vec::new();
        r.read_to_end(&mut all).unwrap();
        assert_eq!(all, data);
        assert_eq!(r.blocks.len(), 11, "every block fetched exactly once");
        assert_eq!(r.seek(SeekFrom::Current(-5)).unwrap(), 10_002);
        assert!(r.seek(SeekFrom::Current(-20_000)).is_err());
    }

    /// Runs against the real library beside the repo when it exists,
    /// and against the hard-linked benchmark tree when that exists.
    #[test]
    fn probes_real_files_and_reports_timing() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let books = repo.join("books");
        if !books.is_dir() {
            eprintln!("no books folder; skipping");
            return;
        }
        let entries = walk(&books, |_| {});
        let audio: Vec<_> = entries.iter().filter(|e| e.4 == "audio").collect();
        assert!(audio.len() >= 23, "expected at least 23 audio files, got {}", audio.len());
        let horus = audio.iter().find(|e| e.1 == "Chapter 10.m4a").expect("Chapter 10.m4a");
        let p = probe(&horus.0);
        assert!(p.duration_ms > 1_000, "duration {}", p.duration_ms);
        assert_eq!(p.tags.get("title").map(String::as_str), Some("Chapter 10"));
        assert_eq!(p.tags.get("artist").map(String::as_str), Some("Dan Abnett"));
        assert_eq!(p.tags.get("album").map(String::as_str), Some("Horus Rising (Unabridged)"));
        assert_eq!(p.tags.get("track").map(String::as_str), Some("10"));
        assert!(p.has_cover, "expected an attached picture");

        let mp3 = audio.iter().find(|e| e.1.ends_with(".mp3")).expect("an mp3");
        let m = probe(&mp3.0);
        assert!(m.duration_ms > 3_600_000, "mp3 duration {}", m.duration_ms);
        assert!(m.tags.contains_key("title"));
        // This file keeps its picture outside the first ID3v2 tag, so the
        // fast scanner does not see it; the lazy ffprobe pass does.
        assert!(!entries.iter().any(|e| e.0.components().any(|c| c.as_os_str() == ODIO_DIR)));

        // Point ODIO_SCAN_PATH at any folder (a network share, say) to time it.
        if let Ok(extra) = std::env::var("ODIO_SCAN_PATH") {
            let extra = PathBuf::from(extra);
            let t = std::time::Instant::now();
            let mut last = std::time::Instant::now();
            let entries = walk(&extra, |n| {
                eprintln!("  walk: {n} files, +{:?}", last.elapsed());
                last = std::time::Instant::now();
            });
            let walked = t.elapsed();
            let t = std::time::Instant::now();
            let done = AtomicUsize::new(0);
            let n = probe_pool().install(|| entries
                .par_iter()
                .filter(|e| e.4 == "audio")
                .map(|e| {
                    let p = probe(&e.0);
                    let k = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if k % 100 == 0 {
                        eprintln!("  probe: {k} files, {:?} so far", t.elapsed());
                    }
                    p
                })
                .filter(|p| p.duration_ms > 0)
                .count());
            eprintln!("extra: walked {} files in {:?}, probed {} audio files in {:?}", entries.len(), walked, n, t.elapsed());
        }

        let bench = repo.parent().unwrap().join("odio-bench");
        if bench.is_dir() {
            let t = std::time::Instant::now();
            let entries = walk(&bench, |_| {});
            let walked = t.elapsed();
            let t = std::time::Instant::now();
            let n = probe_pool().install(|| entries.par_iter().filter(|e| e.4 == "audio").map(|e| probe(&e.0)).filter(|p| p.duration_ms > 0).count());
            eprintln!("bench: walked {} files in {:?}, probed {} audio files in {:?}", entries.len(), walked, n, t.elapsed());
            assert!(n > 20_000);
        }
    }
}
