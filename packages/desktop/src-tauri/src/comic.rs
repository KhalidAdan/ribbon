//! Comics in the app (docs/COMICS.md): a CBZ read where it sits, never unpacked. A CBR,
//! the same comic in a RAR archive, comes through the same doors and is read in
//! comic_rar.rs; which of the two a file is, is told by its first bytes, not its name.
//!
//! Three things are done here, each because the web view can't do it well:
//!
//! - **The scan** reads an archive's list of files and its ComicInfo.xml (`read_listing`):
//!   two small reads from the end of the file and one more, in blocks, so a share across
//!   the internet is asked for each block once.
//! - **A cover** is a page made small (`comic_cover`): a page is thousands of pixels
//!   across, and a shelf of them at full size would be slow and heavy.
//! - **A page** is served at the `ribboncomic` address (`respond`), like `ribbonmp3` and
//!   `ribbonaudio`: a picture of a megabyte or more can't come through a command, whose
//!   replies over 8 KB take a slow path on WebView2.
//!
//! Which entries are pages, and in what order, is decided in one place, core's
//! `comic/pages.ts`. Rust only counts pages for the scan (`is_page`, the same rule,
//! checked against the same cases) and fetches the entry it is asked for by name.

use crate::frames::{allowed, failure, query};
use crate::scan::BlockReader;
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zip::ZipArchive;

/// Block size for reading an archive's list where it sits.
const LIST_BLOCK: usize = 64 * 1024;
/// How much of a file is asked for at once when a page is read: a page is a megabyte or
/// two, so it comes in one or two requests, not hundreds.
const PAGE_BLOCK: usize = 1 << 20;
/// The pictures a web view and the Apple apps both draw (core's `PAGE_EXTENSIONS`).
const PAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];
/// The most a ComicInfo.xml may be and still be read at a scan.
pub(crate) const COMIC_INFO_MAX: u64 = 1 << 20;
/// The most one page may unpack to (core's `ARCHIVE_LIMITS.pageBytes`): past it, the
/// archive is broken or hostile, and the page isn't read.
pub(crate) const PAGE_MAX: u64 = 128 << 20;

fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

pub(crate) fn base_name(name: &str) -> &str {
    name.rsplit_once('/').map(|(_, b)| b).unwrap_or(name)
}

/// What an archive carries that is not the comic: macOS's resource forks, hidden files.
pub(crate) fn is_litter(name: &str) -> bool {
    name.split('/').any(|part| part == "__MACOSX" || part.starts_with('.'))
}

/// True when an archive entry is a page: a picture, not a folder, not litter.
pub fn is_page(name: &str) -> bool {
    !name.ends_with('/') && !is_litter(name) && PAGE_EXTENSIONS.contains(&extension(name).as_str())
}

/// What a scan reads of a comic.
pub struct Listing {
    pub pages: usize,
    /// Its ComicInfo.xml, as text, when it has one.
    pub comic_info: Option<String>,
}

/// A comic's page count and its ComicInfo.xml, with no page opened. None when the file is
/// no archive. Tried first as what its name says it is, so a comic rightly named costs a
/// scan nothing more; a RAR called .cbz, or a zip called .cbr, is found on the second try.
pub fn read_listing(path: &Path) -> Option<Listing> {
    let named_cbr = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cbr"));
    if named_cbr {
        crate::comic_rar::read_listing(path).or_else(|| zip_listing(path))
    } else {
        zip_listing(path).or_else(|| crate::comic_rar::read_listing(path))
    }
}

/// The same of a zip: two small reads from the end of the file, and one more for ComicInfo.xml.
fn zip_listing(path: &Path) -> Option<Listing> {
    let file = File::open(path).ok()?;
    let mut zip = ZipArchive::new(BlockReader::new(file, LIST_BLOCK).ok()?).ok()?;
    let names: Vec<String> = zip.file_names().map(str::to_string).collect();
    let pages = names.iter().filter(|n| is_page(n)).count();
    // The one nearest the top, as core's `comicInfoEntry` picks it.
    let info = names.iter().filter(|n| !is_litter(n) && base_name(n).eq_ignore_ascii_case("comicinfo.xml")).min_by_key(|n| n.matches('/').count());
    let comic_info = info.and_then(|name| {
        let mut entry = zip.by_name(name).ok()?;
        if entry.size() > COMIC_INFO_MAX {
            return None;
        }
        let mut text = Vec::new();
        entry.read_to_end(&mut text).ok()?;
        Some(String::from_utf8_lossy(&text).into_owned())
    });
    Some(Listing { pages, comic_info })
}

/// One file in a comic's archive. A zip's sizes aren't given: reading them costs a request
/// per entry over a share, and what they guard against is checked where a page is read.
/// A RAR's are, since listing one passes every file's header anyway (comic_rar.rs).
#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packed: Option<u64>,
}

/// Every file in a comic's archive, by name, from the archive's own list. A CBR that is
/// refused (locked, split) is refused in a sentence core knows (`comic/cbr.ts`).
pub(crate) fn entries_of(path: &Path) -> Result<Vec<Entry>, String> {
    if crate::comic_rar::is_rar(path) {
        return crate::comic_rar::entries(path);
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let zip = ZipArchive::new(BlockReader::new(file, LIST_BLOCK).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(zip.file_names().filter(|n| !n.ends_with('/')).map(|n| Entry { name: n.to_string(), size: None, packed: None }).collect())
}

#[tauri::command]
pub async fn comic_entries(path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || entries_of(Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// One entry of an archive, whole. Refused when it would unpack to more than a page could be.
fn read_entry<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, entry: &str) -> Result<Vec<u8>, String> {
    let mut file = zip.by_name(entry).map_err(|e| e.to_string())?;
    if file.size() > PAGE_MAX {
        return Err("the page unpacks to more than a page could be".into());
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    // What the archive says a page's size is isn't trusted past the limit either.
    file.by_ref().take(PAGE_MAX + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > PAGE_MAX {
        return Err("the page unpacks to more than a page could be".into());
    }
    Ok(bytes)
}

/// A comic's cover from one of its pages: a JPEG at `target`, no wider than `width`.
/// Ok(false) when the page can't be read as a picture.
pub fn make_cover(path: &Path, entry: &str, target: &Path, width: u32) -> std::io::Result<bool> {
    let bytes = if crate::comic_rar::is_rar(path) {
        crate::comic_rar::read_entry(path, entry)
    } else {
        let file = File::open(path)?;
        let Ok(mut zip) = ZipArchive::new(BufReader::with_capacity(PAGE_BLOCK, file)) else { return Ok(false) };
        read_entry(&mut zip, entry)
    };
    let Ok(bytes) = bytes else { return Ok(false) };
    let Ok(page) = image::load_from_memory(&bytes) else { return Ok(false) };
    let small = if page.width() > width { page.resize(width, u32::MAX, image::imageops::FilterType::Triangle) } else { page };
    let mut jpeg = Vec::new();
    if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85).encode_image(&small.to_rgb8()).is_err() {
        return Ok(false);
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Written beside it and renamed, so a cover is never seen half made.
    let scratch = target.with_extension("comic-cover.tmp");
    std::fs::write(&scratch, &jpeg)?;
    std::fs::rename(&scratch, target)?;
    Ok(true)
}

#[tauri::command]
pub async fn comic_cover(path: String, entry: String, target: String, width: u32) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || make_cover(Path::new(&path), &entry, Path::new(&target), width).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

/// The comic being read, kept open: its list is read once, not once a page. One is
/// enough, since one comic is read at a time; a file that changed is opened again.
struct Open {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    zip: ZipArchive<BufReader<File>>,
}

static OPEN: Mutex<Option<Open>> = Mutex::new(None);

/// A page's bytes, from the comic kept open or one opened now.
pub(crate) fn page_bytes(path: &Path, entry: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let (len, modified) = (meta.len(), meta.modified().ok());
    let mut open = OPEN.lock().unwrap_or_else(|e| e.into_inner());
    let same = open.as_ref().is_some_and(|o| o.path == path && o.len == len && o.modified == modified);
    if !same {
        // A CBR is kept open by its own reader, and its pages come from there.
        if let Some(page) = crate::comic_rar::page(path, len, modified, entry) {
            return page;
        }
        let file = File::open(path).map_err(|e| e.to_string())?;
        let zip = ZipArchive::new(BufReader::with_capacity(PAGE_BLOCK, file)).map_err(|e| e.to_string())?;
        *open = Some(Open { path: path.to_path_buf(), len, modified, zip });
    }
    read_entry(&mut open.as_mut().expect("just opened").zip, entry)
}

/// What a page is, by its name (core's `pageType`).
fn content_type(entry: &str) -> &'static str {
    match extension(entry).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// The `ribboncomic` protocol: `?path=<file>&entry=<name>` is one page of a comic, for
/// an image. Only files the asset scope allows, and only entries that are pages.
pub fn respond<R: tauri::Runtime>(app: &tauri::AppHandle<R>, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let uri = request.uri().to_string();
    let (Some(path), Some(entry)) = (query(&uri, "path"), query(&uri, "entry")) else {
        return failure(StatusCode::BAD_REQUEST, "path and entry are needed".into());
    };
    let path = PathBuf::from(path);
    if !allowed(app, &path) {
        return failure(StatusCode::FORBIDDEN, "not in a library".into());
    }
    if !is_page(&entry) {
        return failure(StatusCode::NOT_FOUND, "not a page".into());
    }
    match page_bytes(&path, &entry) {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&entry))
            .header(header::CONTENT_LENGTH, body.len().to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            // The address names the file as it is now (the page adds its size and date), so a page never changes under it.
            .header(header::CACHE_CONTROL, "private, max-age=86400")
            .body(body)
            .unwrap(),
        Err(e) => failure(StatusCode::NOT_FOUND, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A scratch folder of this test's own.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ribbon-comic-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A page drawn for the test: one flat colour, as a PNG.
    fn page(width: u32, height: u32, shade: u8) -> Vec<u8> {
        let mut png = Vec::new();
        let picture = image::RgbImage::from_pixel(width, height, image::Rgb([shade, 90, 160]));
        image::DynamicImage::ImageRgb8(picture).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        png
    }

    /// A CBZ of the given entries, stored as a comic's pages are.
    fn cbz(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            zip.start_file(*name, stored).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn a_page_is_a_picture_that_is_not_litter() {
        // The cases of core's test (packages/core/test/comic.test.ts): the two must agree.
        assert!(is_page("Pages/Page 1.JPG"));
        assert!(is_page("page-10.webp"));
        assert!(!is_page("__MACOSX/._page-1.jpg"));
        assert!(!is_page(".hidden/page.jpg"));
        assert!(!is_page("pages/._page-1.jpg"));
        assert!(!is_page("ComicInfo.xml"));
        assert!(!is_page("art/"));
        assert!(!is_page("notes.txt"));
    }

    #[test]
    fn a_scan_counts_the_pages_and_reads_comicinfo_without_opening_a_page() {
        let dir = scratch("listing");
        let file = dir.join("made.cbz");
        cbz(
            &file,
            &[
                ("scans/page-2.png", page(20, 30, 10)),
                ("scans/page-10.png", page(20, 30, 20)),
                ("__MACOSX/._page-2.png", b"x".to_vec()),
                ("deep/ComicInfo.xml", b"<ComicInfo><Series>Deeper</Series></ComicInfo>".to_vec()),
                ("ComicInfo.xml", b"<ComicInfo><Series>Made Up</Series></ComicInfo>".to_vec()),
                ("notes.txt", b"hello".to_vec()),
            ],
        );
        let listing = read_listing(&file).unwrap();
        assert_eq!(listing.pages, 2);
        assert_eq!(listing.comic_info.as_deref(), Some("<ComicInfo><Series>Made Up</Series></ComicInfo>"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_that_is_no_archive_has_no_listing() {
        let dir = scratch("broken");
        let file = dir.join("broken.cbz");
        std::fs::write(&file, b"this is not an archive").unwrap();
        assert!(read_listing(&file).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cover_is_a_page_made_small_and_never_made_larger() {
        let dir = scratch("cover");
        let file = dir.join("made.cbz");
        cbz(&file, &[("001.png", page(1600, 2400, 40)), ("002.png", page(300, 450, 80)), ("notes.txt", b"hello".to_vec())]);

        let cover = dir.join("covers").join("big.jpg");
        assert!(make_cover(&file, "001.png", &cover, 800).unwrap());
        let made = image::open(&cover).unwrap();
        assert_eq!((made.width(), made.height()), (800, 1200));
        assert_eq!(&std::fs::read(&cover).unwrap()[..3], &[0xff, 0xd8, 0xff]);

        let small = dir.join("covers").join("small.jpg");
        assert!(make_cover(&file, "002.png", &small, 800).unwrap());
        let made = image::open(&small).unwrap();
        assert_eq!((made.width(), made.height()), (300, 450));

        // Not a picture, and not there: no cover, and no error.
        assert!(!make_cover(&file, "notes.txt", &dir.join("covers").join("no.jpg"), 800).unwrap());
        assert!(!make_cover(&file, "missing.png", &dir.join("covers").join("no.jpg"), 800).unwrap());
        assert!(!dir.join("covers").join("no.jpg").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// How long a real comic takes, when `RIBBON_COMIC_PATH` names one (it is only read):
    /// its list, each of its first pages cold, and its cover. For the numbers a pull request
    /// carries; run with `--release -- --ignored --nocapture comic` for the built app's speed.
    #[test]
    #[ignore]
    fn reads_a_real_comic_and_reports_timing() {
        let Some(path) = std::env::var_os("RIBBON_COMIC_PATH").map(PathBuf::from) else { return };
        let ms = |t: std::time::Instant| t.elapsed().as_secs_f64() * 1000.0;
        let t = std::time::Instant::now();
        let listing = read_listing(&path).expect("a comic");
        println!("list: {} pages, ComicInfo {}, {:.1} ms", listing.pages, if listing.comic_info.is_some() { "read" } else { "none" }, ms(t));

        let zip = ZipArchive::new(BufReader::new(File::open(&path).unwrap())).unwrap();
        let mut pages: Vec<String> = zip.file_names().filter(|n| is_page(n)).map(str::to_string).collect();
        pages.sort();
        let mut times = Vec::new();
        for (i, page) in pages.iter().take(20).enumerate() {
            let t = std::time::Instant::now();
            let bytes = page_bytes(&path, page).unwrap();
            times.push(ms(t));
            if i < 3 {
                println!("page {}: {} KB in {:.1} ms{}", i + 1, bytes.len() / 1024, ms(t), if i == 0 { " (opens the archive)" } else { "" });
            }
        }
        let mut sorted = times[1.min(times.len() - 1)..].to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("pages 2 to {}: median {:.1} ms, slowest {:.1} ms", times.len(), sorted[sorted.len() / 2], sorted[sorted.len() - 1]);

        let cover = std::env::temp_dir().join(format!("ribbon-comic-timing-{}.jpg", std::process::id()));
        let t = std::time::Instant::now();
        let made = make_cover(&path, &pages[0], &cover, 800).unwrap();
        println!("cover: {} in {:.1} ms, {} KB", if made { "made" } else { "not made" }, ms(t), std::fs::metadata(&cover).map(|m| m.len() / 1024).unwrap_or(0));
        let _ = std::fs::remove_file(cover);
    }

    #[test]
    fn a_page_comes_out_of_the_archive_as_it_went_in_and_a_changed_file_is_opened_again() {
        let dir = scratch("page");
        let file = dir.join("made.cbz");
        let (first, second) = (page(40, 60, 10), page(40, 60, 200));
        cbz(&file, &[("001.png", first.clone()), ("002.png", second.clone())]);
        assert_eq!(page_bytes(&file, "002.png").unwrap(), second);
        assert_eq!(page_bytes(&file, "001.png").unwrap(), first);
        assert!(page_bytes(&file, "003.png").is_err());

        // The same name, another comic: the one kept open isn't answered from.
        let other = page(80, 60, 99);
        cbz(&file, &[("001.png", other.clone()), ("002.png", first.clone()), ("003.png", second)]);
        assert_eq!(page_bytes(&file, "001.png").unwrap(), other);
        assert!(page_bytes(&file, "003.png").is_ok());
        assert_eq!(content_type("a/b.JPEG"), "image/jpeg");
        assert_eq!(content_type("b.webp"), "image/webp");
        let _ = std::fs::remove_dir_all(dir);
    }
}
