//! Read-as-little-as-possible tag readers for the containers that make up
//! nearly every audiobook: MP3 (ID3v2 plus the first MPEG frame header),
//! MP4 (m4a, m4b) and WMA (ASF). Each reader touches a few kilobytes of
//! a file and seeks past picture payloads instead of reading them. On a
//! network share, bytes and round trips are the whole cost of a scan:
//! the generic readers pull the entire tag (100 KB to 700 KB of cover
//! art per MP3, a 200 KB `moov` per M4A) and turn a library into a
//! download. Anything these readers cannot make sense of falls back to
//! lofty, and after that to ffprobe.

use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::FileExt;
#[cfg(windows)]
use std::os::windows::fs::FileExt;

/// Smallest read issued to the file. Text tags cluster, so one read at a
/// tag's start usually covers everything but the picture.
pub const DEFAULT_MIN_READ: usize = 8 * 1024;
/// Text payloads larger than this are not worth reading during a scan.
const MAX_TEXT: u64 = 8 * 1024;

/// Where an embedded picture lives, so it can be copied out later with
/// one read instead of being carried through every scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PictureRef {
    pub offset: u64,
    pub len: u64,
    pub ext: &'static str,
}

#[derive(Default, Debug)]
pub struct Probed {
    pub duration_ms: u64,
    /// Lower-cased keys. First value wins when a key repeats.
    pub tags: HashMap<String, String>,
    pub has_cover: bool,
    pub picture: Option<PictureRef>,
}

/// A file read through explicit `(offset, length)` requests. Every fetch
/// is at least `min_read` bytes and is kept, so a parser that asks for a
/// 10-byte header and then the 30 bytes after it costs one round trip.
/// Seeking past a region costs nothing because nothing is fetched until
/// asked for.
pub struct LazyFile {
    file: File,
    pub len: u64,
    pub min_read: usize,
    chunks: Vec<(u64, Vec<u8>)>,
    /// Bytes actually fetched from the file.
    pub fetched: u64,
    /// Read calls actually issued.
    pub trips: u32,
}

impl LazyFile {
    /// `len` from the directory listing saves a metadata round trip.
    pub fn open(path: &Path, len: Option<u64>, min_read: usize) -> io::Result<Self> {
        let file = File::open(path)?;
        let len = match len {
            Some(l) => l,
            None => file.metadata()?.len(),
        };
        Ok(Self { file, len, min_read: min_read.max(64), chunks: Vec::new(), fetched: 0, trips: 0 })
    }

    fn fill_at(&mut self, off: u64, buf: &mut [u8]) -> io::Result<usize> {
        let mut filled = 0;
        while filled < buf.len() {
            #[cfg(windows)]
            let n = self.file.seek_read(&mut buf[filled..], off + filled as u64)?;
            #[cfg(unix)]
            let n = self.file.read_at(&mut buf[filled..], off + filled as u64)?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        Ok(filled)
    }

    /// Bytes `[off, off + n)`, shorter at end of file.
    pub fn read(&mut self, off: u64, n: usize) -> io::Result<Vec<u8>> {
        self.read_min(off, n, self.min_read)
    }

    /// Like `read`, fetching at least `min` bytes when a fetch is needed.
    /// For probes of a few bytes into a region nothing else will need.
    pub fn read_min(&mut self, off: u64, n: usize, min: usize) -> io::Result<Vec<u8>> {
        if off >= self.len || n == 0 {
            return Ok(Vec::new());
        }
        let n = n.min((self.len - off) as usize);
        for (start, data) in &self.chunks {
            if *start <= off && off + n as u64 <= *start + data.len() as u64 {
                let s = (off - *start) as usize;
                return Ok(data[s..s + n].to_vec());
            }
        }
        let want = n.max(min).min((self.len - off) as usize);
        let mut buf = vec![0u8; want];
        let got = self.fill_at(off, &mut buf)?;
        buf.truncate(got);
        self.fetched += got as u64;
        self.trips += 1;
        let out = buf[..n.min(got)].to_vec();
        self.chunks.push((off, buf));
        Ok(out)
    }

    /// Exactly `n` bytes or an error.
    fn exact(&mut self, off: u64, n: usize) -> Option<Vec<u8>> {
        let b = self.read(off, n).ok()?;
        (b.len() == n).then_some(b)
    }
}

// Byte helpers -------------------------------------------------------------

fn be16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}
fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}
fn be64(b: &[u8]) -> u64 {
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}
fn le16(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}
fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}
fn le64(b: &[u8]) -> u64 {
    u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}
fn synchsafe(b: &[u8]) -> u32 {
    ((b[0] as u32 & 0x7f) << 21) | ((b[1] as u32 & 0x7f) << 14) | ((b[2] as u32 & 0x7f) << 7) | (b[3] as u32 & 0x7f)
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

fn utf16(b: &[u8], little: bool) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| if little { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
    String::from_utf16_lossy(&units)
}

fn clean(s: String) -> String {
    let t = s.trim_matches(|c: char| c == '\0' || c.is_whitespace() || c == '\u{feff}');
    // Multiple values in one frame become one line.
    t.replace('\0', " / ")
}

/// Lower-case the key; keep the first non-empty value.
pub fn put(tags: &mut HashMap<String, String>, key: &str, value: &str) {
    let v = value.trim();
    if v.is_empty() || key.is_empty() {
        return;
    }
    tags.entry(key.to_ascii_lowercase()).or_insert_with(|| v.to_string());
}

/// Does the first 4 bytes of `b` look like an atom or frame identifier?
fn is_fourcc(b: &[u8]) -> bool {
    b.len() >= 4 && b[..4].iter().all(|&c| c == 0xA9 || (0x20..0x7f).contains(&c))
}

// ID3v2 / MPEG ---------------------------------------------------------------

fn id3_key(id: &str) -> Option<&'static str> {
    Some(match id {
        "TIT2" | "TT2" => "title",
        "TPE1" | "TP1" => "artist",
        "TALB" | "TAL" => "album",
        "TPE2" | "TP2" => "album_artist",
        "TCOM" | "TCM" => "composer",
        "TRCK" | "TRK" => "track",
        "TPOS" | "TPA" => "disc",
        "TDRC" | "TYER" | "TDOR" | "TORY" | "TYE" | "TOR" => "date",
        "TCON" | "TCO" => "genre",
        "TIT1" | "TT1" => "grouping",
        "TIT3" | "TT3" => "subtitle",
        "TPUB" | "TPB" => "publisher",
        _ => return None,
    })
}

fn decode(enc: u8, b: &[u8]) -> String {
    clean(match enc {
        0 => latin1(b),
        1 => {
            if b.len() >= 2 && b[0] == 0xFF && b[1] == 0xFE {
                utf16(&b[2..], true)
            } else if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
                utf16(&b[2..], false)
            } else {
                utf16(b, true)
            }
        }
        2 => utf16(b, false),
        _ => String::from_utf8_lossy(b).into_owned(),
    })
}

/// Split at the encoding's string terminator: `(before, after)`.
fn split_terminated(enc: u8, b: &[u8]) -> (&[u8], &[u8]) {
    if enc == 1 || enc == 2 {
        let mut i = 0;
        while i + 1 < b.len() {
            if b[i] == 0 && b[i + 1] == 0 {
                return (&b[..i], &b[i + 2..]);
            }
            i += 2;
        }
        (b, &[])
    } else {
        match b.iter().position(|&c| c == 0) {
            Some(i) => (&b[..i], &b[i + 1..]),
            None => (b, &[]),
        }
    }
}

/// Reverse ID3v2.4 per-frame unsynchronisation: drop the 0x00 after 0xFF.
fn resync(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        out.push(b[i]);
        if b[i] == 0xFF && i + 1 < b.len() && b[i + 1] == 0 {
            i += 1;
        }
        i += 1;
    }
    out
}

/// Offset of the image bytes inside an APIC/PIC frame body, and their type.
fn picture_data_start(b: &[u8], ver: u8) -> Option<(usize, &'static str)> {
    if b.len() < 4 {
        return None;
    }
    let enc = b[0];
    let (ext, rest_at) = if ver == 2 {
        let fmt = latin1(&b[1..4]).to_ascii_lowercase();
        (if fmt.contains("png") { "png" } else { "jpg" }, 4)
    } else {
        let (mime, _) = split_terminated(0, &b[1..]);
        let m = latin1(mime).to_ascii_lowercase();
        (if m.contains("png") { "png" } else { "jpg" }, 1 + mime.len() + 1)
    };
    // Picture type byte, then a description in the frame's encoding.
    let desc_at = rest_at + 1;
    if desc_at > b.len() {
        return None;
    }
    let (desc, _) = split_terminated(enc, &b[desc_at..]);
    let term = if enc == 1 || enc == 2 { 2 } else { 1 };
    let data_at = desc_at + desc.len() + term;
    if desc_at + desc.len() >= b.len() {
        // Terminator not found within what was read.
        return None;
    }
    Some((data_at, ext))
}

fn read_id3_frames(f: &mut LazyFile, ver: u8, tag_flags: u8, start: u64, end: u64, out: &mut Probed) -> Option<()> {
    let mut pos = start;
    if tag_flags & 0x40 != 0 {
        let b = f.exact(pos, 4)?;
        pos += if ver == 4 { synchsafe(&b) as u64 } else { be32(&b) as u64 + 4 };
    }
    let hdr_len: u64 = if ver == 2 { 6 } else { 10 };
    let mut count = 0;
    while pos + hdr_len <= end {
        let h = f.exact(pos, hdr_len as usize)?;
        if h[0] == 0 {
            break; // padding
        }
        let (id, size, flags) = if ver == 2 {
            (latin1(&h[..3]), ((h[3] as u64) << 16) | ((h[4] as u64) << 8) | h[5] as u64, 0u16)
        } else {
            let size = if ver == 4 { synchsafe(&h[4..8]) as u64 } else { be32(&h[4..8]) as u64 };
            (latin1(&h[..4]), size, be16(&h[8..10]))
        };
        if !id.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
            break;
        }
        let body = pos + hdr_len;
        let next = body + size;
        if next > end || size == 0 {
            if size == 0 {
                pos = next;
                continue;
            }
            break;
        }
        count += 1;
        if count > 1000 {
            break;
        }
        let unreadable = match ver {
            4 => flags & 0x000C != 0,
            3 => flags & 0x00C0 != 0,
            _ => false,
        };
        if id == "APIC" || id == "PIC" {
            out.has_cover = true;
            if out.picture.is_none() && !unreadable {
                let b = f.read(body, size.min(256) as usize).ok()?;
                if let Some((data_at, ext)) = picture_data_start(&b, ver) {
                    if (data_at as u64) < size {
                        out.picture = Some(PictureRef { offset: body + data_at as u64, len: size - data_at as u64, ext });
                    }
                }
            }
        } else if size <= MAX_TEXT && !unreadable && (id.starts_with('T') || id == "COMM" || id == "COM") {
            let raw = f.exact(body, size as usize)?;
            let mut b: &[u8] = &raw;
            let owned;
            if ver == 4 {
                if flags & 0x0040 != 0 && !b.is_empty() {
                    b = &b[1..];
                }
                if flags & 0x0001 != 0 && b.len() >= 4 {
                    b = &b[4..];
                }
                if flags & 0x0002 != 0 {
                    owned = resync(b);
                    b = &owned;
                }
            } else if ver == 3 && flags & 0x0020 != 0 && !b.is_empty() {
                b = &b[1..];
            }
            if !b.is_empty() {
                let enc = b[0];
                let text = &b[1..];
                match id.as_str() {
                    "TXXX" | "TXX" => {
                        let (desc, value) = split_terminated(enc, text);
                        put(&mut out.tags, &decode(enc, desc), &decode(enc, value));
                    }
                    "COMM" | "COM" => {}
                    _ => {
                        if let Some(k) = id3_key(&id) {
                            put(&mut out.tags, k, &decode(enc, text));
                        }
                    }
                }
            }
        }
        pos = next;
    }
    Some(())
}

#[derive(Debug, Clone, Copy)]
struct MpegHeader {
    version: u8, // 1, 2, or 25 for MPEG 2.5
    layer: u8,
    bitrate_bps: u32,
    sample_rate: u32,
    mono: bool,
    padding: bool,
}

const BITRATES_V1: [[u32; 15]; 3] = [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
];
const BITRATES_V2: [[u32; 15]; 3] = [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];

impl MpegHeader {
    fn parse(b: &[u8]) -> Option<Self> {
        if b.len() < 4 || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
            return None;
        }
        let version = match (b[1] >> 3) & 3 {
            0 => 25,
            2 => 2,
            3 => 1,
            _ => return None,
        };
        let layer = match (b[1] >> 1) & 3 {
            1 => 3,
            2 => 2,
            3 => 1,
            _ => return None,
        };
        let br = (b[2] >> 4) as usize;
        if br == 0 || br == 15 {
            return None;
        }
        let sr = ((b[2] >> 2) & 3) as usize;
        if sr == 3 {
            return None;
        }
        let table = if version == 1 { &BITRATES_V1 } else { &BITRATES_V2 };
        let bitrate_bps = table[layer as usize - 1][br] * 1000;
        let sample_rate = match version {
            1 => [44100, 48000, 32000][sr],
            2 => [22050, 24000, 16000][sr],
            _ => [11025, 12000, 8000][sr],
        };
        Some(Self { version, layer, bitrate_bps, sample_rate, mono: (b[3] >> 6) & 3 == 3, padding: (b[2] >> 1) & 1 == 1 })
    }

    fn samples_per_frame(&self) -> u32 {
        match self.layer {
            1 => 384,
            2 => 1152,
            _ => {
                if self.version == 1 {
                    1152
                } else {
                    576
                }
            }
        }
    }

    fn frame_len(&self) -> u32 {
        let pad = self.padding as u32;
        match self.layer {
            1 => (12 * self.bitrate_bps / self.sample_rate + pad) * 4,
            _ => self.samples_per_frame() / 8 * self.bitrate_bps / self.sample_rate + pad,
        }
    }

    fn side_info_len(&self) -> u32 {
        if self.layer != 3 {
            return 0;
        }
        match (self.version, self.mono) {
            (1, true) => 17,
            (1, false) => 32,
            (_, true) => 9,
            (_, false) => 17,
        }
    }

    fn same_stream(&self, other: &MpegHeader) -> bool {
        self.version == other.version && self.layer == other.layer && self.sample_rate == other.sample_rate
    }
}

/// The first plausible frame header in `buf`, confirmed by the frame
/// after it when that frame is also within `buf`.
fn find_frame(buf: &[u8]) -> Option<(MpegHeader, usize)> {
    let mut i = 0;
    while i + 4 <= buf.len() {
        if let Some(h) = MpegHeader::parse(&buf[i..i + 4]) {
            let next = i + h.frame_len() as usize;
            let confirmed = match buf.get(next..next + 4) {
                Some(n) => MpegHeader::parse(n).map(|h2| h2.same_stream(&h)).unwrap_or(false),
                None => true,
            };
            if confirmed {
                return Some((h, i));
            }
        }
        i += 1;
    }
    None
}

/// MP3: ID3v2 tags at the head, then the first frame for the duration.
/// Never reads the tail: ID3v1 duplicates what ID3v2 says, and 128 bytes
/// of error in a bitrate estimate is nothing.
pub fn read_mp3(f: &mut LazyFile) -> Option<Probed> {
    let mut out = Probed::default();
    let mut pos: u64 = 0;
    let mut tags_seen = 0;
    loop {
        let head = f.read(pos, 10).ok()?;
        if head.len() == 10 && &head[..3] == b"ID3" {
            let ver = head[3];
            let flags = head[5];
            if !(2..=4).contains(&ver) {
                return None;
            }
            let size = synchsafe(&head[6..10]) as u64;
            let total = if ver == 4 && flags & 0x10 != 0 { size + 20 } else { size + 10 };
            // Whole-tag unsynchronisation (2.2/2.3) needs the whole tag; leave it to lofty.
            if ver != 4 && flags & 0x80 != 0 {
                return None;
            }
            if tags_seen == 0 {
                read_id3_frames(f, ver, flags, pos + 10, pos + 10 + size, &mut out)?;
            }
            tags_seen += 1;
            pos += total;
            if tags_seen > 3 {
                return None;
            }
            continue;
        }
        break;
    }
    // First frame header. Ask for a little first: the tag's last text
    // frames usually sit in the same fetch, so this costs nothing. Some
    // encoders leave a long run of zero padding after the tag; skip it in
    // large strides, the way ffmpeg and lofty do.
    let mut buf = f.read(pos, 1024).ok()?;
    if buf.iter().all(|&b| b == 0) {
        let mut at = pos + buf.len() as u64;
        loop {
            if at - pos > 8 * 1024 * 1024 {
                return None;
            }
            let chunk = f.read_min(at, 65536, 65536).ok()?;
            if chunk.is_empty() {
                return None;
            }
            if let Some(nz) = chunk.iter().position(|&b| b != 0) {
                pos = at + nz as u64;
                buf = f.read(pos, 1024).ok()?;
                break;
            }
            at += chunk.len() as u64;
        }
    }
    let mut found = find_frame(&buf);
    if found.is_none() && buf.len() == 1024 {
        buf = f.read(pos, 8192).ok()?;
        found = find_frame(&buf);
    }
    let (hdr, i) = found?;
    let frame_at = pos + i as u64;
    let xing_at = frame_at + 4 + hdr.side_info_len() as u64;
    let mut frames: Option<u64> = None;
    let x = f.read(xing_at, 12).ok()?;
    if x.len() >= 12 && (&x[..4] == b"Xing" || &x[..4] == b"Info") {
        if be32(&x[4..8]) & 1 != 0 {
            frames = Some(be32(&x[8..12]) as u64);
        }
    } else {
        let v = f.read(frame_at + 36, 18).ok()?;
        if v.len() >= 18 && &v[..4] == b"VBRI" {
            frames = Some(be32(&v[14..18]) as u64);
        }
    }
    out.duration_ms = match frames {
        Some(n) if n > 0 => n * hdr.samples_per_frame() as u64 * 1000 / hdr.sample_rate as u64,
        _ => f.len.saturating_sub(frame_at) * 8 * 1000 / hdr.bitrate_bps as u64,
    };
    Some(out)
}

// MP4 --------------------------------------------------------------------

fn mp4_key(kind: &[u8; 4]) -> Option<&'static str> {
    Some(match kind {
        b"\xa9nam" => "title",
        b"\xa9ART" => "artist",
        b"\xa9alb" => "album",
        b"aART" => "album_artist",
        b"\xa9wrt" => "composer",
        b"\xa9nrt" => "narrator",
        b"\xa9day" => "date",
        b"\xa9gen" => "genre",
        b"\xa9grp" => "grouping",
        b"\xa9mvn" => "mvnm",
        b"\xa9mvi" => "mvin",
        b"tvsh" => "show",
        b"\xa9pub" => "publisher",
        b"trkn" => "track",
        b"disk" => "disc",
        _ => return None,
    })
}

/// `(size, kind, header length)` of the atom at `pos`.
fn atom_header(f: &mut LazyFile, pos: u64) -> Option<(u64, [u8; 4], u64)> {
    atom_header_min(f, pos, f.min_read)
}

/// `atom_header` fetching at least `min` bytes: small for the top-level
/// atoms, whose neighbours are `mdat` and nothing worth reading.
fn atom_header_min(f: &mut LazyFile, pos: u64, min: usize) -> Option<(u64, [u8; 4], u64)> {
    let b = f.read_min(pos, 16, min).ok()?;
    if b.len() < 8 {
        return None;
    }
    let mut size = be32(&b[..4]) as u64;
    let kind = [b[4], b[5], b[6], b[7]];
    let mut hdr = 8;
    if size == 1 {
        if b.len() < 16 {
            return None;
        }
        size = be64(&b[8..16]);
        hdr = 16;
    } else if size == 0 {
        size = f.len - pos;
    }
    if size < hdr {
        return None;
    }
    Some((size, kind, hdr))
}

fn read_mp4_data(f: &mut LazyFile, key: &str, is_cover: bool, start: u64, end: u64, out: &mut Probed) -> Option<()> {
    let mut pos = start;
    while pos + 8 <= end {
        let (size, kind, hdr) = atom_header(f, pos)?;
        if pos + size > end {
            break;
        }
        if &kind == b"data" && size >= hdr + 8 {
            let meta = f.exact(pos + hdr, 8)?;
            let dtype = be32(&meta[..4]) & 0x00FF_FFFF;
            let payload = pos + hdr + 8;
            let plen = size - hdr - 8;
            if is_cover {
                out.has_cover = true;
                if out.picture.is_none() && plen > 0 {
                    out.picture = Some(PictureRef { offset: payload, len: plen, ext: if dtype == 14 { "png" } else { "jpg" } });
                }
            } else if plen <= MAX_TEXT && plen > 0 {
                let p = f.exact(payload, plen as usize)?;
                let value = match dtype {
                    1 => clean(String::from_utf8_lossy(&p).into_owned()),
                    2 => clean(utf16(&p, false)),
                    21 | 22 => match p.len() {
                        1 => (p[0] as i8).to_string(),
                        2 => be16(&p).to_string(),
                        4 => be32(&p).to_string(),
                        8 => be64(&p).to_string(),
                        _ => String::new(),
                    },
                    0 if (key == "track" || key == "disc") && p.len() >= 4 => be16(&p[2..4]).to_string(),
                    _ => String::new(),
                };
                if value != "0" {
                    put(&mut out.tags, key, &value);
                }
            }
        }
        pos += size;
    }
    Some(())
}

fn read_ilst(f: &mut LazyFile, start: u64, end: u64, out: &mut Probed) -> Option<()> {
    let mut pos = start;
    while pos + 8 <= end {
        let (size, kind, hdr) = atom_header(f, pos)?;
        if pos + size > end {
            break;
        }
        let body = pos + hdr;
        let body_end = pos + size;
        if &kind == b"----" {
            // Freeform: mean, name, data children.
            let mut p = body;
            let mut name = String::new();
            while p + 8 <= body_end {
                let (s, k, h) = atom_header(f, p)?;
                if p + s > body_end {
                    break;
                }
                if &k == b"name" && s > h + 4 && s - h - 4 <= 256 {
                    let n = f.exact(p + h + 4, (s - h - 4) as usize)?;
                    name = clean(String::from_utf8_lossy(&n).into_owned());
                }
                p += s;
            }
            if !name.is_empty() {
                read_mp4_data(f, &name, false, body, body_end, out)?;
            }
        } else if &kind == b"covr" {
            read_mp4_data(f, "", true, body, body_end, out)?;
        } else if let Some(key) = mp4_key(&kind) {
            read_mp4_data(f, key, false, body, body_end, out)?;
        }
        pos += size;
    }
    Some(())
}

fn read_meta(f: &mut LazyFile, start: u64, end: u64, out: &mut Probed) -> Option<()> {
    // `meta` is a full box (4 bytes of version and flags) in MP4 but a
    // plain box in some QuickTime files. Look at what follows.
    let b = f.read(start, 12).ok()?;
    let skip = if b.len() >= 12 && is_fourcc(&b[8..12]) && !is_fourcc(&b[4..8]) {
        4
    } else if b.len() >= 8 && is_fourcc(&b[4..8]) && be32(&b[..4]) as u64 <= end - start {
        0
    } else {
        4
    };
    let mut pos = start + skip;
    while pos + 8 <= end {
        let (size, kind, hdr) = atom_header(f, pos)?;
        if pos + size > end {
            break;
        }
        if &kind == b"ilst" {
            read_ilst(f, pos + hdr, pos + size, out)?;
        }
        pos += size;
    }
    Some(())
}

fn read_children(f: &mut LazyFile, start: u64, end: u64, out: &mut Probed, depth: u8) -> Option<()> {
    let mut pos = start;
    while pos + 8 <= end {
        let (size, kind, hdr) = atom_header(f, pos)?;
        if pos + size > end {
            break;
        }
        match &kind {
            b"mvhd" => {
                let b = f.exact(pos + hdr, 32)?;
                let (timescale, duration) = if b[0] == 1 { (be32(&b[20..24]), be64(&b[24..32])) } else { (be32(&b[12..16]), be32(&b[16..20]) as u64) };
                if timescale > 0 {
                    out.duration_ms = duration * 1000 / timescale as u64;
                }
            }
            b"udta" if depth < 2 => read_children(f, pos + hdr, pos + size, out, depth + 1)?,
            b"meta" => read_meta(f, pos + hdr, pos + size, out)?,
            _ => {}
        }
        pos += size;
    }
    Some(())
}

/// MP4: `mvhd` for the duration, `udta/meta/ilst` for the tags. The
/// track atoms with their sample tables, and the picture, are skipped.
pub fn read_mp4(f: &mut LazyFile) -> Option<Probed> {
    let mut out = Probed::default();
    let mut pos = 0u64;
    let mut seen_moov = false;
    let mut count = 0;
    while pos + 8 <= f.len {
        let (size, kind, hdr) = atom_header_min(f, pos, 512)?;
        if count == 0 && !matches!(&kind, b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide") {
            return None;
        }
        count += 1;
        if &kind == b"moov" {
            read_children(f, pos + hdr, pos + size, &mut out, 0)?;
            seen_moov = true;
            break;
        }
        pos += size;
        if count > 64 {
            break;
        }
    }
    seen_moov.then_some(out)
}

// ASF (WMA) --------------------------------------------------------------

const ASF_HEADER: [u8; 16] = [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C];
const ASF_FILE_PROPERTIES: [u8; 16] = [0xA1, 0xDC, 0xAB, 0x8C, 0x47, 0xA9, 0xCF, 0x11, 0x8E, 0xE4, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65];
const ASF_CONTENT_DESCRIPTION: [u8; 16] = [0x33, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C];
const ASF_EXTENDED_CONTENT: [u8; 16] = [0x40, 0xA4, 0xD0, 0xD2, 0x07, 0xE3, 0xD2, 0x11, 0x97, 0xF0, 0x00, 0xA0, 0xC9, 0x5E, 0xA8, 0x50];

fn asf_key(name: &str) -> Option<String> {
    Some(
        match name {
            "WM/AlbumTitle" => "album",
            "WM/AlbumArtist" => "album_artist",
            "WM/TrackNumber" => "track",
            "WM/PartOfSet" => "disc",
            "WM/Year" => "date",
            "WM/Genre" => "genre",
            "WM/Composer" => "composer",
            "WM/Publisher" => "publisher",
            "WM/SubTitle" => "subtitle",
            "WM/ContentGroupDescription" => "grouping",
            "WM/Track" => return None,
            other => return Some(other.trim_start_matches("WM/").to_ascii_lowercase()),
        }
        .to_string(),
    )
}

fn asf_value(kind: u16, v: &[u8]) -> String {
    match kind {
        0 => clean(utf16(v, true)),
        2 | 3 if v.len() >= 4 => le32(v).to_string(),
        4 if v.len() >= 8 => le64(v).to_string(),
        5 if v.len() >= 2 => le16(v).to_string(),
        _ => String::new(),
    }
}

/// WMA: the ASF header object carries the duration and the tags.
pub fn read_asf(f: &mut LazyFile) -> Option<Probed> {
    let h = f.read(0, 30).ok()?;
    if h.len() < 30 || h[..16] != ASF_HEADER {
        return None;
    }
    let mut out = Probed::default();
    let header_end = le64(&h[16..24]).min(f.len);
    let count = le32(&h[24..28]);
    let mut pos = 30u64;
    for _ in 0..count.min(256) {
        if pos + 24 > header_end {
            break;
        }
        let oh = f.exact(pos, 24)?;
        let size = le64(&oh[16..24]);
        if size < 24 || pos + size > header_end {
            break;
        }
        let body = pos + 24;
        let blen = size - 24;
        let guid = &oh[..16];
        if guid == ASF_FILE_PROPERTIES && blen >= 80 {
            let b = f.exact(body, 80)?;
            let play = le64(&b[40..48]);
            let preroll = le64(&b[56..64]);
            out.duration_ms = (play / 10_000).saturating_sub(preroll);
        } else if guid == ASF_CONTENT_DESCRIPTION && blen <= 65_536 && blen >= 10 {
            let b = f.exact(body, blen as usize)?;
            let lens: Vec<usize> = (0..5).map(|i| le16(&b[i * 2..]) as usize).collect();
            let mut p = 10;
            for (i, l) in lens.iter().enumerate() {
                if p + l > b.len() {
                    break;
                }
                let s = clean(utf16(&b[p..p + l], true));
                match i {
                    0 => put(&mut out.tags, "title", &s),
                    1 => put(&mut out.tags, "artist", &s),
                    _ => {}
                }
                p += l;
            }
        } else if guid == ASF_EXTENDED_CONTENT {
            let mut p = body;
            let end = body + blen;
            let n = le16(&f.exact(p, 2)?);
            p += 2;
            for _ in 0..n {
                if p + 2 > end {
                    break;
                }
                let nl = le16(&f.exact(p, 2)?) as u64;
                p += 2;
                let name = clean(utf16(&f.exact(p, nl as usize)?, true));
                p += nl;
                let tv = f.exact(p, 4)?;
                let kind = le16(&tv[..2]);
                let vl = le16(&tv[2..4]) as u64;
                p += 4;
                if name == "WM/Picture" {
                    out.has_cover = true;
                    if out.picture.is_none() && vl > 5 {
                        // type(1) size(4) mime\0\0 desc\0\0 data
                        let b = f.read(p, vl.min(512) as usize).ok()?;
                        if b.len() > 5 {
                            let (mime, rest) = split_terminated(1, &b[5..]);
                            let (desc, _) = split_terminated(1, rest);
                            let data_at = 5 + mime.len() + 2 + desc.len() + 2;
                            if 5 + mime.len() + 2 + desc.len() < b.len() && (data_at as u64) < vl {
                                let ext = if utf16(mime, true).to_ascii_lowercase().contains("png") { "png" } else { "jpg" };
                                out.picture = Some(PictureRef { offset: p + data_at as u64, len: vl - data_at as u64, ext });
                            }
                        }
                    }
                } else if vl <= MAX_TEXT {
                    if let Some(key) = asf_key(&name) {
                        let v = f.exact(p, vl as usize)?;
                        put(&mut out.tags, &key, &asf_value(kind, &v));
                    }
                }
                p += vl;
            }
        }
        pos += size;
    }
    (out.duration_ms > 0 || !out.tags.is_empty()).then_some(out)
}

// Dispatch -----------------------------------------------------------------

/// Read duration and tags with the reader for the file's extension. None
/// when the extension is not handled or the file does not parse; the
/// caller then falls back to a heavier reader.
pub fn probe_fast(path: &Path, len: Option<u64>, min_read: usize) -> Option<(Probed, LazyFile)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mut f = LazyFile::open(path, len, min_read).ok()?;
    let probed = match ext.as_str() {
        "mp3" => read_mp3(&mut f),
        "m4a" | "m4b" | "mp4" => read_mp4(&mut f),
        "wma" => read_asf(&mut f),
        _ => None,
    }?;
    Some((probed, f))
}

/// Copy a file's embedded picture to `target`. Ok(false) when it has none.
pub fn extract_picture(src: &Path, target: &Path) -> io::Result<bool> {
    let Some((p, mut f)) = probe_fast(src, None, DEFAULT_MIN_READ) else { return Ok(false) };
    let Some(pic) = p.picture else { return Ok(false) };
    if pic.len > 64 * 1024 * 1024 {
        return Ok(false);
    }
    let bytes = f.read(pic.offset, pic.len as usize)?;
    if bytes.len() < 16 {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension(format!("{}.tmp", pic.ext));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, target)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synchsafe_and_text_decoding() {
        assert_eq!(synchsafe(&[0, 0, 0x02, 0x01]), 257);
        assert_eq!(synchsafe(&[0x7f, 0x7f, 0x7f, 0x7f]), 0x0FFF_FFFF);
        assert_eq!(decode(0, b"Horus\0"), "Horus");
        assert_eq!(decode(1, &[0xFF, 0xFE, b'H', 0, b'i', 0, 0, 0]), "Hi");
        assert_eq!(decode(2, &[0, b'H', 0, b'i']), "Hi");
        assert_eq!(decode(3, "Fulgrim ✓".as_bytes()), "Fulgrim ✓");
        assert_eq!(split_terminated(1, &[b'a', 0, 0, 0, b'b', 0]), (&[b'a', 0][..], &[b'b', 0][..]));
        assert_eq!(resync(&[0xFF, 0x00, 0xE0, 0xFF, 0x00, 0x00]), vec![0xFF, 0xE0, 0xFF, 0x00]);
    }

    #[test]
    fn mpeg_header_tables() {
        // MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo.
        let h = MpegHeader::parse(&[0xFF, 0xFB, 0x90, 0x64]).unwrap();
        assert_eq!((h.version, h.layer, h.bitrate_bps, h.sample_rate, h.mono), (1, 3, 128_000, 44100, false));
        assert_eq!(h.samples_per_frame(), 1152);
        assert_eq!(h.frame_len(), 417);
        assert_eq!(h.side_info_len(), 32);
        // MPEG-2 Layer III, 64 kbps, 22.05 kHz, mono.
        let h = MpegHeader::parse(&[0xFF, 0xF3, 0x80, 0xC0]).unwrap();
        assert_eq!((h.version, h.layer, h.bitrate_bps, h.sample_rate, h.mono), (2, 3, 64_000, 22050, true));
        assert_eq!(h.samples_per_frame(), 576);
        assert_eq!(h.side_info_len(), 9);
        assert!(MpegHeader::parse(&[0xFF, 0xFB, 0xF0, 0x64]).is_none(), "bad bitrate index");
        assert!(MpegHeader::parse(&[0xFF, 0xFB, 0x9C, 0x64]).is_none(), "reserved sample rate");
    }

    #[test]
    fn lazy_file_serves_repeat_reads_from_one_fetch() {
        let dir = std::env::temp_dir().join(format!("ribbon-lazy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blob.bin");
        let data: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        let mut f = LazyFile::open(&path, Some(data.len() as u64), 4096).unwrap();
        assert_eq!(f.read(0, 10).unwrap(), &data[..10]);
        assert_eq!(f.read(100, 200).unwrap(), &data[100..300]);
        assert_eq!(f.trips, 1, "second read inside the first fetch is free");
        assert_eq!(f.read(40_000, 8).unwrap(), &data[40_000..40_008]);
        assert_eq!(f.trips, 2);
        assert_eq!(f.read(49_990, 100).unwrap(), &data[49_990..]);
        assert_eq!(f.fetched, 4096 + 4096 + 10);
        assert!(f.read(60_000, 4).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
