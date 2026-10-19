//! Exact places in an MP3 (#76). An MP3 frame is a fixed number of samples
//! whatever its bitrate, so a moment is a frame number, and the frame's byte
//! is found by walking the frame headers from the start. The webview's own
//! seek in an MP3 with no seek table goes by the average bitrate instead: on
//! one 10-hour VBR file it landed from 2 minutes behind to 2 minutes ahead of
//! where it said. So Ribbon serves the player an MP3 from the exact frame,
//! through the `ribbonmp3` protocol, and the player starts it at its own 0.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Where every frame of an MP3 starts: each frame's length, and every 1,024th frame's byte.
pub struct FrameIndex {
    pub sample_rate: u32,
    pub samples_per_frame: u32,
    /// Each frame's length in bytes, in order (frames are at most 2,881 bytes).
    sizes: Vec<u16>,
    /// The byte where frame `i * 1024` starts.
    marks: Vec<u64>,
}

const MARK: usize = 1024;

/// What a frame header says: its length and samples, or None when it is not one.
fn header(b: &[u8]) -> Option<(usize, u32, u32)> {
    if b.len() < 4 || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
        return None;
    }
    let version = (b[1] >> 3) & 3; // 0: 2.5, 2: 2, 3: 1
    let layer = (b[1] >> 1) & 3; // 1: III, 2: II, 3: I
    let rate_i = (b[2] >> 4) as usize;
    let sr_i = ((b[2] >> 2) & 3) as usize;
    let pad = ((b[2] >> 1) & 1) as usize;
    if version == 1 || layer == 0 || rate_i == 0 || rate_i == 15 || sr_i == 3 {
        return None;
    }
    const V1: [[u32; 15]; 3] = [
        [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    ];
    const V2: [[u32; 15]; 2] = [[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
    let v1 = version == 3;
    let kbps = if v1 { V1[(3 - layer) as usize][rate_i] } else { V2[if layer == 3 { 0 } else { 1 }][rate_i] };
    let sr = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]][version as usize][sr_i];
    let bps = kbps as usize * 1000;
    let (len, samples) = match layer {
        3 => ((12 * bps / sr as usize + pad) * 4, 384),
        2 => (144 * bps / sr as usize + pad, 1152),
        _ => {
            if v1 {
                (144 * bps / sr as usize + pad, 1152)
            } else {
                (72 * bps / sr as usize + pad, 576)
            }
        }
    };
    (len >= 24).then_some((len, sr, samples))
}

impl FrameIndex {
    /// Walk an MP3's frames, streaming: past its ID3v2 tag, frame by frame, finding the next frame
    /// again wherever the stream breaks (a frame found that way counts only when another follows it).
    pub fn build<R: Read>(mut r: R) -> std::io::Result<Self> {
        let mut buf: Vec<u8> = Vec::with_capacity(8 << 20);
        let mut base = 0u64; // the file byte at buf[0]
        let mut at = 0usize; // in buf
        let mut eof = false;
        let mut skip_to: u64 = 0;
        let mut idx = FrameIndex { sample_rate: 0, samples_per_frame: 0, sizes: Vec::new(), marks: Vec::new() };
        let mut synced = false;
        let mut first = true;
        let mut tagged = false;
        loop {
            // Keep at least two headers' worth ahead of the walk.
            if !eof && buf.len() - at < 8192 {
                buf.drain(..at);
                base += at as u64;
                at = 0;
                let mut chunk = vec![0u8; 4 << 20];
                let n = r.read(&mut chunk)?;
                if n == 0 {
                    eof = true;
                } else {
                    buf.extend_from_slice(&chunk[..n]);
                    continue;
                }
            }
            if !tagged {
                tagged = true;
                if buf.len() >= 10 && &buf[..3] == b"ID3" {
                    let size = buf[6..10].iter().fold(0u64, |n, b| (n << 7) | (*b as u64 & 0x7F));
                    skip_to = 10 + size + if buf[5] & 0x10 != 0 { 10 } else { 0 };
                }
            }
            if base + (at as u64) < skip_to {
                let jump = ((skip_to - base) as usize).min(buf.len()) - at;
                at += jump;
                if at >= buf.len() && eof {
                    break;
                }
                continue;
            }
            if at + 4 > buf.len() {
                break;
            }
            let here = &buf[at..];
            let found = header(here).filter(|(len, sr, _)| synced || here.len() == *len || header(&here[(*len).min(here.len())..]).is_some_and(|(_, s2, _)| s2 == *sr));
            match found {
                Some((len, sr, spf)) => {
                    // An encoder's info frame (Xing, Info, VBRI) holds no sound.
                    let tag = &here[4..len.min(here.len()).min(60)];
                    let info = first && [b"Xing", b"Info", b"VBRI"].iter().any(|t| tag.windows(4).any(|w| w == *t));
                    first = false;
                    if !info {
                        if idx.sizes.len() % MARK == 0 {
                            idx.marks.push(base + at as u64);
                        }
                        idx.sizes.push(len as u16);
                        idx.sample_rate = sr;
                        idx.samples_per_frame = spf;
                    }
                    synced = true;
                    at += len;
                }
                None => {
                    synced = false;
                    at += 1;
                }
            }
        }
        if idx.sizes.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "no MP3 frames"));
        }
        Ok(idx)
    }

    pub fn frame_ms(&self) -> f64 {
        self.samples_per_frame as f64 * 1000.0 / self.sample_rate as f64
    }

    /// The frame where a moment falls, its byte, and the ms it starts at.
    pub fn at(&self, ms: f64) -> (u64, f64) {
        let n = ((ms.max(0.0) / self.frame_ms()).floor() as usize).min(self.sizes.len() - 1);
        let mark = n / MARK;
        let byte = self.marks[mark] + self.sizes[mark * MARK..n].iter().map(|s| *s as u64).sum::<u64>();
        (byte, n as f64 * self.frame_ms())
    }

    pub fn frames(&self) -> usize {
        self.sizes.len()
    }

    /// As kept on disk: a tag, the sample rate and frame samples, then every frame's length.
    fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + self.sizes.len() * 2);
        out.extend_from_slice(b"RBFI0001");
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&self.samples_per_frame.to_le_bytes());
        for s in &self.sizes {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    /// Read back from disk, given where the first frame starts.
    fn from_bytes(b: &[u8], first: u64) -> Option<Self> {
        if b.len() < 18 || &b[..8] != b"RBFI0001" {
            return None;
        }
        let sample_rate = u32::from_le_bytes(b[8..12].try_into().ok()?);
        let samples_per_frame = u32::from_le_bytes(b[12..16].try_into().ok()?);
        let sizes: Vec<u16> = b[16..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let mut marks = Vec::with_capacity(sizes.len() / MARK + 1);
        let mut at = first;
        for (i, s) in sizes.iter().enumerate() {
            if i % MARK == 0 {
                marks.push(at);
            }
            at += *s as u64;
        }
        (sample_rate > 0 && !sizes.is_empty()).then_some(FrameIndex { sample_rate, samples_per_frame, sizes, marks })
    }
}

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
    let kept = kept_at(&key);
    // Kept from an earlier session: only where the first frame starts is read from the file.
    let from_disk = std::fs::read(&kept).ok().and_then(|b| {
        let mut head = vec![0u8; 64 * 1024];
        let n = std::fs::File::open(path).ok()?.read(&mut head).ok()?;
        let first = FrameIndex::build(std::io::Cursor::new(&head[..n])).ok().map(|i| i.marks[0])?;
        FrameIndex::from_bytes(&b, first)
    });
    let idx = match from_disk {
        Some(i) => Arc::new(i),
        None => {
            let i = Arc::new(FrameIndex::build(std::io::BufReader::with_capacity(4 << 20, std::fs::File::open(path)?))?);
            log::info!("indexed {} MP3 frames of {} in {:?}", i.frames(), path.display(), started.elapsed());
            if let Some(dir) = kept.parent() {
                let _ = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&kept, i.to_bytes()));
            }
            i
        }
    };
    if let Ok(mut m) = INDEXES.lock() {
        m.get_or_insert_with(HashMap::new).insert(key, idx.clone());
    }
    Ok(idx)
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
    // A media element asks for the rest of the file; it gets it a few megabytes at a time.
    let to = to.min(from + (4 << 20) - 1);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn finds_each_moment_at_its_frame() {
        let dir = std::env::temp_dir().join(format!("ribbon-frames-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mp3 = dir.join("vbr.mp3");
        // VBR, with an ID3 tag and no seek table: the kind whose seeks go by bitrate.
        let made = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=20", "-f", "lavfi", "-i", "anoisesrc=d=20:a=0.3", "-filter_complex", "[0][1]amix=inputs=2,volume=2", "-ar", "44100", "-c:a", "libmp3lame", "-q:a", "4", "-write_xing", "0", "-metadata", "title=t"])
            .arg(&mp3)
            .status()
            .unwrap();
        assert!(made.success());
        let idx = FrameIndex::build(std::fs::File::open(&mp3).unwrap()).unwrap();
        // Kept on disk and read back, it is the same index.
        let back = FrameIndex::from_bytes(&idx.to_bytes(), idx.marks[0]).unwrap();
        assert_eq!((back.sizes.len(), back.marks.clone(), back.sample_rate), (idx.sizes.len(), idx.marks.clone(), idx.sample_rate));
        assert_eq!(idx.sample_rate, 44100);
        // 20 s of 1,152-sample frames, give or take the encoder's padding.
        assert!((763..=768).contains(&idx.frames()), "{} frames", idx.frames());
        // The file from 12.5 s, decoded, is the original from 12.5 s.
        let (byte, at) = idx.at(12_500.0);
        assert!((12_500.0 - at).abs() < idx.frame_ms());
        let all = std::fs::read(&mp3).unwrap();
        let cut = dir.join("cut.mp3");
        std::fs::write(&cut, &all[byte as usize..]).unwrap();
        let pcm = |args: &[&str]| -> Vec<i16> {
            let o = Command::new("ffmpeg").args(["-v", "error"]).args(args).args(["-ac", "1", "-f", "s16le", "-"]).output().unwrap();
            o.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
        };
        let whole = pcm(&["-i", mp3.to_str().unwrap()]);
        let part = pcm(&["-i", cut.to_str().unwrap()]);
        // Where the cut's sound (past its first frames, which lack the bit reservoir) sits in the whole.
        let probe = &part[4410..4410 + 4410];
        let expect = (at / 1000.0 * 44100.0) as usize + 4410;
        let score = |off: usize| -> f64 { probe.iter().zip(&whole[off..]).map(|(a, b)| (*a as f64) * (*b as f64)).sum() };
        let best = (expect - 2000..expect + 2000).max_by(|a, b| score(*a).partial_cmp(&score(*b)).unwrap()).unwrap();
        // Within a few samples of where the index says (the decoder's own delay aside).
        assert!((best as i64 - expect as i64).abs() < 1200, "found at {best}, expected {expect}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_headers() {
        // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes, 1,152 samples.
        assert_eq!(header(&[0xFF, 0xFB, 0x90, 0x00]), Some((417, 44100, 1152)));
        assert_eq!(header(&[0xFF, 0xFB, 0xF0, 0x00]), None);
        assert_eq!(header(b"ID3\x03"), None);
    }
}
