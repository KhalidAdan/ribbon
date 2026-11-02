//! Exact places in an MP3 for the app's player (#75): the frame index
//! (the `ribbon-frames` crate, beside this one), kept in the Ribbon folder,
//! and the `ribbonmp3` protocol that serves an MP3 from the exact frame.

use ribbon_frames::FrameIndex;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Indexes built this session, by path, size and modified time.
static INDEXES: Mutex<Option<HashMap<(PathBuf, u64, u64), Arc<FrameIndex>>>> = Mutex::new(None);
/// One build at a time: a media element asks for several ranges at once, and each would read the whole file.
static BUILDING: Mutex<()> = Mutex::new(());

/// Where an index is kept between sessions, by the file's path, size and modified time.
fn kept_at(key: &(PathBuf, u64, u64)) -> PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("{}|{}|{}", key.0.to_string_lossy().to_lowercase(), key.1, key.2).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    crate::home::mirror_base().join("frames").join(format!("{h:016x}.bin"))
}

/// The frame index of a file, built once a session (a 10-hour MP3 is read whole: about 1 s from a
/// local disk, longer from a share).
pub fn index_of(path: &Path) -> std::io::Result<Arc<FrameIndex>> {
    let meta = std::fs::metadata(path)?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let key = (path.to_path_buf(), meta.len(), mtime);
    let cached = || INDEXES.lock().ok().and_then(|m| m.as_ref().and_then(|m| m.get(&key).cloned()));
    if let Some(i) = cached() {
        return Ok(i);
    }
    let _one = BUILDING.lock();
    if let Some(i) = cached() {
        return Ok(i);
    }
    let started = std::time::Instant::now();
    // Kept from an earlier session, else made now and kept for the next.
    let idx = Arc::new(ribbon_frames::index_kept_at(path, &kept_at(&key))?);
    log::info!("{} MP3 frames of {} ready in {:?}", idx.frames(), path.display(), started.elapsed());
    if let Ok(mut m) = INDEXES.lock() {
        m.get_or_insert_with(HashMap::new).insert(key, idx.clone());
    }
    Ok(idx)
}

/// Index MP3s ahead of their first seek, in the background: a book was opened.
#[tauri::command]
pub async fn audio_prepare(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for p in paths.iter().filter(|p| p.to_lowercase().ends_with(".mp3")) {
            if let Err(e) = index_of(Path::new(p)) {
                log::warn!("could not index {p}: {e}");
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Bytes `from..=to` of the MP3 at `path` as if it began at the frame where `ms` falls.
fn serve(path: &Path, ms: f64, range: Option<(u64, Option<u64>)>) -> Result<(Vec<u8>, u64, u64, u64), String> {
    let idx = index_of(path).map_err(|e| e.to_string())?;
    let (start, _) = idx.at(ms);
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let total = len - start;
    let (from, to) = match range {
        Some((a, b)) => (a.min(total.saturating_sub(1)), b.unwrap_or(u64::MAX).min(total - 1)),
        None => (0, total - 1),
    };
    // A media element asks for the rest of the file; it gets it a few megabytes at a time. The first answer is
    // small (half a megabyte is 25 s of a 168 kbps book): over a share, sound starts as soon as it arrives.
    let most: u64 = if from == 0 { 512 << 10 } else { 4 << 20 };
    let to = to.min(from + most - 1);
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start + from)).map_err(|e| e.to_string())?;
    let mut body = vec![0u8; (to - from + 1) as usize];
    f.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok((body, from, to, total))
}

fn query(uri: &str, key: &str) -> Option<String> {
    let q = uri.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len() + 1 && i + 3 <= b.len()).then(|| u8::from_str_radix(&s[i + 1..i + 3], 16).ok()).flatten();
        match hex {
            Some(v) => {
                out.push(v);
                i += 3;
            }
            None => {
                out.push(if b[i] == b'+' { b' ' } else { b[i] });
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The `ribbonmp3` protocol: `?path=<file>&ms=<moment>` is the file from the frame where the
/// moment falls, with ranges, for a media element. Only files the asset scope allows.
pub fn respond<R: tauri::Runtime>(app: &tauri::AppHandle<R>, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    use tauri::Manager;
    let uri = request.uri().to_string();
    let fail = |status: StatusCode, why: String| Response::builder().status(status).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(why.into_bytes()).unwrap();
    let (Some(path), Some(ms)) = (query(&uri, "path"), query(&uri, "ms").and_then(|m| m.parse::<f64>().ok())) else {
        return fail(StatusCode::BAD_REQUEST, "path and ms are needed".into());
    };
    let path = PathBuf::from(path);
    if !app.asset_protocol_scope().is_allowed(&path) {
        return fail(StatusCode::FORBIDDEN, "not in a library".into());
    }
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| {
        let (a, b) = v.strip_prefix("bytes=")?.split_once('-')?;
        Some((a.trim().parse::<u64>().ok()?, b.trim().parse::<u64>().ok()))
    });
    match serve(&path, ms, range) {
        Ok((body, from, to, total)) => {
            let head = request.method() == tauri::http::Method::HEAD;
            Response::builder()
                .status(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
                .header(header::CONTENT_TYPE, "audio/mpeg")
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CONTENT_RANGE, format!("bytes {from}-{to}/{total}"))
                .header(header::CONTENT_LENGTH, body.len().to_string())
                .body(if head { Vec::new() } else { body })
                .unwrap()
        }
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}
