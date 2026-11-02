//! EPUBs in the app: the parser (the `ribbon-ebook` crate, beside this
//! one), read where the books sit, and the read-along export, which runs
//! ffmpeg and so stays here.

pub use ribbon_ebook::*;

pub mod export;

use std::path::{Path, PathBuf};

/// An EPUB's package, read where the file sits in blocks, so a share
/// across the internet is asked for each block once.
pub fn read_package_at(path: &Path) -> Option<Package> {
    let file = std::fs::File::open(path).ok()?;
    read_package(crate::scan::BlockReader::new(file, PACKAGE_BLOCK).ok()?)
}

/// Block size for reading a package where it sits: the zip directory and the two small files.
const PACKAGE_BLOCK: usize = 32 * 1024;

/// Copy the cover image an EPUB's package names to `target`, read in blocks
/// where the file sits. Ok(false) when it names none.
pub fn extract_cover(src: &Path, target: &Path) -> std::io::Result<bool> {
    let file = std::fs::File::open(src)?;
    ribbon_ebook::extract_cover(crate::scan::BlockReader::new(file, PACKAGE_BLOCK)?, target)
}

/// Where opened books are cached: inside the mirror folder, which the page may already load files from.
pub fn cache_base() -> PathBuf {
    crate::home::mirror_base().join("ebooks")
}

/// Open an EPUB where it sits, through the cache, and give back its book model as JSON.
#[tauri::command]
pub async fn ebook_open(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || open_cached(&path, &cache_base())).await.map_err(|e| e.to_string())?
}
