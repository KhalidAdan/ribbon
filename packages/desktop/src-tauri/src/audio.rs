//! The `ribbonaudio` protocol: a book's audio file for the player on Apple's webview (#226).
//!
//! An .m4b keeps an index of where each moment of its audio is (its `moov` box), several megabytes
//! long in a long book, often at the end. The player reads all of it before it plays a second, and
//! WebKit's asks for it in one request (7.13 MB of The High Kâhl's Oath's 8 MB index) and won't take
//! less: Tauri's asset protocol gives at most a megabyte of any range, and given that, or the 4 MB
//! `ribbonmp3` gives, it says "The operation is not supported" and never plays. An MP3 has no index,
//! an .m4b with its index first is read from the start, and WebView2, on Windows, asks again for the
//! rest, so those play from the asset protocol. Here a modest range is given whole, the index with
//! it, and the rest of the file a few megabytes at a time, as `ribbonmp3` gives an MP3 (frames.rs).

use crate::frames::{allowed, failure, part_response, query, read_part, requested_range};
use std::path::{Path, PathBuf};

/// The most asked for at once that's given whole: more than any book's index (a 50-hour one's is about 35 MB).
const WHOLE_UP_TO: u64 = 64 << 20;

/// `?path=<file>` is the file, with ranges, for a media element. Only files the asset scope allows.
pub fn respond<R: tauri::Runtime>(app: &tauri::AppHandle<R>, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::StatusCode;
    let Some(path) = query(&request.uri().to_string(), "path") else {
        return failure(StatusCode::BAD_REQUEST, "path is needed".into());
    };
    let path = PathBuf::from(path);
    if !allowed(app, &path) {
        return failure(StatusCode::FORBIDDEN, "not in a library".into());
    }
    match read_part(&path, 0, requested_range(&request), WHOLE_UP_TO) {
        Ok(part) => part_response(&request, part, content_type(&path)),
        Err(e) => failure(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// What an audio file is, by its extension: the formats a library's scan finds (core/scan/walk.ts).
fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "m4b" | "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn an_audiobook_is_audio_whatever_its_case() {
        assert_eq!(content_type(Path::new("/books/The High Kâhl's Oath.m4b")), "audio/mp4");
        assert_eq!(content_type(Path::new("/books/Soul Hunter.M4B")), "audio/mp4");
        assert_eq!(content_type(Path::new("/books/Era of Ruin.mp3")), "audio/mpeg");
        assert_eq!(content_type(Path::new("/books/clip.opus")), "audio/ogg");
        assert_eq!(content_type(Path::new("/books/notes")), "application/octet-stream");
    }

    /// A file of `len` bytes, each its position modulo 251, so any slice says where it came from.
    fn file_of(name: &str, len: usize) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ribbon-audio-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("The High Kâhl's Oath.m4b");
        let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::File::create(&path).unwrap().write_all(&bytes).unwrap();
        path
    }

    #[test]
    fn an_index_asked_for_is_given_whole_and_the_rest_of_the_book_in_parts() {
        let path = file_of("ranges", 100 << 20);
        let len: u64 = 100 << 20;
        // The index at the end, 9 MB, asked for to the end of the file: all of it, at once.
        let index = read_part(&path, 0, Some((len - (9 << 20), None)), WHOLE_UP_TO).unwrap();
        assert_eq!((index.from, index.to, index.body.len() as u64), (len - (9 << 20), len - 1, 9 << 20));
        assert_eq!(index.body[0], ((len - (9 << 20)) % 251) as u8);
        // The same asked for as a range with an end.
        let bounded = read_part(&path, 0, Some((1_000_000, Some(1_000_000 + (9 << 20) - 1))), WHOLE_UP_TO).unwrap();
        assert_eq!(bounded.body.len() as u64, 9 << 20);
        // The whole book from the start: half a megabyte first, so sound starts soon, and the player comes back.
        let start = read_part(&path, 0, Some((0, None)), WHOLE_UP_TO).unwrap();
        assert_eq!((start.from, start.to, start.total), (0, (512 << 10) - 1, len));
        // From the middle on, more than is given whole: four megabytes.
        let middle = read_part(&path, 0, Some((10 << 20, None)), WHOLE_UP_TO).unwrap();
        assert_eq!(middle.body.len() as u64, 4 << 20);
    }

    #[test]
    fn an_mp3_is_given_in_parts_as_before() {
        let path = file_of("mp3", 10 << 20);
        let tail = read_part(&path, 0, Some(((10 << 20) - (5 << 20), None)), 0).unwrap();
        assert_eq!(tail.body.len() as u64, 4 << 20);
    }

    #[test]
    fn an_empty_file_or_a_backwards_range_is_refused_rather_than_served() {
        let empty = file_of("empty", 0);
        assert!(read_part(&empty, 0, None, WHOLE_UP_TO).is_err());
        let path = file_of("backwards", 1000);
        assert!(read_part(&path, 0, Some((500, Some(100))), WHOLE_UP_TO).is_err());
    }
}
