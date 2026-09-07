//! The fast path for library loading. One command walks the folder and
//! reads tags from every changed audio file in parallel, returning the
//! whole result in a single IPC round trip. No ffprobe, no per-file
//! chatter across the webview boundary.
//!
//! Tags come from the minimal readers in `tags`, which fetch a few
//! kilobytes per file and never read picture data. Files they cannot
//! parse fall back to lofty's format-specific containers (not its
//! generic `Tag`, which drops keys like `series`), and the JavaScript
//! side rescues anything still unread with ffprobe.

use crate::tags::{self, Probed, DEFAULT_MIN_READ};
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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const AUDIO: &[&str] = &["m4b", "m4a", "mp3", "opus", "ogg", "oga", "flac", "wav", "aac", "mp4", "wma"];
const IMAGE: &[&str] = &["jpg", "jpeg", "png", "webp"];
const RIBBON_DIR: &str = ".ribbon";
const LEGACY_DIR: &str = ".odio";
/// Block size for the caching reader used by the lofty fallback.
const READ_BLOCK: usize = 32 * 1024;
/// Tag reading waits on I/O far more than it computes, and network shares
/// reward concurrency, so the pool is much wider than the core count.
const PROBE_THREADS: usize = 48;

fn probe_pool() -> rayon::ThreadPool {
    rayon::ThreadPoolBuilder::new().num_threads(PROBE_THREADS).thread_name(|i| format!("ribbon-probe-{i}")).build().expect("thread pool")
}
/// Files per streamed batch, and the longest a finished file waits.
/// Every batch is a script the webview must evaluate, at a few tens of
/// milliseconds each, so fewer and larger beats many and small.
const BATCH_FILES: usize = 200;
const BATCH_WAIT: Duration = Duration::from_millis(250);
/// The tag keys the web side reads. Everything else stays in Rust so
/// the batches carry only what the shelf needs.
const KEEP_TAGS: &[&str] = &[
    "title", "artist", "album", "album_artist", "albumartist", "author", "composer", "narrator", "performer", "series", "series-part", "series_part",
    "seriespart", "mvnm", "mvin", "grouping", "show", "part", "date", "year", "originaldate", "track", "tracknumber", "disc", "discnumber", "disk",
];
/// Scan batches go to the webview as events. Events ride the same
/// ordered script queue as the command's reply, and on WebView2 that is
/// several times faster than the fetch path a large `Channel` message
/// takes, where forty batches were still in flight when the scan ended.
pub const BATCH_EVENT: &str = "ribbon://scan-batch";

/// Smallest read per fetch, overridable for benchmarks with RIBBON_MIN_READ.
fn min_read() -> usize {
    static MIN: OnceLock<usize> = OnceLock::new();
    *MIN.get_or_init(|| std::env::var("RIBBON_MIN_READ").ok().and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_MIN_READ))
}

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
    pub kind: &'static str,
    pub size_bytes: u64,
    pub mtime_ms: i64,
    /// True when tags were read on this pass. False means "unchanged
    /// since `known`, reuse what you had".
    pub fresh: bool,
    /// True while the file has been found but not yet read. Only ever set
    /// in streamed batches; the final result has none.
    pub pending: bool,
    pub duration_ms: u64,
    pub tags: HashMap<String, String>,
    pub has_cover: bool,
    /// Library-relative path of a cover image written for this file, or
    /// None. The scan itself never writes covers; `extract_cover` does,
    /// once per book, after the library is on screen.
    pub cover: Option<String>,
    /// This scanner never reads chapter markers; ffprobe does, lazily.
    pub chapters_known: bool,
}

/// What the command itself returns. The files went out in batches.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub walked: usize,
    pub probed: usize,
    pub reused: usize,
    /// Files the minimal readers could not parse and lofty read instead.
    pub fallbacks: usize,
    pub elapsed_ms: u64,
}

/// A `Read + Seek` adapter that fetches fixed-size blocks from the inner
/// file and never fetches the same block twice. Used for the lofty
/// fallback, whose parsers issue many small reads and seeks.
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

/// One file found by the walk.
pub struct Entry {
    pub abs: PathBuf,
    pub name: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub kind: &'static str,
}

/// Walk the tree, listing sibling directories in parallel. Hidden entries
/// and the records folder are skipped. Entries within a directory come
/// back in name order, so two walks of the same tree agree. On Windows
/// the size and mtime ride along with the directory listing, so the walk
/// is one request per directory and nothing per file.
pub fn walk(root: &Path) -> Vec<Entry> {
    fn one(dir: &Path) -> Vec<Entry> {
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        let Ok(rd) = std::fs::read_dir(dir) else { return files };
        let mut items: Vec<std::fs::DirEntry> = rd.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == RIBBON_DIR || name == LEGACY_DIR {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                dirs.push(e.path());
            } else if ft.is_file() {
                let abs = e.path();
                let ext = ext_of(&abs);
                let kind = if AUDIO.contains(&ext.as_str()) {
                    "audio"
                } else if IMAGE.contains(&ext.as_str()) {
                    "image"
                } else {
                    continue;
                };
                let Ok(meta) = e.metadata() else { continue };
                files.push(Entry { abs, name, size: meta.len(), mtime_ms: mtime_ms(&meta), kind });
            }
        }
        let sub: Vec<Vec<Entry>> = dirs.par_iter().map(|d| one(d)).collect();
        for s in sub {
            files.extend(s);
        }
        files
    }
    one(root)
}

fn put(tags: &mut HashMap<String, String>, key: &str, value: &str) {
    tags::put(tags, key, value)
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
            Frame::Timestamp(t) => {
                if let Some(k) = id3_key(frame.id().as_str()) {
                    put(&mut out.tags, k, &t.timestamp.to_string());
                }
            }
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

/// The heavier reader, for formats and files the minimal readers do not
/// handle. Never panics; unreadable files come back empty.
pub fn probe_lofty(path: &Path) -> Probed {
    let mut out = Probed::default();
    let Ok(probe) = Probe::open(path) else { return out };
    let Ok(probe) = probe.guess_file_type() else { return out };
    let file_type = probe.file_type();
    // Tag parsers issue many small reads and seeks. Over a network share
    // each one is a round trip, so read in blocks and keep every block.
    let Ok(mut reader) = BlockReader::new(probe.into_inner(), READ_BLOCK) else { return out };
    // Relaxed, like ffmpeg: a malformed frame is skipped, not fatal. The
    // strict default rejected whole books with ordinary ID3v2.3 tags.
    let opts = ParseOptions::new().parsing_mode(lofty::config::ParsingMode::Relaxed);
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

/// Read duration and tags from one file: the minimal reader for its
/// format first, lofty when that fails. `(result, used fallback)`.
pub fn probe(path: &Path, len: Option<u64>) -> (Probed, bool) {
    if let Some((p, _)) = tags::probe_fast(path, len, min_read()) {
        if p.duration_ms > 0 {
            return (p, false);
        }
    }
    (probe_lofty(path), true)
}

/// One streamed step of a scan: files found or finished since the last
/// batch, with the running counts for a progress line. `token` is the
/// caller's, so a listener can ignore batches from another scan.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatch {
    pub token: String,
    pub files: Vec<ScannedFile>,
    pub walked: usize,
    pub done: usize,
    /// Milliseconds after the scan started that this batch was sent.
    pub sent_ms: u64,
}

/// Collects finished files and emits them in batches, so the library
/// fills in as it is read instead of all at the end.
struct Batcher<'a> {
    app: &'a AppHandle,
    token: &'a str,
    walked: usize,
    done: &'a AtomicUsize,
    buf: Mutex<(Vec<ScannedFile>, Instant)>,
    started: Instant,
    sent: AtomicUsize,
}

impl<'a> Batcher<'a> {
    fn send(&self, files: Vec<ScannedFile>) {
        let n = self.sent.fetch_add(1, Ordering::Relaxed) + 1;
        log::debug!("scan_library: batch {n} ({} files) at {:?}", files.len(), self.started.elapsed());
        let batch = ScanBatch { token: self.token.to_string(), files, walked: self.walked, done: self.done.load(Ordering::Relaxed), sent_ms: self.started.elapsed().as_millis() as u64 };
        if let Err(e) = self.app.emit(BATCH_EVENT, batch) {
            log::warn!("scan_library: could not emit batch {n}: {e}");
        }
    }

    fn push(&self, file: ScannedFile) {
        let ready = {
            let mut g = self.buf.lock().unwrap_or_else(|e| e.into_inner());
            g.0.push(file);
            if g.0.len() >= BATCH_FILES || g.1.elapsed() >= BATCH_WAIT {
                g.1 = Instant::now();
                Some(std::mem::take(&mut g.0))
            } else {
                None
            }
        };
        if let Some(files) = ready {
            self.send(files);
        }
    }

    fn flush(&self) {
        let files = {
            let mut g = self.buf.lock().unwrap_or_else(|e| e.into_inner());
            g.1 = Instant::now();
            std::mem::take(&mut g.0)
        };
        if !files.is_empty() {
            self.send(files);
        }
    }
}

fn parent_of(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

/// Scan a library. `known` lists files from the last scan with their
/// size and mtime; matching files are returned without tags so the
/// caller reuses its cache.
///
/// Results stream out as `BATCH_EVENT` events tagged with `token`: first
/// every file the walk found, with unread audio marked pending, so the
/// caller can put the books on screen from folder names alone; then the
/// first file of each folder, which carries the book's author and
/// series; then everything else. Every file is sent exactly once in its
/// final form, so the batches together are the complete list and the
/// command's reply is only a summary.
#[tauri::command]
pub async fn scan_library(app: AppHandle, root: String, known: Vec<KnownFile>, token: String) -> Result<ScanSummary, String> {
    let root = PathBuf::from(&root);
    log::info!("scan_library: start {} ({} known files)", root.display(), known.len());
    if !root.is_dir() {
        log::warn!("scan_library: not a directory: {}", root.display());
        return Err(format!("not a directory: {}", root.display()));
    }
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let pool = probe_pool();
        let entries = pool.install(|| walk(&root));
        let walked = entries.len();
        log::info!("scan_library: walked {} files in {:?}", walked, started.elapsed());
        let known: HashMap<String, (u64, i64)> = known.into_iter().map(|k| (k.path, (k.size_bytes, k.mtime_ms))).collect();

        // Everything the walk found, unread audio marked pending.
        let mut files: Vec<ScannedFile> = Vec::with_capacity(walked);
        let mut to_probe: Vec<usize> = Vec::new();
        let mut reused = 0;
        for (i, e) in entries.iter().enumerate() {
            let rel = rel_path(&root, &e.abs);
            let mut file = ScannedFile {
                path: rel.clone(),
                kind: e.kind,
                size_bytes: e.size,
                mtime_ms: e.mtime_ms,
                fresh: false,
                pending: false,
                duration_ms: 0,
                tags: HashMap::new(),
                has_cover: false,
                cover: None,
                chapters_known: false,
            };
            if e.kind == "audio" {
                let unchanged = known.get(&rel).map(|(s, m)| *s == e.size && (*m - e.mtime_ms).abs() <= 1000).unwrap_or(false);
                if unchanged {
                    reused += 1;
                } else {
                    file.pending = true;
                    to_probe.push(i);
                }
            }
            files.push(file);
        }
        let done = AtomicUsize::new(walked - to_probe.len());
        let batcher = Batcher { app: &app, token: &token, walked, done: &done, buf: Mutex::new((Vec::new(), Instant::now())), started, sent: AtomicUsize::new(0) };
        batcher.send(files.clone());

        // The first unread file of each folder goes first: it names the
        // book's author and series, so the shelf reads right before the
        // durations are in.
        let mut seen_dirs = std::collections::HashSet::new();
        let (firsts, rest): (Vec<usize>, Vec<usize>) = to_probe.into_iter().partition(|&i| seen_dirs.insert(parent_of(&files[i].path).to_string()));
        let fallbacks = AtomicUsize::new(0);
        let probed = firsts.len() + rest.len();
        for pass in [firsts, rest] {
            pool.install(|| pass.into_par_iter().for_each(|i| {
                let e = &entries[i];
                let (p, fell_back) = probe(&e.abs, Some(e.size));
                if fell_back {
                    fallbacks.fetch_add(1, Ordering::Relaxed);
                }
                done.fetch_add(1, Ordering::Relaxed);
                let mut file = files[i].clone();
                file.fresh = true;
                file.pending = false;
                file.duration_ms = p.duration_ms;
                file.tags = p.tags.into_iter().filter(|(k, _)| KEEP_TAGS.contains(&k.as_str())).collect();
                file.has_cover = p.has_cover;
                batcher.push(file);
            }));
        }
        batcher.flush();
        ScanSummary { walked, probed, reused, fallbacks: fallbacks.load(Ordering::Relaxed), elapsed_ms: 0 }
    })
    .await
    .map_err(|e| {
        log::error!("scan_library: worker failed: {e}");
        e.to_string()
    })?;
    let mut result = result;
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    log::info!(
        "scan_library: {} files, {} probed ({} via lofty), {} reused in {} ms",
        result.walked,
        result.probed,
        result.fallbacks,
        result.reused,
        result.elapsed_ms
    );
    Ok(result)
}

/// Copy the picture embedded in `src` to `target`, reading only the
/// picture bytes. Ok(false) when the file has no picture the minimal
/// readers can locate; the caller may then try ffmpeg.
#[tauri::command]
pub async fn extract_cover(src: String, target: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || tags::extract_picture(Path::new(&src), Path::new(&target)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct TextFile {
    pub name: String,
    pub text: String,
}

#[derive(Deserialize)]
pub struct TextFileAt {
    pub path: String,
    pub text: String,
}

/// FNV-1a over a string: a short, stable folder name for a library.
fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Where every library's mirror lives. Allowed for the asset protocol
/// at startup, so covers served from here never touch the share.
pub fn mirror_base(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("mirror"))
}

fn mirror_dir(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    Ok(mirror_base(app)?.join(fnv(&root.replace('\\', "/").trim_end_matches('/').to_lowercase())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    /// This library's mirror folder, absolute, so the web side can point
    /// the asset protocol at `covers/<name>` inside it.
    pub dir: String,
    pub library: String,
    pub files: String,
    /// The merged positions as last read from the share, or None.
    pub positions: Option<String>,
    /// File names present under `covers/`.
    pub covers: Vec<String>,
}

fn list_covers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir.join("covers"))
        .map(|rd| rd.flatten().filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

/// The local copy of a library's records, kept beside the app so a warm
/// open paints without touching the share. The share's records stay the
/// truth: the background rescan reads them and replaces this within a
/// second. None when the library has no mirror yet.
#[tauri::command]
pub async fn mirror_read(app: AppHandle, root: String) -> Result<Option<Mirror>, String> {
    let dir = mirror_dir(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let library = std::fs::read_to_string(dir.join("library.csv")).ok();
        let files = std::fs::read_to_string(dir.join("files.csv")).ok();
        let positions = std::fs::read_to_string(dir.join("positions.csv")).ok();
        Ok(match (library, files) {
            (Some(library), Some(files)) => Some(Mirror { dir: dir.display().to_string(), library, files, positions, covers: list_covers(&dir) }),
            _ => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write whichever of the mirror's files are given.
#[derive(Deserialize)]
pub struct CoverToMirror {
    /// File name to keep it under, `<book id>.<ext>`.
    pub name: String,
    /// Absolute path of the cover beside the books or in `.ribbon/covers`.
    pub src: String,
}

/// Copy covers into the mirror, a few at a time, skipping any already
/// there. Returns every cover name now present. Serving covers from the
/// share through the asset protocol blocks the app's main thread for
/// each read, which on a slow volume stalls everything else the webview
/// is waiting for; a local copy costs nothing to serve.
#[tauri::command]
pub async fn mirror_covers(app: AppHandle, root: String, covers: Vec<CoverToMirror>) -> Result<Vec<String>, String> {
    let dir = mirror_dir(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let target_dir = dir.join("covers");
        std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        let existing = list_covers(&dir);
        let todo: Vec<CoverToMirror> = covers.into_iter().filter(|c| !existing.contains(&c.name) && !c.name.contains(['/', '\\'])).collect();
        let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().map_err(|e| e.to_string())?;
        pool.install(|| {
            todo.par_iter().for_each(|c| {
                let target = target_dir.join(&c.name);
                let tmp = target_dir.join(format!("{}.tmp", c.name));
                if std::fs::copy(&c.src, &tmp).is_ok() && std::fs::rename(&tmp, &target).is_err() {
                    let _ = std::fs::remove_file(&tmp);
                }
            })
        });
        Ok(list_covers(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_write(app: AppHandle, root: String, library: Option<String>, files: Option<String>, positions: Option<String>) -> Result<(), String> {
    let dir = mirror_dir(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let parts = [("library.csv", library), ("files.csv", files), ("positions.csv", positions)];
        for (name, text) in parts.into_iter().filter_map(|(n, t)| t.map(|t| (n, t))) {
            let target = dir.join(name);
            let tmp = dir.join(format!("{name}.tmp"));
            std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write several small text files, each through a sibling temp file and
/// a rename, creating parent folders as needed. One IPC call for all of
/// them, and no chatter with the webview per write.
#[tauri::command]
pub async fn write_text_files(files: Vec<TextFileAt>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for f in files {
            let target = PathBuf::from(&f.path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            let tmp = target.with_extension(format!("{}.tmp", std::process::id()));
            std::fs::write(&tmp, f.text.as_bytes()).map_err(|e| format!("{}: {e}", tmp.display()))?;
            std::fs::rename(&tmp, &target).map_err(|e| format!("{}: {e}", target.display()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
    use crate::tags::LazyFile;
    use std::io::{Read, Seek, SeekFrom};

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    }

    fn track_no(s: Option<&String>) -> u32 {
        s.map(|t| t.split('/').next().unwrap_or("").trim().parse().unwrap_or(0)).unwrap_or(0)
    }

    /// Explain why one file fails: RIBBON_WHY=<path>.
    #[test]
    fn why_does_this_file_fail() {
        let Ok(path) = std::env::var("RIBBON_WHY") else { return };
        let path = PathBuf::from(path);
        match tags::probe_fast(&path, None, min_read()) {
            Some((p, f)) => eprintln!("fast: duration {} ms, {} tags, cover {}, {} bytes in {} reads: {:?}", p.duration_ms, p.tags.len(), p.has_cover, f.fetched, f.trips, p.tags),
            None => eprintln!("fast: could not parse"),
        }
        let p = probe_lofty(&path);
        eprintln!("lofty: duration {} ms, {} tags, cover {}: {:?}", p.duration_ms, p.tags.len(), p.has_cover, p.tags);
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

    /// The minimal readers must agree with lofty on every local file we
    /// have: the sample library and the generated fixtures.
    #[test]
    fn fast_readers_agree_with_lofty() {
        let mut compared = 0;
        let mut fetched_total = 0u64;
        for dir in [repo().join("books"), repo().join("test").join("fixtures").join("generated")] {
            if !dir.is_dir() {
                continue;
            }
            for e in walk(&dir).into_iter().filter(|e| e.kind == "audio") {
                let ext = ext_of(&e.abs);
                if !["mp3", "m4a", "m4b", "mp4", "wma"].contains(&ext.as_str()) {
                    continue;
                }
                let slow = probe_lofty(&e.abs);
                let Some((fast, f)) = tags::probe_fast(&e.abs, Some(e.size), 4096) else {
                    panic!("fast reader rejected {}", e.abs.display());
                };
                let rel = rel_path(&dir, &e.abs);
                eprintln!("{rel}: {} bytes in {} reads; fast {} ms, lofty {} ms", f.fetched, f.trips, fast.duration_ms, slow.duration_ms);
                let tolerance = (slow.duration_ms / 50).max(200);
                assert!((fast.duration_ms as i64 - slow.duration_ms as i64).unsigned_abs() <= tolerance, "{rel}: duration fast {} vs lofty {}", fast.duration_ms, slow.duration_ms);
                for key in ["title", "artist", "album", "album_artist", "composer", "date", "genre", "series", "series-part", "narrator"] {
                    assert_eq!(fast.tags.get(key), slow.tags.get(key), "{rel}: tag {key}");
                }
                assert_eq!(track_no(fast.tags.get("track")), track_no(slow.tags.get("track")), "{rel}: track");
                assert_eq!(fast.has_cover, slow.has_cover, "{rel}: has_cover");
                assert!(f.fetched <= 64 * 1024, "{rel}: read {} bytes; the whole point is to read little", f.fetched);
                fetched_total += f.fetched;
                compared += 1;
            }
        }
        assert!(compared >= 20, "compared only {compared} files");
        eprintln!("compared {compared} files, {} KB fetched in total", fetched_total / 1024);
    }

    /// Runs against the real library beside the repo when it exists,
    /// and against the hard-linked benchmark tree when that exists.
    #[test]
    fn probes_real_files_and_reports_timing() {
        let books = repo().join("books");
        if !books.is_dir() {
            eprintln!("no books folder; skipping");
            return;
        }
        let entries = walk(&books);
        let audio: Vec<_> = entries.iter().filter(|e| e.kind == "audio").collect();
        assert!(audio.len() >= 23, "expected at least 23 audio files, got {}", audio.len());
        let horus = audio.iter().find(|e| e.name == "Chapter 10.m4a").expect("Chapter 10.m4a");
        let (p, fell_back) = probe(&horus.abs, Some(horus.size));
        assert!(!fell_back);
        assert!(p.duration_ms > 1_000, "duration {}", p.duration_ms);
        assert_eq!(p.tags.get("title").map(String::as_str), Some("Chapter 10"));
        assert_eq!(p.tags.get("artist").map(String::as_str), Some("Dan Abnett"));
        assert_eq!(p.tags.get("album").map(String::as_str), Some("Horus Rising (Unabridged)"));
        assert_eq!(p.tags.get("track").map(String::as_str), Some("10"));
        assert!(p.has_cover, "expected an attached picture");
        let pic = p.picture.expect("picture location");
        assert!(pic.len > 1000, "picture is {} bytes", pic.len);
        assert_eq!(pic.ext, "jpg");
        let mut f = LazyFile::open(&horus.abs, Some(horus.size), 4096).unwrap();
        let bytes = f.read(pic.offset, 4).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "picture bytes start with the JPEG marker");

        let mp3 = audio.iter().find(|e| e.name.ends_with(".mp3")).expect("an mp3");
        let (m, fell_back) = probe(&mp3.abs, Some(mp3.size));
        assert!(!fell_back);
        assert!(m.duration_ms > 3_600_000, "mp3 duration {}", m.duration_ms);
        assert!(m.tags.contains_key("title"));
        assert!(!entries.iter().any(|e| e.abs.components().any(|c| c.as_os_str() == RIBBON_DIR || c.as_os_str() == LEGACY_DIR)));

        // Point RIBBON_SCAN_PATH at any folder (a network share, say) to time it.
        if let Ok(extra) = std::env::var("RIBBON_SCAN_PATH") {
            let extra = PathBuf::from(extra);
            let pool = probe_pool();
            let t = std::time::Instant::now();
            let entries = pool.install(|| walk(&extra));
            let walked = t.elapsed();
            let t = std::time::Instant::now();
            let done = AtomicUsize::new(0);
            let fetched = std::sync::atomic::AtomicU64::new(0);
            let trips = AtomicUsize::new(0);
            let fallbacks = AtomicUsize::new(0);
            let n = pool.install(|| entries
                .par_iter()
                .filter(|e| e.kind == "audio")
                .map(|e| {
                    let p = match tags::probe_fast(&e.abs, Some(e.size), min_read()) {
                        Some((p, f)) if p.duration_ms > 0 => {
                            fetched.fetch_add(f.fetched, Ordering::Relaxed);
                            trips.fetch_add(f.trips as usize, Ordering::Relaxed);
                            p
                        }
                        _ => {
                            fallbacks.fetch_add(1, Ordering::Relaxed);
                            eprintln!("  fallback: {}", e.abs.display());
                            probe_lofty(&e.abs)
                        }
                    };
                    let k = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if k % 250 == 0 {
                        eprintln!("  probe: {k} files, {:?} so far", t.elapsed());
                    }
                    p
                })
                .filter(|p| p.duration_ms > 0)
                .count());
            let audio = entries.iter().filter(|e| e.kind == "audio").count();
            eprintln!(
                "extra: walked {} files in {:?}; probed {} of {} audio files in {:?} ({} unreadable, {} lofty fallbacks); {} KB in {} reads, min_read {}",
                entries.len(),
                walked,
                n,
                audio,
                t.elapsed(),
                audio - n,
                fallbacks.load(Ordering::Relaxed),
                fetched.load(Ordering::Relaxed) / 1024,
                trips.load(Ordering::Relaxed),
                min_read()
            );
        }

        let bench = repo().parent().unwrap().join("ribbon-bench");
        if bench.is_dir() {
            let pool = probe_pool();
            let t = std::time::Instant::now();
            let entries = pool.install(|| walk(&bench));
            let walked = t.elapsed();
            let t = std::time::Instant::now();
            let n = pool.install(|| entries.par_iter().filter(|e| e.kind == "audio").map(|e| probe(&e.abs, Some(e.size)).0).filter(|p| p.duration_ms > 0).count());
            eprintln!("bench: walked {} files in {:?}, probed {} audio files in {:?}", entries.len(), walked, n, t.elapsed());
            assert!(n > 20_000);
        }
    }
}
