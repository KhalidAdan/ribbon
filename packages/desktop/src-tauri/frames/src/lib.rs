//! Exact places in an MP3 (#75). An MP3 frame is a fixed number of samples
//! whatever its bitrate, so a moment is a frame number, and the frame's byte
//! is found by walking the frame headers from the start. A player's own seek
//! in an MP3 with no seek table goes by the average bitrate instead: on one
//! 10-hour VBR file the webview landed from 2 minutes behind to 2 minutes
//! ahead of where it said, and Apple's player on the TV as far. So Ribbon
//! serves a player an MP3 from the exact frame, and the player starts it at
//! its own 0: the app through its `ribbonmp3` protocol, the server for the TV.
//!
//! Its own crate, with nothing of the app in it, so the server can find the
//! frame exactly as the app does (the `ribbon-frames` command).

use std::io::Read;
use std::path::Path;

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

    /// As kept on disk: a tag, the sample rate and frame samples, the first frame's byte, then every frame's length.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(24 + self.sizes.len() * 2);
        out.extend_from_slice(b"RBFI0002");
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&self.samples_per_frame.to_le_bytes());
        out.extend_from_slice(&self.marks[0].to_le_bytes());
        for s in &self.sizes {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    /// Read back from disk.
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() < 26 || &b[..8] != b"RBFI0002" {
            return None;
        }
        let sample_rate = u32::from_le_bytes(b[8..12].try_into().ok()?);
        let samples_per_frame = u32::from_le_bytes(b[12..16].try_into().ok()?);
        let first = u64::from_le_bytes(b[16..24].try_into().ok()?);
        let sizes: Vec<u16> = b[24..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
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

/// A file's frame index, kept at `kept`: read from there when it was kept
/// before, else made by reading the file whole and kept there for next time.
pub fn index_kept_at(mp3: &Path, kept: &Path) -> std::io::Result<FrameIndex> {
    if let Some(i) = std::fs::read(kept).ok().and_then(|b| FrameIndex::from_bytes(&b)) {
        return Ok(i);
    }
    let i = FrameIndex::build(std::io::BufReader::with_capacity(4 << 20, std::fs::File::open(mp3)?))?;
    if let Some(dir) = kept.parent() {
        let _ = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(kept, i.to_bytes()));
    }
    Ok(i)
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
        let back = FrameIndex::from_bytes(&idx.to_bytes()).unwrap();
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
