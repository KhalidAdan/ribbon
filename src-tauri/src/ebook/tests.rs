use super::model::{Anchor, Ebook};
use super::*;
use std::io::Write;

/// An EPUB in memory, from (path, contents) pairs.
fn epub(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("mimetype", opts).unwrap();
    w.write_all(b"application/epub+zip").unwrap();
    for (path, data) in files {
        w.start_file(*path, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

const CONTAINER: &[u8] = br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;

/// The smallest PNG header imagesize reads: 2 by 3 pixels.
fn png() -> Vec<u8> {
    let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    b.extend_from_slice(b"IHDR");
    b.extend_from_slice(&2u32.to_be_bytes());
    b.extend_from_slice(&3u32.to_be_bytes());
    b.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    b
}

const OPF: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Voidscarred</dc:title>
    <dc:creator id="c1">Mike Brooks</dc:creator>
    <dc:creator id="c2">A Narrator</dc:creator>
    <meta refines="#c2" property="role" scheme="marc:relators">nrt</meta>
    <dc:language>en-GB</dc:language>
    <dc:publisher>Black Library</dc:publisher>
    <dc:date>2025-08-05</dc:date>
    <dc:description>&lt;p&gt;The Starsplinters are &lt;i&gt;corsairs&lt;/i&gt;.&lt;/p&gt;</dc:description>
    <dc:identifier id="bookid">urn:uuid:9C3E2701-97E8-4A84-8845-FAC671BBF378</dc:identifier>
    <dc:identifier>978-1-83609-315-2</dc:identifier>
    <dc:identifier>BL-12345</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" media-overlay="ch1-smil"/>
    <item id="ch1-smil" href="Audio/ch1.smil" media-type="application/smil+xml"/>
    <item id="ch2" href="Text/ch%202.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="css/book.css" media-type="text/css"/>
    <item id="icon" href="image/icon.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>"##;

const NAV: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="landmarks"><ol><li><a href="Text/ch2.xhtml">Wrong list</a></li></ol></nav>
<nav epub:type="toc"><ol>
  <li><a href="Text/ch1.xhtml">One</a></li>
  <li><a href="Text/ch%202.xhtml#two">Two <span>and more</span></a>
    <ol><li><a href="Text/ch%202.xhtml#deep">Deeper</a></li></ol>
  </li>
  <li><a href="Text/missing.xhtml">Not in the spine</a></li>
</ol></nav></body></html>"##;

const CSS: &str = "body, div, p, h1 { margin:0; padding:0 } \
    p.Body_Text { text-indent: 9px; margin: 0; text-align: justify } \
    p.No_Indent { text-indent: 0; margin-top: 14px } \
    p.Icon { margin-top: 113px; text-align: center } \
    h1.Chapter { text-align: center; margin-bottom: 113px } \
    i.Italic, .Em { font-style: italic } \
    .Hide { display: none } \
    p.Quote { margin-left: 20px; margin-right: 20px }";

const CH1: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Chapter</title><link href="../css/book.css" rel="stylesheet" type="text/css"/></head>
<body><section epub:type="chapter" role="doc-chapter"><div>
  <p class="Icon"><img src="../image/icon.png" alt=""/></p>
  <h1 id="h" class="Chapter">ONE</h1>
  <p class="No_Indent">First &#8216;line&#8217;&nbsp;here, <i class="Italic">Light of Heaven</i>, planet&#173;oid.</p>
  <p class="Body_Text">Second <span class="Em">italic <b>bold</b></span>   spaced
     text.<a id="mid"/>After</p>
  <p class="Hide">secret</p>
  <p class="Body_Text">Poem line<br/>next line</p>
  <hr/>
  <p class="Quote">Quoted</p>
  <ol><li>One</li><li>Two</li></ol>
  <p></p>
  <p class="Body_Text">After a gap &#x1F600; <a id="e"></a>end, <a href="notes.xhtml#n1">see the note</a>.</p>
  <script>alert('never')</script>
</div></section></body></html>"#;

const CH2: &str = r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>Opening.</p><h2 id="two">Two</h2><p>Text <em>with</em> no stylesheet.</p><p id="deep">Deep.</p>
<table><tr><td>A</td><td>B</td></tr></table>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../image/icon.png"/><text>no</text></svg>
</body></html>"#;

const NOTES: &str = r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="n1">A note.</p></body></html>"#;

fn sample(extra: &[(&str, &[u8])]) -> Ebook {
    let png = png();
    let mut files: Vec<(&str, &[u8])> = vec![
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", OPF.as_bytes()),
        ("OEBPS/toc.xhtml", NAV.as_bytes()),
        ("OEBPS/Text/ch1.xhtml", CH1.as_bytes()),
        ("OEBPS/Text/ch 2.xhtml", CH2.as_bytes()),
        ("OEBPS/Text/notes.xhtml", NOTES.as_bytes()),
        ("OEBPS/css/book.css", CSS.as_bytes()),
        ("OEBPS/image/icon.png", &png),
    ];
    files.extend_from_slice(extra);
    open_bytes(epub(&files)).expect("opens")
}

#[test]
fn reads_the_package() {
    let book = sample(&[]);
    assert_eq!(book.format, "ribbon-ebook/1");
    assert_eq!(book.layout, "reflowable");
    assert_eq!(book.meta.title, "Voidscarred");
    // The narrator is a creator, but not an author.
    assert_eq!(book.meta.authors, vec!["Mike Brooks"]);
    assert_eq!((book.meta.language.as_str(), book.meta.publisher.as_str(), book.meta.date.as_str()), ("en-GB", "Black Library", "2025-08-05"));
    assert_eq!(book.meta.description, "The Starsplinters are corsairs .");
    let ids: Vec<(&str, &str)> = book.meta.identifiers.iter().map(|i| (i.scheme.as_str(), i.value.as_str())).collect();
    assert_eq!(ids, vec![("uuid", "9c3e2701-97e8-4a84-8845-fac671bbf378"), ("isbn", "9781836093152"), ("other", "BL-12345")]);
    let hrefs: Vec<(&str, bool)> = book.sections.iter().map(|s| (s.href.as_str(), s.linear)).collect();
    assert_eq!(hrefs, vec![("OEBPS/Text/ch1.xhtml", true), ("OEBPS/Text/ch 2.xhtml", true), ("OEBPS/Text/notes.xhtml", false)]);
    assert_eq!(book.sections[0].overlay.as_deref(), Some("OEBPS/Audio/ch1.smil"));
    // What each section is, from epub:type; a section that does not say has none.
    assert_eq!(book.sections[0].kind.as_deref(), Some("chapter"));
    assert_eq!(book.sections[1].kind, None);
}

#[test]
fn reads_the_contents_from_the_toc_nav() {
    let book = sample(&[]);
    let toc: Vec<(&str, usize, usize, usize)> = book.toc.iter().map(|t| (t.label.as_str(), t.section, t.block, t.depth)).collect();
    // "Two" points at the h2, the second block; "Deeper" at the fourth. The entry outside the spine is dropped.
    assert_eq!(toc, vec![("One", 0, 0, 0), ("Two and more", 1, 1, 0), ("Deeper", 1, 3, 1)]);
}

#[test]
fn turns_a_chapter_into_blocks() {
    let book = sample(&[]);
    let b = &book.sections[0].blocks;
    let kinds: Vec<&str> = b.iter().map(|x| x.k).collect();
    assert_eq!(kinds, vec!["img", "h", "p", "p", "p", "hr", "p", "p", "p", "p"]);

    assert_eq!((b[0].src.as_deref(), b[0].w, b[0].h), (Some("OEBPS/image/icon.png"), Some(2), Some(3)));
    assert_eq!((b[1].level, b[1].text().as_str(), b[1].align), (Some(1), "ONE", Some("center")));
    assert_eq!(b[1].ids, vec![Anchor { id: "h".into(), at: 0 }]);

    // Entities, a non-breaking space and a soft hyphen kept; italic from a class; no indent; set apart.
    let first = &b[2];
    assert_eq!(first.text(), "First ‘line’\u{a0}here, Light of Heaven, planet\u{ad}oid.");
    assert_eq!(first.runs.iter().map(|r| (r.t.as_str(), r.i)).collect::<Vec<_>>(), vec![("First ‘line’\u{a0}here, ", false), ("Light of Heaven", true), (", planet\u{ad}oid.", false)]);
    assert!(!first.indent && first.space);

    // Whitespace collapsed; nested styles; an anchor's offset.
    let second = &b[3];
    assert_eq!(second.text(), "Second italic bold spaced text.After");
    assert_eq!(second.runs.iter().map(|r| (r.t.as_str(), r.i, r.b)).collect::<Vec<_>>(), vec![("Second ", false, false), ("italic ", true, false), ("bold", true, true), (" spaced text.After", false, false)]);
    assert!(second.indent && !second.space && second.align.is_none());
    assert_eq!(second.ids, vec![Anchor { id: "mid".into(), at: "Second italic bold spaced text.".len() }]);

    // The hidden paragraph is gone; a line break is a newline.
    assert_eq!(b[4].text(), "Poem line\nnext line");
    assert!(b[6].quote && b[6].text() == "Quoted");
    assert_eq!((b[7].text().as_str(), b[7].list), ("1. One", true));
    assert_eq!(b[8].text(), "2. Two");

    // An empty paragraph sets the next apart. Offsets count UTF-16, the emoji as two.
    let last = &b[9];
    assert!(last.space);
    assert_eq!(last.text(), "After a gap 😀 end, see the note.");
    assert_eq!(last.ids, vec![Anchor { id: "e".into(), at: "After a gap ".len() + 3 }]);
    let link = last.runs.iter().find(|r| r.href.is_some()).unwrap();
    assert_eq!((link.t.as_str(), link.href.as_deref()), ("see the note", Some("OEBPS/Text/notes.xhtml#n1")));
    // The script never becomes text.
    assert!(!b.iter().any(|x| x.text().contains("alert")));
    assert_eq!(book.sections[0].chars, b.iter().map(|x| x.text().encode_utf16().count()).sum::<usize>());
}

#[test]
fn reads_a_chapter_with_no_stylesheet() {
    let book = sample(&[]);
    let b = &book.sections[1].blocks;
    let kinds: Vec<&str> = b.iter().map(|x| x.k).collect();
    assert_eq!(kinds, vec!["p", "h", "p", "p", "p", "img"]);
    // Browsers set paragraphs apart unless told otherwise.
    assert!(b[2].space);
    assert_eq!(b[2].runs.iter().map(|r| (r.t.as_str(), r.i)).collect::<Vec<_>>(), vec![("Text ", false), ("with", true), (" no stylesheet.", false)]);
    assert_eq!((b[4].text().as_str(), b[4].table), ("A\tB", true));
    // An SVG cover's image is kept; its text is not.
    assert_eq!(b[5].src.as_deref(), Some("OEBPS/image/icon.png"));
}

#[test]
fn falls_back_to_the_ncx() {
    let opf = OPF.replace(r#"properties="nav""#, "");
    let ncx = br#"<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint id="a"><navLabel><text>One</text></navLabel><content src="Text/ch1.xhtml"/>
        <navPoint id="b"><navLabel><text>Inner</text></navLabel><content src="Text/ch1.xhtml#mid"/></navPoint>
      </navPoint>
      <navPoint id="c"><navLabel><text>Two</text></navLabel><content src="Text/ch%202.xhtml#two"/></navPoint>
    </navMap></ncx>"#;
    let png = png();
    let book = open_bytes(epub(&[
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", opf.as_bytes()),
        ("OEBPS/toc.ncx", ncx),
        ("OEBPS/Text/ch1.xhtml", CH1.as_bytes()),
        ("OEBPS/Text/ch 2.xhtml", CH2.as_bytes()),
        ("OEBPS/Text/notes.xhtml", NOTES.as_bytes()),
        ("OEBPS/css/book.css", CSS.as_bytes()),
        ("OEBPS/image/icon.png", &png),
    ]))
    .unwrap();
    let toc: Vec<(&str, usize, usize, usize)> = book.toc.iter().map(|t| (t.label.as_str(), t.section, t.block, t.depth)).collect();
    assert_eq!(toc, vec![("One", 0, 0, 0), ("Inner", 0, 3, 1), ("Two", 1, 1, 0)]);
}

#[test]
fn refuses_drm_but_not_obfuscated_fonts() {
    let enc = |alg: &str| {
        format!(
            r#"<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
            <enc:EncryptedData><enc:EncryptionMethod Algorithm="{alg}"/><enc:CipherData><enc:CipherReference URI="OEBPS/Text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData>
            </encryption>"#
        )
    };
    let locked = enc("http://www.w3.org/2001/04/xmlenc#aes128-cbc");
    let png = png();
    let files = |e: &'static str| -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("META-INF/container.xml", CONTAINER.to_vec()),
            ("META-INF/encryption.xml", e.as_bytes().to_vec()),
            ("OEBPS/content.opf", OPF.as_bytes().to_vec()),
            ("OEBPS/Text/ch1.xhtml", CH1.as_bytes().to_vec()),
            ("OEBPS/image/icon.png", png.clone()),
        ]
    };
    let locked: &'static str = Box::leak(locked.into_boxed_str());
    let fonts: &'static str = Box::leak(enc("http://www.idpf.org/2008/embedding").into_boxed_str());
    let as_refs = |v: &Vec<(&'static str, Vec<u8>)>| -> Vec<u8> { epub(&v.iter().map(|(p, d)| (*p, d.as_slice())).collect::<Vec<_>>()) };
    assert_eq!(open_bytes(as_refs(&files(locked))).unwrap_err(), OpenError::Drm);
    assert!(open_bytes(as_refs(&files(fonts))).is_ok());
}

#[test]
fn says_when_a_book_is_fixed_layout_or_not_an_epub() {
    let opf = OPF.replace("<dc:language>", r#"<meta property="rendition:layout">pre-paginated</meta><dc:language>"#);
    let book = open_bytes(epub(&[("META-INF/container.xml", CONTAINER), ("OEBPS/content.opf", opf.as_bytes()), ("OEBPS/Text/ch1.xhtml", CH1.as_bytes())])).unwrap();
    assert_eq!(book.layout, "pre-paginated");
    assert!(matches!(open_bytes(b"not a zip".to_vec()), Err(OpenError::NotEpub(_))));
    assert!(matches!(open_bytes(epub(&[("OEBPS/content.opf", OPF.as_bytes())])), Err(OpenError::NotEpub(_))));
}

#[test]
fn knows_an_isbn_by_its_check_digit() {
    assert_eq!(classify("urn:isbn:0-306-40615-2").value, "0306406152");
    assert_eq!(classify("080442957X").scheme, "isbn");
    assert_eq!(classify("9781836093153").scheme, "other");
    assert_eq!(classify("9c3e2701-97e8-4a84-8845-fac671bbf378").scheme, "uuid");
}

/// A real book, when one is named: `RIBBON_EPUB=path cargo test real_epub -- --ignored --nocapture`.
#[test]
#[ignore]
fn real_epub() {
    let Ok(path) = std::env::var("RIBBON_EPUB") else { return };
    let started = std::time::Instant::now();
    let bytes = std::fs::read(&path).unwrap();
    let read = started.elapsed();
    let book = open_bytes(bytes).unwrap();
    let json = serde_json::to_string(&book).unwrap();
    let blocks: usize = book.sections.iter().map(|s| s.blocks.len()).sum();
    let chars: usize = book.sections.iter().map(|s| s.chars).sum();
    println!("{} by {:?}: {} sections, {} blocks, {} chars, {} contents entries, {} KB of JSON; read {:?}, parsed {:?}", book.meta.title, book.meta.authors, book.sections.len(), blocks, chars, book.toc.len(), json.len() / 1024, read, started.elapsed() - read);
    for t in &book.toc {
        println!("  {}{} -> section {} block {}", "  ".repeat(t.depth), t.label, t.section, t.block);
    }
    println!("{:?}", book.meta.identifiers);
    // RIBBON_EPUB_SHOW=7 prints the start of section 7.
    if let Some(n) = std::env::var("RIBBON_EPUB_SHOW").ok().and_then(|s| s.parse::<usize>().ok()) {
        for b in book.sections[n].blocks.iter().take(8) {
            println!("{}", serde_json::to_string(b).unwrap());
        }
    }
    assert!(blocks > 0);
}

#[test]
fn caches_the_model_and_images_and_opens_the_last_copy_when_the_file_is_away() {
    let dir = std::env::temp_dir().join(format!("ribbon-ebook-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let png = png();
    let bytes = epub(&[
        ("META-INF/container.xml", CONTAINER),
        ("OEBPS/content.opf", OPF.as_bytes()),
        ("OEBPS/toc.xhtml", NAV.as_bytes()),
        ("OEBPS/Text/ch1.xhtml", CH1.as_bytes()),
        ("OEBPS/Text/ch 2.xhtml", CH2.as_bytes()),
        ("OEBPS/Text/notes.xhtml", NOTES.as_bytes()),
        ("OEBPS/css/book.css", CSS.as_bytes()),
        ("OEBPS/image/icon.png", &png),
    ]);
    let file = dir.join("Book.epub");
    std::fs::write(&file, &bytes).unwrap();
    let base = dir.join("cache");
    let path = file.to_string_lossy().into_owned();

    let first: serde_json::Value = serde_json::from_str(&open_cached(&path, &base).unwrap()).unwrap();
    let image = first["files"]["OEBPS/image/icon.png"].as_str().expect("the image is on disk").to_string();
    assert_eq!(std::fs::read(&image).unwrap(), png);
    // Once: the icon appears twice in the book.
    assert_eq!(first["files"].as_object().unwrap().len(), 1);

    // Unchanged: the same answer, from the cache.
    let again: serde_json::Value = serde_json::from_str(&open_cached(&path, &base).unwrap()).unwrap();
    assert_eq!(again, first);
    // Away: the last copy.
    std::fs::remove_file(&file).unwrap();
    let away: serde_json::Value = serde_json::from_str(&open_cached(&path, &base).unwrap()).unwrap();
    assert_eq!(away["meta"]["title"], "Voidscarred");
    assert!(open_cached(&dir.join("Other.epub").to_string_lossy(), &base).unwrap_err().starts_with("unreadable:"));
    assert!(open_cached("notes.txt", &base).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
