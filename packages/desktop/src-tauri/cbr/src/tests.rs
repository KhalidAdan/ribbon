//! Over archives made for the tests, by the RAR crate's own writer: packed as real CBRs
//! are, which the archives Node makes for its tests (packages/host-node/src/make-cbr.ts)
//! are not. No page of anyone's comic is here.

use super::*;
use rars::{ArchiveVersion, Builder};
use std::io::Cursor;
use std::path::PathBuf;

/// A scratch folder of this test's own.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ribbon-cbr-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A page's worth of bytes for the test, the same every time: stretches that repeat, which
/// a packer squeezes, between stretches of noise, which it can't.
fn page(number: u32, len: usize) -> Vec<u8> {
    let mut x = number.wrapping_mul(2_654_435_761).max(1);
    (0..len)
        .map(|i| {
            if (i / 4096) % 2 == 0 {
                return (i % 61) as u8 + number as u8;
            }
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

/// The files of a small comic: what it says of itself, litter, and four pages in a folder.
fn comic() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("ComicInfo.xml", b"<ComicInfo><Series>Made Up</Series></ComicInfo>".to_vec()),
        ("scans/page-1.png", page(1, 300_000)),
        ("scans/page-2.png", page(2, 180_000)),
        ("scans/page-10.png", page(10, 240_000)),
        ("notes.txt", b"hello".to_vec()),
        ("scans/page-3.png", page(3, 90_000)),
    ]
}

/// How an archive is packed for a test.
#[derive(Clone, Copy, Debug)]
struct Packed {
    format: ArchiveVersion,
    /// Stored as they are, rather than squeezed.
    stored: bool,
    /// Each file packed against the ones before it.
    solid: bool,
}

const EVERY_WAY: [Packed; 6] = [
    Packed { format: ArchiveVersion::Rar50, stored: true, solid: false },
    Packed { format: ArchiveVersion::Rar50, stored: false, solid: false },
    Packed { format: ArchiveVersion::Rar50, stored: false, solid: true },
    Packed { format: ArchiveVersion::Rar29, stored: true, solid: false },
    Packed { format: ArchiveVersion::Rar29, stored: false, solid: false },
    Packed { format: ArchiveVersion::Rar29, stored: false, solid: true },
];

fn builder(files: &[(&str, Vec<u8>)], how: Packed) -> Builder {
    let mut builder = Builder::new(how.format).store(how.stored).solid(how.solid).compression_level(if how.stored { None } else { Some(5) });
    for (name, bytes) in files {
        builder.add_bytes(name.as_bytes().to_vec(), bytes.clone(), None, None).unwrap();
    }
    builder
}

fn rar(files: &[(&str, Vec<u8>)], how: Packed) -> Vec<u8> {
    builder(files, how).to_bytes().unwrap()
}

fn opened(bytes: Vec<u8>) -> Result<Cbr, Refusal> {
    Cbr::read(Cursor::new(bytes))
}

#[test]
fn every_file_is_listed_and_comes_out_as_it_went_in_however_it_was_packed() {
    let files = comic();
    for how in EVERY_WAY {
        let archive = rar(&files, how);
        let cbr = opened(archive).unwrap_or_else(|e| panic!("{how:?}: {e}"));
        let listed: Vec<(&str, u64)> = cbr.entries().iter().map(|e| (e.name.as_str(), e.size)).collect();
        let made: Vec<(&str, u64)> = files.iter().map(|(name, bytes)| (*name, bytes.len() as u64)).collect();
        assert_eq!(listed, made, "{how:?}");
        // Out of order, as a reader asks for pages: a later one, an earlier one, the same one again.
        for name in ["scans/page-10.png", "scans/page-1.png", "ComicInfo.xml", "scans/page-3.png", "scans/page-1.png"] {
            let went_in = &files.iter().find(|(n, _)| *n == name).unwrap().1;
            assert_eq!(&cbr.read_entry(name, PAGE_MAX).unwrap(), went_in, "{how:?}: {name}");
        }
        if !how.stored {
            let packed: u64 = cbr.entries().iter().map(|e| e.packed).sum();
            let whole: u64 = cbr.entries().iter().map(|e| e.size).sum();
            assert!(packed < whole, "{how:?}: the test's archive was squeezed");
        }
        assert!(cbr.read_entry("scans/page-4.png", PAGE_MAX).is_err());
    }
}

#[test]
fn folders_are_parted_by_a_slash_whichever_way_the_archive_wrote_them() {
    // RAR before 5 writes a backslash, as Windows does; a page's name is the same either way.
    let files = vec![("Chapter 1\\001.jpg", page(1, 2_000)), ("Chapter 1\\002.jpg", page(2, 2_000))];
    let cbr = opened(rar(&files, Packed { format: ArchiveVersion::Rar29, stored: true, solid: false })).unwrap();
    assert_eq!(cbr.entries().iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Chapter 1/001.jpg", "Chapter 1/002.jpg"]);
    assert_eq!(cbr.read_entry("Chapter 1/002.jpg", PAGE_MAX).unwrap(), files[1].1);
}

#[test]
fn listing_asks_the_file_once_for_each_file_in_it_and_a_page_two_or_three_times() {
    // Forty pages of 1.2 MB, stored: what a share is asked for is what makes a CBR slow or not.
    let files: Vec<(String, Vec<u8>)> = (1..=40).map(|i| (format!("page-{i:03}.jpg"), page(i, 1_200_000))).collect();
    let named: Vec<(&str, Vec<u8>)> = files.iter().map(|(n, b)| (n.as_str(), b.clone())).collect();
    for format in [ArchiveVersion::Rar50, ArchiveVersion::Rar29] {
        let cbr = opened(rar(&named, Packed { format, stored: true, solid: false })).unwrap();
        let to_list = cbr.requests();
        assert!(to_list <= 40 + 2, "{format:?}: {to_list} requests to list 40 files");
        let before = cbr.requests();
        cbr.read_entry("page-025.jpg", PAGE_MAX).unwrap();
        let for_a_page = cbr.requests() - before;
        assert!(for_a_page <= 3, "{format:?}: {for_a_page} requests for one page");
    }
}

#[test]
fn a_file_that_is_no_rar_is_told_by_its_first_bytes() {
    assert_eq!(opened(b"PK\x03\x04 a zip under the wrong name".to_vec()).err(), Some(Refusal::NotRar));
    assert_eq!(opened(Vec::new()).err(), Some(Refusal::NotRar));
    // It starts as one and is cut short: broken, and said so.
    let whole = rar(&comic(), EVERY_WAY[0]);
    let cut = opened(whole[..whole.len() / 2].to_vec());
    assert!(matches!(cut, Err(Refusal::Broken(_))) || cut.is_ok_and(|cbr| cbr.read_entry("scans/page-3.png", PAGE_MAX).is_err()));

    let dir = scratch("sniff");
    std::fs::write(dir.join("a.cbr"), rar(&comic(), EVERY_WAY[3])).unwrap();
    std::fs::write(dir.join("b.cbr"), b"PK\x03\x04").unwrap();
    assert!(is_rar(&dir.join("a.cbr")));
    assert!(!is_rar(&dir.join("b.cbr")));
    assert!(!is_rar(&dir.join("missing.cbr")));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn one_part_of_a_split_archive_is_refused_in_a_sentence() {
    for format in [ArchiveVersion::Rar50, ArchiveVersion::Rar29] {
        // One long page across three parts: the old format's writer splits one file at a time.
        let parts = builder(&[("001.jpg", page(1, 500_000))], Packed { format, stored: true, solid: false }).volume_size(Some(200_000)).build_volumes(None).unwrap();
        assert!(parts.len() > 1);
        for part in [parts[0].clone(), parts[1].clone()] {
            let refused = opened(part).err();
            assert_eq!(refused, Some(Refusal::Split), "{format:?}");
            assert_eq!(refused.unwrap().to_string(), SPLIT);
        }
    }
}

/// The checksum RAR keeps of each header.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

#[test]
fn an_archive_locked_with_a_password_is_refused_in_a_sentence() {
    // This crate is built without passwords, so it can't lock an archive either. A stored one
    // has its first file marked as locked instead, which is all a reader sees before it refuses.
    let mut archive = rar(&[("001.jpg", page(1, 5_000))], Packed { format: ArchiveVersion::Rar29, stored: true, solid: false });
    // After the seven bytes every RAR 4 starts with come headers, each saying its kind, its size, and
    // (flag 0x8000) the size of what follows it: the file's header is kind 0x74.
    let mut file = 7;
    while archive[file + 2] != 0x74 {
        let follows = if archive[file + 4] & 0x80 != 0 { u32::from_le_bytes(archive[file + 7..file + 11].try_into().unwrap()) as usize } else { 0 };
        file += u16::from_le_bytes([archive[file + 5], archive[file + 6]]) as usize + follows;
    }
    archive[file + 3] |= 0x04;
    let size = u16::from_le_bytes([archive[file + 5], archive[file + 6]]) as usize;
    let sum = (crc32(&archive[file + 2..file + size]) & 0xffff) as u16;
    archive[file..file + 2].copy_from_slice(&sum.to_le_bytes());

    let refused = opened(archive).err();
    assert_eq!(refused, Some(Refusal::Locked));
    assert_eq!(refused.unwrap().to_string(), LOCKED);
}

#[test]
fn what_is_refused_is_said_as_core_says_it() {
    // packages/core/src/comic/cbr.ts holds the same two sentences, and its test the same check.
    assert_eq!(LOCKED, "It is locked with a password, and Ribbon opens only comics that aren't.");
    assert_eq!(SPLIT, "It is one part of an archive split across several files, and Ribbon reads a comic from one file.");
}

#[test]
fn a_page_larger_than_a_page_could_be_is_not_read() {
    for how in EVERY_WAY {
        let cbr = opened(rar(&comic(), how)).unwrap();
        assert!(cbr.read_entry("scans/page-1.png", 299_999).is_err(), "{how:?}");
        assert!(cbr.read_entry("scans/page-1.png", 300_000).is_ok(), "{how:?}");
    }
}

#[test]
fn an_archive_of_more_files_than_a_comic_has_is_refused() {
    let files: Vec<(String, Vec<u8>)> = (0..FILES_MAX + 100).map(|i| (format!("{i}.txt"), Vec::new())).collect();
    let named: Vec<(&str, Vec<u8>)> = files.iter().map(|(n, b)| (n.as_str(), b.clone())).collect();
    assert!(matches!(opened(rar(&named, EVERY_WAY[0])), Err(Refusal::Broken(_))));
}

#[test]
fn a_cbr_is_written_out_as_a_cbz_of_the_same_files_none_squeezed() {
    let dir = scratch("cbz");
    let files = comic();
    for (i, how) in EVERY_WAY.into_iter().enumerate() {
        let target = dir.join(format!("{i}.cbz"));
        opened(rar(&files, how)).unwrap().write_cbz(&target).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&target).unwrap()).unwrap();
        assert_eq!(zip.len(), files.len(), "{how:?}");
        for (at, (name, went_in)) in files.iter().enumerate() {
            let mut entry = zip.by_index(at).unwrap();
            assert_eq!(entry.name(), *name, "{how:?}");
            assert_eq!(entry.compression(), zip::CompressionMethod::Stored);
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            assert_eq!(&bytes, went_in, "{how:?}: {name}");
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn nothing_is_left_behind_when_a_cbz_can_not_be_written() {
    let dir = scratch("cbz-fails");
    // Cut short after its list was read: the pages can't all come out.
    let whole = rar(&comic(), EVERY_WAY[0]);
    let target = dir.join("cut.cbz");
    if let Ok(cbr) = opened(whole[..whole.len() - 50_000].to_vec()) {
        assert!(cbr.write_cbz(&target).is_err());
        assert!(!target.exists());
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// A file that answers slowly, as a share across the internet does: each request waits.
struct Slow {
    file: File,
    wait: std::time::Duration,
}

impl Read for Slow {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(out)
    }
}

impl Seek for Slow {
    fn seek(&mut self, to: std::io::SeekFrom) -> std::io::Result<u64> {
        // ReadAhead seeks once for each request it makes.
        if matches!(to, std::io::SeekFrom::Start(_)) {
            std::thread::sleep(self.wait);
        }
        self.file.seek(to)
    }
}

/// How long a CBR takes, when `RIBBON_CBR_PATH` names one (it is only read): its list, a
/// few pages, and written out as a CBZ. `RIBBON_CBR_WAIT_MS` makes every request for bytes
/// wait that long, as a share does. For the numbers a pull request carries; run with
/// `cargo test -p ribbon-cbr --release -- --ignored --nocapture timing`.
#[test]
#[ignore]
fn reads_a_real_cbr_and_reports_timing() {
    let Some(path) = std::env::var_os("RIBBON_CBR_PATH").map(PathBuf::from) else { return };
    let wait = std::env::var("RIBBON_CBR_WAIT_MS").ok().and_then(|ms| ms.parse().ok()).unwrap_or(0);
    let ms = |t: std::time::Instant| t.elapsed().as_secs_f64() * 1000.0;

    let t = std::time::Instant::now();
    let cbr = Cbr::read(Slow { file: File::open(&path).unwrap(), wait: std::time::Duration::from_millis(wait) }).expect("a CBR");
    let files = cbr.entries().len();
    println!("list: {files} files in {:.1} ms, {} requests", ms(t), cbr.requests());

    for at in [files / 2, files / 2 + 1, files - 1, 1.min(files - 1)] {
        let entry = &cbr.entries()[at];
        let (t, before) = (std::time::Instant::now(), cbr.requests());
        let bytes = cbr.read_entry(&entry.name, PAGE_MAX).unwrap();
        println!("file {} of {files}: {} KB in {:.1} ms, {} requests", at + 1, bytes.len() / 1024, ms(t), cbr.requests() - before);
    }

    let target = std::env::temp_dir().join(format!("ribbon-cbr-timing-{}.cbz", std::process::id()));
    let (t, before) = (std::time::Instant::now(), cbr.requests());
    cbr.write_cbz(&target).unwrap();
    println!("as a CBZ: {} MB in {:.1} ms, {} requests", std::fs::metadata(&target).map(|m| m.len() >> 20).unwrap_or(0), ms(t), cbr.requests() - before);
    let _ = std::fs::remove_file(target);
}
