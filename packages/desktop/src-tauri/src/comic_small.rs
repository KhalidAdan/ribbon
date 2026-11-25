//! Small pictures of a comic's pages (docs/COMICS.md, section 15): each page made 300
//! pixels tall, once, the first time it is asked for, and kept. The strip of small pages
//! along the reader's foot is made of them.
//!
//! They are kept in Ribbon's own folder (home.rs), never beside the comic: the library is
//! only ever read. A comic's pictures sit in a folder named for the comic's file, with a
//! note of the file's size and date; a file that changes has its pictures made again.
//!
//! They are made here rather than in the web view because making one means decoding a
//! whole page, a tenth of a second and tens of megabytes, and the web view is where the
//! pages being read are decoded and drawn. Here it happens on threads of its own, in the
//! one request that asks for the picture, with nothing sent back but a small JPEG. A PDF's
//! are the exception: only the web view can draw a PDF (pdf.js), so it draws them small
//! and hands them here to keep (`comic_small_keep`).

use crate::frames::{allowed, failure, query};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::SystemTime;

/// How tall a small picture is. The strip shows them about 100 points tall, so they stay
/// sharp on a screen of three pixels to the point.
pub const SMALL_HEIGHT: u32 = 300;
/// How well a small picture is kept: a JPEG at this quality is a few kilobytes and looks
/// like its page at the size it is shown.
const QUALITY: u8 = 80;
/// How many pages are made small at once. Each holds its whole page decoded while it is
/// made, 20 MB or more for a scan, so a strip asking for forty at once doesn't take a gigabyte.
const MAKING_AT_ONCE: usize = 4;
/// The note in a comic's folder of the file its pictures were made from.
const ABOUT: &str = "about.txt";

/// A name for a path or an entry that is the same on every run and every version of
/// Rust: FNV-1a, 64 bits, in hex. (The standard library's hasher may change between
/// versions, and these names are kept on disk.)
fn name_of(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Where every comic's small pictures are kept.
fn base() -> PathBuf {
    crate::home::home_dir().join("small-pages")
}

/// The file as it is now: its size and its date. A comic replaced by another of the same
/// name differs in one of them.
fn version_of(comic: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(comic).map_err(|e| e.to_string())?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    Ok(format!("{} {}", meta.len(), modified))
}

/// The folders found to match their comic in this run, so the note in each is read once.
static CHECKED: Mutex<Option<HashMap<PathBuf, String>>> = Mutex::new(None);

/// The folder of `comic`'s small pictures in `under`, made ready: emptied first when the
/// comic is not the file its pictures were made from.
fn folder_in(under: &Path, comic: &Path) -> Result<PathBuf, String> {
    let version = version_of(comic)?;
    let folder = under.join(name_of(&comic.to_string_lossy()));
    let mut checked = CHECKED.lock().unwrap_or_else(|e| e.into_inner());
    let known = checked.get_or_insert_with(HashMap::new);
    if known.get(&folder) == Some(&version) {
        return Ok(folder);
    }
    let about = folder.join(ABOUT);
    let noted = std::fs::read_to_string(&about).ok();
    let same = noted.as_deref().and_then(|n| n.lines().next()) == Some(version.as_str());
    if !same {
        // Pictures of another file, or of this one before it changed.
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        std::fs::write(&about, format!("{version}\n{}\n", comic.display())).map_err(|e| e.to_string())?;
    }
    known.insert(folder.clone(), version);
    Ok(folder)
}

/// Where one page's small picture is kept: by its entry's name in the archive, or a PDF's
/// page by its name (`page=3`), as a comic's place names a page.
fn picture_in(folder: &Path, entry: &str) -> PathBuf {
    folder.join(format!("{}.jpg", name_of(entry)))
}

/// Write a picture so it is never seen half made: beside it, then renamed.
fn keep(target: &Path, jpeg: &[u8]) -> Result<(), String> {
    let scratch = target.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&scratch, jpeg).map_err(|e| e.to_string())?;
    std::fs::rename(&scratch, target).map_err(|e| e.to_string())
}

/// The making allowed at once (`MAKING_AT_ONCE`): a count and a bell for whoever waits.
static MAKING: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

/// Run `make` when fewer than `MAKING_AT_ONCE` others are running.
fn one_of_a_few<T>(make: impl FnOnce() -> T) -> T {
    let (count, bell) = &MAKING;
    {
        let mut running = count.lock().unwrap_or_else(|e| e.into_inner());
        while *running >= MAKING_AT_ONCE {
            running = bell.wait(running).unwrap_or_else(|e| e.into_inner());
        }
        *running += 1;
    }
    let made = make();
    *count.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
    bell.notify_one();
    made
}

/// A page's picture made `SMALL_HEIGHT` tall, as a JPEG; a page already that short is
/// kept at its own size, never made larger.
pub fn make_small(page: &[u8]) -> Result<Vec<u8>, String> {
    let picture = image::load_from_memory(page).map_err(|e| e.to_string())?;
    let (width, height) = (picture.width(), picture.height());
    let small = if height > SMALL_HEIGHT {
        let w = ((width as u64 * SMALL_HEIGHT as u64 + height as u64 / 2) / height as u64).max(1) as u32;
        picture.resize_exact(w, SMALL_HEIGHT, image::imageops::FilterType::Triangle)
    } else {
        picture
    };
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, QUALITY).encode_image(&small.to_rgb8()).map_err(|e| e.to_string())?;
    Ok(jpeg)
}

/// A comic's page small, from those kept in `under` or made now from the archive and kept.
fn small_page_in(under: &Path, comic: &Path, entry: &str) -> Result<Vec<u8>, String> {
    let target = picture_in(&folder_in(under, comic)?, entry);
    if let Ok(kept) = std::fs::read(&target) {
        return Ok(kept);
    }
    let jpeg = one_of_a_few(|| crate::comic::page_bytes(comic, entry).and_then(|page| make_small(&page)))?;
    keep(&target, &jpeg)?;
    Ok(jpeg)
}

/// A page small, for the `ribboncomic` address. A comic's page is made when it isn't kept
/// yet. A PDF's page (`page=3`) is only ever kept: until the web view has drawn it and
/// handed it over, there is none (`None`), and the address answers with nothing.
pub fn small_page(comic: &Path, entry: &str) -> Result<Option<Vec<u8>>, String> {
    if crate::comic::is_page(entry) {
        return small_page_in(&base(), comic, entry).map(Some);
    }
    Ok(std::fs::read(picture_in(&folder_in(&base(), comic)?, entry)).ok())
}

/// The `ribboncomic` address with `small=1`: `?path=<file>&entry=<name>` as for a page.
pub fn respond<R: tauri::Runtime>(app: &tauri::AppHandle<R>, uri: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let (Some(path), Some(entry)) = (query(uri, "path"), query(uri, "entry")) else {
        return failure(StatusCode::BAD_REQUEST, "path and entry are needed".into());
    };
    let path = PathBuf::from(path);
    if !allowed(app, &path) {
        return failure(StatusCode::FORBIDDEN, "not in a library".into());
    }
    match small_page(&path, &entry) {
        Ok(Some(body)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CONTENT_LENGTH, body.len().to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(body)
            .unwrap(),
        // Not made yet: a PDF's page, which the web view draws. Nothing to send, and nothing wrong.
        Ok(None) => Response::builder().status(StatusCode::NO_CONTENT).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new()).unwrap(),
        Err(e) => failure(StatusCode::NOT_FOUND, e),
    }
}

/// Keep a PDF's page drawn small by the web view. The picture is the request's body, and
/// the file and the page are its headers, so the bytes come over as they are.
#[tauri::command]
pub fn comic_small_keep<R: tauri::Runtime>(app: tauri::AppHandle<R>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(|v| crate::frames::percent_decode(v));
    let (Some(path), Some(entry)) = (header("path"), header("entry")) else {
        return Err("path and entry are needed".into());
    };
    let tauri::ipc::InvokeBody::Raw(jpeg) = request.body() else {
        return Err("the picture is sent as bytes".into());
    };
    let path = PathBuf::from(path);
    if !allowed(&app, &path) {
        return Err("not in a library".into());
    }
    // A JPEG, and small: whatever else is sent isn't kept.
    if jpeg.len() > 1 << 20 || !jpeg.starts_with(&[0xff, 0xd8, 0xff]) {
        return Err("not a small JPEG".into());
    }
    keep(&picture_in(&folder_in(&base(), &path)?, &entry), jpeg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ribbon-small-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A page drawn for the test, as a PNG.
    fn page(width: u32, height: u32, shade: u8) -> Vec<u8> {
        let mut png = Vec::new();
        let picture = image::RgbImage::from_pixel(width, height, image::Rgb([shade, 90, 160]));
        image::DynamicImage::ImageRgb8(picture).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        png
    }

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
    fn a_small_picture_is_300_tall_keeps_its_shape_and_is_never_made_larger() {
        let tall = image::load_from_memory(&make_small(&page(1000, 1500, 10)).unwrap()).unwrap();
        assert_eq!((tall.width(), tall.height()), (200, 300));
        // Drawn across two: as tall, twice as wide.
        let wide = image::load_from_memory(&make_small(&page(3000, 2000, 10)).unwrap()).unwrap();
        assert_eq!((wide.width(), wide.height()), (450, 300));
        let short = image::load_from_memory(&make_small(&page(100, 150, 10)).unwrap()).unwrap();
        assert_eq!((short.width(), short.height()), (100, 150));
        assert!(make_small(b"not a picture").is_err());
    }

    #[test]
    fn made_once_kept_out_of_the_library_and_made_again_when_the_comic_changes() {
        let dir = scratch("kept");
        let (library, home) = (dir.join("library"), dir.join("home"));
        std::fs::create_dir_all(&library).unwrap();
        let comic = library.join("made.cbz");
        cbz(&comic, &[("001.png", page(400, 600, 10)), ("002.png", page(400, 600, 200))]);

        let first = small_page_in(&home, &comic, "002.png").unwrap();
        assert_eq!(&first[..3], &[0xff, 0xd8, 0xff]);
        // Nothing beside the comic; one folder for it in Ribbon's own, with its note and the picture.
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 1);
        let folder = folder_in(&home, &comic).unwrap();
        assert!(folder.starts_with(&home) && folder.join(ABOUT).exists());
        let kept = picture_in(&folder, "002.png");
        assert_eq!(std::fs::read(&kept).unwrap(), first);

        // Asked again, it is the kept one, not made again: a picture put in its place is what comes back.
        std::fs::write(&kept, b"\xff\xd8\xff kept").unwrap();
        assert_eq!(small_page_in(&home, &comic, "002.png").unwrap(), b"\xff\xd8\xff kept");

        // Another comic in the same file's place: its pictures go, and are made from it.
        std::thread::sleep(std::time::Duration::from_millis(20));
        cbz(&comic, &[("001.png", page(800, 1200, 99)), ("002.png", page(800, 1200, 50)), ("003.png", page(80, 120, 50))]);
        let again = small_page_in(&home, &comic, "002.png").unwrap();
        assert_ne!(again, b"\xff\xd8\xff kept");
        assert_eq!(image::load_from_memory(&again).unwrap().height(), 300);
        assert!(small_page_in(&home, &comic, "missing.png").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_the_same_on_every_run() {
        // FNV-1a's own test values: these names are on disk, so they must never change.
        assert_eq!(name_of(""), "cbf29ce484222325");
        assert_eq!(name_of("a"), "af63dc4c8601ec8c");
        assert_ne!(name_of("page-1.jpg"), name_of("page-2.jpg"));
    }

    /// How long making a small picture takes, on a page the size of a scan (1988 by 3056,
    /// a JPEG of about 1.8 MB, drawn here with grain so it costs what a scan does to decode).
    /// For the numbers the pull request carries: `--release -- --ignored --nocapture small`.
    /// The page is left in the system's scratch folder, to time the web view on the same one.
    #[test]
    #[ignore]
    fn times_making_a_small_picture_of_a_scan() {
        let (w, h) = (1988u32, 3056u32);
        let mut seed: u32 = 1;
        let picture = image::RgbImage::from_fn(w, h, |x, y| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let n = (seed >> 24) as u8 / 12;
            image::Rgb([((x / 7) as u8).wrapping_add(n), ((y / 5) as u8).wrapping_add(n), (((x + y) / 9) as u8).wrapping_add(n)])
        });
        let mut scan = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut scan, 85).encode_image(&picture).unwrap();
        std::fs::write(std::env::temp_dir().join("ribbon-made-scan.jpg"), &scan).unwrap();
        let ms = |t: std::time::Instant| t.elapsed().as_secs_f64() * 1000.0;
        let mut times = Vec::new();
        let mut size = 0;
        for _ in 0..12 {
            let t = std::time::Instant::now();
            size = make_small(&scan).unwrap().len();
            times.push(ms(t));
        }
        let t = std::time::Instant::now();
        let decoded = image::load_from_memory(&scan).unwrap();
        let decode = ms(t);
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("a scan of {} KB ({}x{}): made small in {:.1} ms at the median, {:.1} slowest; decoding alone {:.1} ms; the small picture {} KB", scan.len() / 1024, decoded.width(), decoded.height(), times[times.len() / 2], times[times.len() - 1], decode, size / 1024);
    }
}
