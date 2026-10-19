//! Opening an EPUB into the book model (docs/READING.md). The file is read
//! whole, once, in one request, because the library may be a share across
//! the internet; everything after that is in memory.

pub mod content;
pub mod css;
pub mod model;
pub mod paths;
pub mod xml;

use content::{read_chapter, Cache, Source};
use model::{Ebook, Identifier, Meta, Section, TocEntry, FORMAT};
use paths::{resolve, split_fragment};
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek};
use xml::Node;
use zip::ZipArchive;

/// What can stop a book from opening, in words the reader can show.
#[derive(Debug, PartialEq)]
pub enum OpenError {
    /// Encrypted with DRM: Ribbon does not open it, as it does not open AAX.
    Drm,
    NotEpub(String),
}

impl OpenError {
    pub fn message(&self) -> String {
        match self {
            OpenError::Drm => "drm: this EPUB is locked with DRM".to_string(),
            OpenError::NotEpub(why) => format!("unreadable: {why}"),
        }
    }
}

/// The most any one file inside an EPUB may unpack to.
const ENTRY_MAX: u64 = 256 * 1024 * 1024;

/// Font obfuscation (IDPF and Adobe) hides fonts, not the book. Anything else in encryption.xml is DRM.
const FONT_OBFUSCATION: &[&str] = &["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"];

struct Zip<R> {
    archive: ZipArchive<R>,
}

impl<R: Read + Seek> Zip<R> {
    /// The entry, by exact name, else ignoring case: some books name a file one way and link it another.
    fn index_of(&self, path: &str) -> Option<usize> {
        if let Some(i) = self.archive.index_for_name(path) {
            return Some(i);
        }
        let name = self.archive.file_names().find(|n| n.eq_ignore_ascii_case(path))?.to_string();
        self.archive.index_for_name(&name)
    }

    fn text(&mut self, path: &str) -> Option<String> {
        self.read(path).map(|b| String::from_utf8_lossy(&b).into_owned())
    }
}

impl<R: Read + Seek> Source for Zip<R> {
    fn read(&mut self, path: &str) -> Option<Vec<u8>> {
        let i = self.index_of(path)?;
        let file = self.archive.by_index(i).ok()?;
        let mut out = Vec::new();
        file.take(ENTRY_MAX).read_to_end(&mut out).ok()?;
        Some(out)
    }
}

pub fn open_bytes(bytes: Vec<u8>) -> Result<Ebook, OpenError> {
    open_reader(Cursor::new(bytes))
}

pub fn open_reader<R: Read + Seek>(reader: R) -> Result<Ebook, OpenError> {
    let archive = ZipArchive::new(reader).map_err(|e| OpenError::NotEpub(format!("not a zip file ({e})")))?;
    let mut zip = Zip { archive };

    if let Some(enc) = zip.text("META-INF/encryption.xml") {
        let doc = xml::parse(&enc);
        let mut methods = Vec::new();
        doc.descendants("EncryptionMethod", &mut methods);
        if methods.iter().any(|m| !m.attr("Algorithm").is_some_and(|a| FONT_OBFUSCATION.contains(&a))) {
            return Err(OpenError::Drm);
        }
    }

    let container = zip.text("META-INF/container.xml").ok_or_else(|| OpenError::NotEpub("no META-INF/container.xml".into()))?;
    let container = xml::parse(&container);
    let mut rootfiles = Vec::new();
    container.descendants("rootfile", &mut rootfiles);
    let opf_path = rootfiles
        .iter()
        .find(|r| r.attr("media-type").map_or(true, |t| t == "application/oebps-package+xml"))
        .and_then(|r| r.attr("full-path"))
        .map(|p| resolve("", p))
        .ok_or_else(|| OpenError::NotEpub("the container names no package".into()))?;
    let opf_text = zip.text(&opf_path).ok_or_else(|| OpenError::NotEpub(format!("{opf_path} is missing")))?;
    let opf = xml::parse(&opf_text);
    let package = opf.find("package").ok_or_else(|| OpenError::NotEpub("the package file has no package".into()))?;

    let meta = read_meta(package);
    let layout = package
        .find("metadata")
        .map(|m| {
            let mut metas = Vec::new();
            m.descendants("meta", &mut metas);
            metas.iter().any(|x| x.attr("property") == Some("rendition:layout") && x.all_text() == "pre-paginated")
        })
        .unwrap_or(false);

    struct Item {
        href: String,
        media_type: String,
        properties: String,
        overlay: Option<String>,
    }
    let mut items: HashMap<String, Item> = HashMap::new();
    if let Some(manifest) = package.find("manifest") {
        for it in manifest.children_named("item") {
            let (Some(id), Some(href)) = (it.attr("id"), it.attr("href")) else { continue };
            items.insert(
                id.to_string(),
                Item {
                    href: resolve(&opf_path, href),
                    media_type: it.attr("media-type").unwrap_or("").to_string(),
                    properties: it.attr("properties").unwrap_or("").to_string(),
                    overlay: it.attr("media-overlay").map(str::to_string),
                },
            );
        }
    }

    let spine = package.find("spine");
    let mut cache = Cache::default();
    let mut sections = Vec::new();
    for itemref in spine.map(|s| s.children_named("itemref").collect::<Vec<_>>()).unwrap_or_default() {
        let Some(item) = itemref.attr("idref").and_then(|id| items.get(id)) else { continue };
        let Some(text) = zip.text(&item.href) else { continue };
        let chapter = read_chapter(&text, &item.href, &mut zip, &mut cache);
        sections.push(Section {
            href: item.href.clone(),
            linear: itemref.attr("linear") != Some("no"),
            overlay: item.overlay.as_ref().and_then(|id| items.get(id)).map(|o| o.href.clone()),
            chars: chapter.chars,
            blocks: chapter.blocks,
        });
    }
    if sections.is_empty() {
        return Err(OpenError::NotEpub("the book has no readable chapters".into()));
    }

    // Contents: the EPUB 3 navigation document, else the EPUB 2 NCX.
    let nav = items.values().find(|i| i.properties.split_whitespace().any(|p| p == "nav"));
    let mut raw: Vec<(String, String, usize)> = Vec::new();
    if let Some(nav) = nav {
        if let Some(text) = zip.text(&nav.href) {
            nav_entries(&xml::parse(&text), &nav.href, &mut raw);
        }
    }
    if raw.is_empty() {
        let ncx = spine.and_then(|s| s.attr("toc")).and_then(|id| items.get(id)).or_else(|| items.values().find(|i| i.media_type == "application/x-dtbncx+xml"));
        if let Some(ncx) = ncx {
            if let Some(text) = zip.text(&ncx.href) {
                if let Some(map) = xml::parse(&text).find("navMap") {
                    ncx_entries(map, &ncx.href, 0, &mut raw);
                }
            }
        }
    }
    let toc = raw.into_iter().filter_map(|(label, href, depth)| place(&sections, &href).map(|(section, block)| TocEntry { label, section, block, depth })).collect();

    Ok(Ebook { format: FORMAT, meta, layout: if layout { "pre-paginated" } else { "reflowable" }.to_string(), sections, toc })
}

fn read_meta(package: &Node) -> Meta {
    let Some(m) = package.find("metadata") else { return Meta::default() };
    let first = |name: &str| m.children_named(name).map(|n| n.all_text()).find(|t| !t.is_empty()).unwrap_or_default();
    // EPUB 3 gives a creator's role in a separate meta that refines it.
    let mut roles: HashMap<String, String> = HashMap::new();
    for x in m.children_named("meta") {
        if let (Some(r), Some("role")) = (x.attr("refines"), x.attr("property")) {
            roles.insert(r.trim_start_matches('#').to_string(), x.all_text());
        }
    }
    let authors = m
        .children_named("creator")
        .filter(|c| {
            let role = c.attr("role").map(str::to_string).or_else(|| c.attr("id").and_then(|id| roles.get(id).cloned()));
            role.map_or(true, |r| r == "aut")
        })
        .map(|c| c.all_text())
        .filter(|t| !t.is_empty())
        .collect();
    let mut identifiers: Vec<Identifier> = Vec::new();
    for id in m.children_named("identifier") {
        let ident = classify(&id.all_text());
        if !ident.value.is_empty() && !identifiers.contains(&ident) {
            identifiers.push(ident);
        }
    }
    let description = first("description");
    let description = if description.contains('<') { strip_tags(&description) } else { description };
    Meta { title: first("title"), authors, language: first("language"), publisher: first("publisher"), date: first("date"), description, identifiers }
}

/// An identifier's scheme, from its prefix or its shape.
fn classify(raw: &str) -> Identifier {
    let v = raw.trim();
    let lower = v.to_ascii_lowercase();
    if let Some(u) = lower.strip_prefix("urn:uuid:") {
        return Identifier { scheme: "uuid".into(), value: u.to_string() };
    }
    let bare = lower.strip_prefix("urn:isbn:").or_else(|| lower.strip_prefix("isbn:")).unwrap_or(&lower);
    let digits: String = bare.chars().filter(|c| !matches!(c, '-' | ' ')).collect();
    // Declared as one or not, a number is an ISBN only when its check digit agrees.
    if is_isbn(&digits) {
        return Identifier { scheme: "isbn".into(), value: digits.to_ascii_uppercase() };
    }
    let uuid_shape = lower.len() == 36 && lower.chars().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() });
    if uuid_shape {
        return Identifier { scheme: "uuid".into(), value: lower };
    }
    Identifier { scheme: "other".into(), value: v.to_string() }
}

/// A valid ISBN-13 or ISBN-10, by its check digit.
fn is_isbn(d: &str) -> bool {
    let b = d.as_bytes();
    if b.len() == 13 && b.iter().all(u8::is_ascii_digit) {
        let sum: u32 = b.iter().enumerate().map(|(i, c)| u32::from(c - b'0') * if i % 2 == 0 { 1 } else { 3 }).sum();
        return sum % 10 == 0;
    }
    if b.len() == 10 && b[..9].iter().all(u8::is_ascii_digit) && (b[9].is_ascii_digit() || b[9] == b'x' || b[9] == b'X') {
        let sum: u32 = b.iter().enumerate().map(|(i, c)| (10 - i as u32) * if *c == b'x' || *c == b'X' { 10 } else { u32::from(c - b'0') }).sum();
        return sum % 11 == 0;
    }
    false
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut inside = false;
    for ch in s.chars() {
        match ch {
            '<' => inside = true,
            '>' if inside => {
                inside = false;
                out.push(' ');
            }
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The `toc` nav of an EPUB 3 navigation document, as (label, href, depth).
fn nav_entries(doc: &Node, base: &str, out: &mut Vec<(String, String, usize)>) {
    let mut navs = Vec::new();
    doc.descendants("nav", &mut navs);
    let Some(nav) = navs.iter().find(|n| n.attr("type").is_some_and(|t| t.split_whitespace().any(|t| t == "toc"))).or(navs.first()) else { return };
    if let Some(ol) = nav.find("ol") {
        walk_ol(ol, base, 0, out);
    }
}

fn walk_ol(ol: &Node, base: &str, depth: usize, out: &mut Vec<(String, String, usize)>) {
    for li in ol.children_named("li") {
        if let Some(a) = li.child("a") {
            if let Some(href) = a.attr("href") {
                out.push((a.all_text(), link_target(base, href), depth));
            }
        }
        if let Some(sub) = li.child("ol") {
            walk_ol(sub, base, depth + 1, out);
        }
    }
}

fn ncx_entries(parent: &Node, base: &str, depth: usize, out: &mut Vec<(String, String, usize)>) {
    for point in parent.children_named("navPoint") {
        let label = point.child("navLabel").map(|l| l.all_text()).unwrap_or_default();
        if let Some(src) = point.child("content").and_then(|c| c.attr("src")) {
            out.push((label, link_target(base, src), depth));
        }
        ncx_entries(point, base, depth + 1, out);
    }
}

fn link_target(base: &str, href: &str) -> String {
    let (path, frag) = split_fragment(href);
    let target = if path.is_empty() { base.to_string() } else { resolve(base, path) };
    match frag {
        Some(f) => format!("{target}#{f}"),
        None => target,
    }
}

/// The section and block an href points at. A fragment that is not found means the section's start.
fn place(sections: &[Section], href: &str) -> Option<(usize, usize)> {
    let (path, frag) = split_fragment(href);
    let s = sections.iter().position(|s| s.href == path)?;
    let block = frag.and_then(|f| sections[s].blocks.iter().position(|b| b.ids.iter().any(|a| a.id == f))).unwrap_or(0);
    Some((s, block))
}

/// Open an EPUB where it sits and give back its book model as JSON.
/// The whole file is read in one request, then parsed in memory.
#[tauri::command]
pub async fn ebook_open(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Only ever an EPUB: this reads outside the webview's file scope.
        if !path.to_ascii_lowercase().ends_with(".epub") {
            return Err("unreadable: not an EPUB".to_string());
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("unreadable: {e}"))?;
        let book = open_bytes(bytes).map_err(|e| e.message())?;
        serde_json::to_string(&book).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
