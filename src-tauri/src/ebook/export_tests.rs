use super::*;
use crate::ebook::content::{read_chapter, Source};
use std::io::Read;

struct NoFiles;
impl Source for NoFiles {
    fn read(&mut self, _: &str) -> Option<Vec<u8>> {
        None
    }
}

const CHAPTER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>One</title></head><body>\n<h1>ONE</h1>\n<p>The waygate hung before them. It was a <em>giant circle of wraithbone</em> &#8211; and at fully\n  forty feet across, it dwarfed them. &#8216;Who made it?&#8217; asked Jurilan.</p>\n<p>Eluadhri said <i>nothing. Then</i> she laughed.</p>\n</body></html>\n";

/// The sentences of a chapter, simply: by block and UTF-16 offsets, ending at each full stop or question mark.
fn sentences(xhtml: &str) -> Vec<(usize, u32, u32, String)> {
    let ch = read_chapter(xhtml, "OEBPS/Text/one.xhtml", &mut NoFiles, &mut Cache::default());
    let mut out = Vec::new();
    for (b, block) in ch.blocks.iter().enumerate() {
        let text: Vec<u16> = block.text().encode_utf16().collect();
        let mut start = 0usize;
        for i in 0..text.len() {
            let last = i + 1 == text.len();
            if text[i] == '.' as u16 || text[i] == '?' as u16 || last {
                let end = i + 1;
                let mut s = start;
                while s < end && text[s] == ' ' as u16 {
                    s += 1;
                }
                if s < end {
                    out.push((b, s as u32, end as u32, format!("s{}", out.len() + 1)));
                }
                start = end;
            }
        }
    }
    out
}

#[test]
fn tags_each_sentence_where_it_is_and_changes_nothing_else() {
    let wanted = sentences(CHAPTER);
    let (_, spots) = read_chapter_traced(CHAPTER, "OEBPS/Text/one.xhtml", &mut NoFiles, &mut Cache::default());
    let (tagged, wrapped) = tag_sentences(CHAPTER, &spots, &wanted);
    assert!(wrapped.iter().all(|w| *w));
    // Read back: the same text, and each sentence's id where the sentence begins.
    let before = read_chapter(CHAPTER, "OEBPS/Text/one.xhtml", &mut NoFiles, &mut Cache::default());
    let after = read_chapter(&tagged, "OEBPS/Text/one.xhtml", &mut NoFiles, &mut Cache::default());
    assert_eq!(before.blocks.iter().map(|b| b.text()).collect::<Vec<_>>(), after.blocks.iter().map(|b| b.text()).collect::<Vec<_>>());
    for (block, start, _, id) in &wanted {
        let at = after.blocks[*block].ids.iter().find(|a| &a.id == id).map(|a| a.at as u32);
        assert_eq!(at, Some(*start), "{id}");
    }
    // Entities are kept as they were written, and the only change is the spans.
    let stripped = wanted.iter().fold(tagged.clone(), |t, (_, _, _, id)| t.replace(&format!("<span id=\"{id}\">"), "")).replace("</span>", "");
    assert_eq!(stripped, CHAPTER);
    // A sentence running into italics is wrapped up to the tag; the document stays well formed.
    assert!(tagged.contains("\">Eluadhri said</span> <i>"), "{tagged}");
    let mut reader = quick_xml::Reader::from_str(&tagged);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(e) => panic!("not well formed: {e}"),
        }
    }
}

#[test]
fn writes_paths_relative_to_the_file_that_names_them() {
    assert_eq!(relative("OEBPS/ribbon/001.smil", "OEBPS/Text/ch 1.xhtml"), "../Text/ch%201.xhtml");
    assert_eq!(relative("OEBPS/content.opf", "OEBPS/ribbon/audio/001-at-0ms.m4a"), "ribbon/audio/001-at-0ms.m4a");
    assert_eq!(relative("content.opf", "a/b.css"), "a/b.css");
    assert_eq!(secs(61_005), "61.005s");
    assert_eq!(hms(3_723_456), "1:02:03.456");
}

#[test]
fn exports_a_book_that_reads_along() {
    let dir = std::env::temp_dir().join(format!("ribbon-export-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // The audiobook: six seconds of tone.
    let mp3 = dir.join("book.mp3");
    let made = Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6"]).arg(&mp3).status().unwrap();
    assert!(made.success());
    // The EPUB.
    let opf = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<package version=\"3.0\" xmlns=\"http://www.idpf.org/2007/opf\" unique-identifier=\"id\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>T</dc:title><dc:identifier id=\"id\">x</dc:identifier></metadata><manifest><item id=\"one\" href=\"Text/one.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"one\"/></spine></package>";
    let container = "<?xml version=\"1.0\"?><container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>";
    let epub = dir.join("Book.epub");
    {
        let mut w = ZipWriter::new(std::fs::File::create(&epub).unwrap());
        let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (p, d) in [("mimetype", "application/epub+zip"), ("META-INF/container.xml", container), ("OEBPS/content.opf", opf), ("OEBPS/Text/one.xhtml", CHAPTER)] {
            w.start_file(p, o).unwrap();
            w.write_all(d.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }
    let wanted = sentences(CHAPTER);
    let plan = Plan {
        epub: epub.to_string_lossy().into_owned(),
        out: dir.join("Book (read-along).epub").to_string_lossy().into_owned(),
        sections: vec![SectionPlan {
            href: "OEBPS/Text/one.xhtml".into(),
            book_ms: 500,
            sentences: wanted.iter().enumerate().map(|(i, (block, start, end, _))| Sentence { block: *block, start: *start, end: *end, begin_ms: i as u64 * 1000, end_ms: (i as u64 + 1) * 1000 }).collect(),
            audio: vec![Segment { path: mp3.to_string_lossy().into_owned(), from_ms: 500, to_ms: 5_500 }],
        }],
    };
    let calls = std::sync::Mutex::new(Vec::new());
    export(&plan, &|d, t| calls.lock().unwrap().push((d, t))).unwrap();
    assert_eq!(*calls.lock().unwrap(), vec![(1, 1)]);
    // Read by Ribbon: every sentence narrated, by its id, from audio named for where it starts.
    let bytes = std::fs::read(&plan.out).unwrap();
    let book = crate::ebook::open_bytes(bytes.clone()).unwrap();
    let n = &book.sections[0].narration;
    assert_eq!(n.len(), wanted.len());
    assert_eq!(n[1].audio, "OEBPS/ribbon/audio/001-at-500ms.m4a");
    assert_eq!((n[1].begin, n[1].end), (1000, 2000));
    let block = &book.sections[0].blocks[wanted[1].0];
    assert_eq!(block.ids.iter().find(|a| a.id == n[1].id).map(|a| a.at as u32), Some(wanted[1].1));
    // A valid package: mimetype first and stored, the overlay declared, the audio inside and five seconds long.
    let mut z = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert_eq!(z.by_index(0).unwrap().name(), "mimetype");
    assert_eq!(z.by_index(0).unwrap().compression(), CompressionMethod::Stored);
    let mut opf = String::new();
    z.by_name("OEBPS/content.opf").unwrap().read_to_string(&mut opf).unwrap();
    assert!(opf.contains("media-overlay=\"ribbon-smil-1\""));
    assert!(opf.contains("<meta property=\"media:active-class\">-epub-media-overlay-active</meta>"));
    assert!(opf.contains("prefix=\"ribbon: "));
    let audio = dir.join("out.m4a");
    std::io::copy(&mut z.by_name("OEBPS/ribbon/audio/001-at-500ms.m4a").unwrap(), &mut std::fs::File::create(&audio).unwrap()).unwrap();
    let probe = Command::new("ffprobe").args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(&audio).output().unwrap();
    let secs: f64 = String::from_utf8_lossy(&probe.stdout).trim().parse().unwrap();
    assert!((secs - 5.0).abs() < 0.15, "{secs} s");
    let _ = std::fs::remove_dir_all(&dir);
}
