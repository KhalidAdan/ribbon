//! One chapter's XHTML into blocks of styled runs (docs/READING.md,
//! section 4). Walks the document once with a streaming XML reader that
//! forgives mismatched tags, keeping a stack of what each open element
//! says, and closes a block wherever a block-level element starts or ends,
//! the way a browser makes anonymous blocks.

use super::css::{parse_declarations, Align, Sheet};
use super::model::{Anchor, Block, Run};
use super::paths::{resolve, split_fragment};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;

/// Where a chapter's stylesheets and images come from.
pub trait Source {
    fn read(&mut self, path: &str) -> Option<Vec<u8>>;
}

/// Stylesheets and image sizes, kept across the chapters of one book.
#[derive(Default)]
pub struct Cache {
    css: HashMap<String, Option<String>>,
    sizes: HashMap<String, Option<(u32, u32)>>,
}

/**
 * Where a character of the model came from in the chapter's XHTML (for the
 * read-along export, which tags sentences in place): its UTF-16 offset in
 * its block, and the bytes of the source it was read from. Characters read
 * from one run of text, with no tag between, share a `node`: a tag may be
 * put around any stretch of one node and the document stays well formed.
 */
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub at: u32,
    pub node: u32,
    pub from: usize,
    pub to: usize,
}

/// The text event being read: its node, and its bytes in the source (a character reference's are all of it).
#[derive(Clone, Copy)]
struct Here {
    node: u32,
    start: usize,
    end: usize,
    whole: bool,
}

pub struct Chapter {
    /** What the publisher says the section is (`epub:type` or a `doc-` role): chapter, epilogue, appendix… */
    pub kind: Option<String>,
    pub blocks: Vec<Block>,
    /// Text length in UTF-16 code units.
    pub chars: usize,
}

const BLOCK_TAGS: &[&str] = &[
    "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
    "h5", "h6", "header", "hgroup", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "tfoot", "thead", "tr", "ul",
];
/// Elements whose text is never part of the book.
const SKIP_TAGS: &[&str] = &["head", "script", "style", "title", "noscript", "template", "object", "audio", "video", "math"];
/// Browsers set these apart by default; the publisher's CSS can say otherwise.
const SPACED_TAGS: &[&str] = &["p", "blockquote", "ul", "ol", "dl", "pre", "figure", "h1", "h2", "h3", "h4", "h5", "h6"];

#[derive(Clone, Default)]
struct Frame {
    tag: String,
    block: bool,
    skip: bool,
    svg: bool,
    italic: bool,
    bold: bool,
    small_caps: bool,
    sup: bool,
    sub: bool,
    pre: bool,
    href: Option<String>,
    align: Option<Align>,
    indent: bool,
    inset: bool,
    /// Its own room before and after; not inherited.
    space: bool,
    after: bool,
    heading: Option<u8>,
    /// For a list: whether it counts, and how far it has.
    numbered: bool,
    count: u32,
    /// Set once anything inside has become a block.
    produced: bool,
}

struct Open {
    block: Block,
    len: usize,
    spots: Vec<Spot>,
    /// A collapsed space not yet written, in the style of the element it was in.
    pending_space: Option<Frame>,
}

struct Walker<'a> {
    href: &'a str,
    sheet: Sheet,
    stack: Vec<Frame>,
    open: Option<Open>,
    blocks: Vec<Block>,
    pending_ids: Vec<String>,
    /// The next block is set apart: a margin after the last one, or an empty spacer paragraph.
    next_space: bool,
    /// The section's kind, from the outermost element that says.
    kind: Option<String>,
    /// Tracing for the export: the text event being read, and each block's spots, in step with `blocks`.
    tracing: bool,
    here: Option<Here>,
    spots: Vec<Vec<Spot>>,
}

pub fn read_chapter(xhtml: &str, href: &str, source: &mut dyn Source, cache: &mut Cache) -> Chapter {
    walk(xhtml, href, source, cache, false).0
}

/// A chapter, and where each block's characters came from in its XHTML (the read-along export).
pub fn read_chapter_traced(xhtml: &str, href: &str, source: &mut dyn Source, cache: &mut Cache) -> (Chapter, Vec<Vec<Spot>>) {
    walk(xhtml, href, source, cache, true)
}

fn walk(xhtml: &str, href: &str, source: &mut dyn Source, cache: &mut Cache, tracing: bool) -> (Chapter, Vec<Vec<Spot>>) {
    let mut w = Walker { href, sheet: Sheet::default(), stack: vec![Frame::default()], open: None, blocks: Vec::new(), pending_ids: Vec::new(), next_space: false, kind: None, tracing, here: None, spots: Vec::new() };
    let mut reader = Reader::from_str(xhtml);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_unmatched_ends = true;
    config.check_comments = false;
    // Runs of text with no tag between them are one node.
    let mut node = 0u32;
    let mut in_text = false;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader.read_event();
        let end = reader.buffer_position() as usize;
        let texty = matches!(event, Ok(Event::Text(_)) | Ok(Event::CData(_)) | Ok(Event::GeneralRef(_)));
        if texty && !in_text {
            node += 1;
        }
        in_text = texty;
        match event {
            Ok(Event::Start(e)) => w.start(&e, false, source, cache),
            Ok(Event::Empty(e)) => w.start(&e, true, source, cache),
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_ascii_lowercase();
                w.end(&name);
            }
            Ok(Event::Text(t)) => {
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
                w.here = Some(Here { node, start, end, whole: false });
                w.text(&text);
            }
            Ok(Event::CData(t)) => {
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
                // The text begins after "<![CDATA[".
                w.here = Some(Here { node, start: start + 9, end, whole: false });
                w.text(&text);
            }
            Ok(Event::GeneralRef(r)) => {
                let resolved = match r.resolve_char_ref() {
                    Ok(Some(ch)) => Some(ch.to_string()),
                    _ => entity(&String::from_utf8_lossy(r.as_ref())).map(str::to_string),
                };
                w.here = Some(Here { node, start, end, whole: true });
                w.text(&resolved.unwrap_or_else(|| format!("&{};", String::from_utf8_lossy(r.as_ref()))));
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            // Broken markup: keep what was read.
            Err(_) => break,
        }
        w.here = None;
    }
    w.flush();
    let chars = w.blocks.iter().map(|b| b.runs.iter().map(|r| r.t.encode_utf16().count()).sum::<usize>()).sum();
    let spots = std::mem::take(&mut w.spots);
    (Chapter { kind: w.kind, blocks: w.blocks, chars }, spots)
}

impl Walker<'_> {
    fn top(&self) -> &Frame {
        self.stack.last().expect("root frame")
    }

    fn start(&mut self, e: &BytesStart, empty: bool, source: &mut dyn Source, cache: &mut Cache) {
        let tag = String::from_utf8_lossy(e.local_name().as_ref()).to_ascii_lowercase();
        let attrs = attributes(e);
        let parent = self.top().clone();

        // Stylesheets are in the head, before anything they style.
        if tag == "link" && attrs.get("rel").is_some_and(|r| r.to_ascii_lowercase().contains("stylesheet")) {
            if let Some(h) = attrs.get("href") {
                let path = resolve(self.href, split_fragment(h).0);
                let css = cache.css.entry(path.clone()).or_insert_with(|| source.read(&path).map(|b| String::from_utf8_lossy(&b).into_owned()));
                if let Some(css) = css {
                    self.sheet.add(css);
                }
            }
        }

        let hidden = parent.skip || SKIP_TAGS.contains(&tag.as_str());
        let classes: Vec<&str> = attrs.get("class").map(|c| c.split_whitespace().collect()).unwrap_or_default();
        let mut style = self.sheet.style_of(&tag, &classes);
        if let Some(inline) = attrs.get("style") {
            style = style.over(parse_declarations(inline));
        }
        let skip = hidden || style.hidden == Some(true) || parent.svg && tag != "image";
        if self.kind.is_none() && !skip && matches!(tag.as_str(), "body" | "section" | "article" | "div" | "aside" | "nav") {
            self.kind = section_kind(&attrs);
        }

        if !skip {
            if let Some(id) = attrs.get("id").or_else(|| if tag == "a" { attrs.get("name") } else { None }) {
                self.anchor(id.clone());
            }
        }

        match tag.as_str() {
            _ if skip => {}
            "br" => self.text_raw("\n"),
            "hr" => {
                self.flush();
                self.push(Block { k: "hr", ..Block::default() });
            }
            "img" | "image" => {
                let src = attrs.get("src").or_else(|| attrs.get("href")).cloned();
                if let Some(src) = src {
                    self.image(&src, attrs.get("alt").cloned().unwrap_or_default(), source, cache);
                }
            }
            _ => {}
        }
        let block = BLOCK_TAGS.contains(&tag.as_str());
        let default_italic = matches!(tag.as_str(), "i" | "em" | "cite" | "var" | "dfn" | "address");
        let default_bold = matches!(tag.as_str(), "b" | "strong");
        let ua_space = SPACED_TAGS.contains(&tag.as_str());
        let mut frame = Frame {
            tag: tag.clone(),
            block,
            skip,
            svg: parent.svg || tag == "svg",
            italic: style.italic.unwrap_or(parent.italic || default_italic),
            bold: style.bold.unwrap_or(parent.bold || default_bold),
            small_caps: style.small_caps.unwrap_or(parent.small_caps),
            sup: parent.sup || tag == "sup",
            sub: parent.sub || tag == "sub",
            pre: parent.pre || tag == "pre",
            href: if tag == "a" { attrs.get("href").map(|h| link(self.href, h)) } else { parent.href.clone() },
            align: style.align.or(if tag == "center" { Some(Align::Center) } else { parent.align }),
            indent: style.indent.unwrap_or(parent.indent),
            inset: parent.inset || style.inset.unwrap_or(tag == "blockquote"),
            space: style.space.unwrap_or(ua_space),
            after: style.after.unwrap_or(ua_space),
            heading: tag.strip_prefix('h').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=6).contains(n)),
            numbered: tag == "ol",
            count: 0,
            produced: false,
        };
        if block && !skip {
            self.flush();
            if tag == "li" {
                let marker = match self.stack.iter_mut().rev().find(|f| f.tag == "ol" || f.tag == "ul") {
                    Some(list) if list.numbered => {
                        list.count += 1;
                        format!("{}.", list.count)
                    }
                    _ => "•".to_string(),
                };
                frame.space = false;
                self.stack.push(frame);
                self.text_raw(&marker);
                if let Some(o) = self.open.as_mut() {
                    o.pending_space = Some(Frame::default());
                }
                if empty {
                    self.end(&tag);
                }
                return;
            }
            if tag == "tr" {
                frame.space = false;
            }
        }
        if (tag == "td" || tag == "th") && !skip {
            if let Some(o) = self.open.as_mut() {
                if o.len > 0 {
                    o.pending_space = None;
                    push_text(o, "\t", &Frame::default());
                }
            }
        }
        self.stack.push(frame);
        if empty {
            self.end(&tag);
        }
    }

    fn end(&mut self, tag: &str) {
        // Forgive mismatched ends: close up to the nearest element of this name, or ignore it.
        let Some(at) = self.stack.iter().rposition(|f| f.tag == tag) else { return };
        if at == 0 {
            return;
        }
        while self.stack.len() > at {
            // Its own text first, so it knows it produced something.
            if self.top().block && !self.top().skip {
                self.flush();
            }
            let f = self.stack.pop().expect("frame");
            if f.block && !f.skip {
                // An empty paragraph between others is a gap.
                if !f.produced && matches!(f.tag.as_str(), "p" | "div") && !self.blocks.is_empty() {
                    self.next_space = true;
                }
                if f.after && f.produced {
                    self.next_space = true;
                }
            }
        }
    }

    fn text(&mut self, raw: &str) {
        let f = self.top().clone();
        if f.skip || f.svg {
            return;
        }
        if f.pre {
            self.text_raw(raw);
            return;
        }
        let (tracing, here) = (self.tracing, self.here);
        for (i, ch) in raw.char_indices() {
            if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                if let Some(o) = self.open.as_mut() {
                    if o.len > 0 && o.pending_space.is_none() {
                        o.pending_space = Some(f.clone());
                    }
                }
                continue;
            }
            let o = self.ensure_open();
            if let Some(space) = o.pending_space.take() {
                // In the style of the element it was in, as a browser draws it: after an italic word's end, plain.
                push_text(o, " ", &space);
            }
            if tracing {
                if let Some(h) = here {
                    let (from, to) = if h.whole { (h.start, h.end) } else { (h.start + i, h.start + i + ch.len_utf8()) };
                    o.spots.push(Spot { at: o.len as u32, node: h.node, from, to });
                }
            }
            let mut buf = [0u8; 4];
            push_text(o, ch.encode_utf8(&mut buf), &f);
        }
    }

    /// Text kept exactly: a line break, a list marker, preformatted text.
    fn text_raw(&mut self, raw: &str) {
        let f = self.top().clone();
        if f.skip {
            return;
        }
        let o = self.ensure_open();
        o.pending_space = None;
        push_text(o, raw, &f);
    }

    fn ensure_open(&mut self) -> &mut Open {
        if self.open.is_none() {
            let owner = self.stack.iter().rev().find(|f| f.block).cloned().unwrap_or_default();
            let inherited_inset = self.stack.iter().any(|f| f.inset);
            let mut block = Block {
                k: if owner.heading.is_some() {
                    "h"
                } else if owner.pre {
                    "pre"
                } else {
                    "p"
                },
                level: owner.heading,
                indent: owner.indent && owner.heading.is_none(),
                align: owner.align.and_then(Align::name),
                space: (owner.space && !self.blocks.is_empty()) || self.next_space,
                quote: inherited_inset,
                list: owner.tag == "li",
                table: owner.tag == "tr" || self.stack.iter().any(|f| f.tag == "tr"),
                ..Block::default()
            };
            block.ids = self.pending_ids.drain(..).map(|id| Anchor { id, at: 0 }).collect();
            self.next_space = false;
            self.open = Some(Open { block, len: 0, spots: Vec::new(), pending_space: None });
        }
        self.open.as_mut().expect("open block")
    }

    fn anchor(&mut self, id: String) {
        match self.open.as_mut() {
            Some(o) => {
                let at = o.len + usize::from(o.pending_space.is_some());
                o.block.ids.push(Anchor { id, at });
            }
            None => self.pending_ids.push(id),
        }
    }

    fn flush(&mut self) {
        let Some(mut o) = self.open.take() else { return };
        // Trailing spaces never count; a trailing line break neither.
        while let Some(last) = o.block.runs.last_mut() {
            let trimmed = last.t.trim_end_matches([' ', '\n']).len();
            last.t.truncate(trimmed);
            if last.t.is_empty() {
                o.block.runs.pop();
            } else {
                break;
            }
        }
        let has_text = o.block.runs.iter().any(|r| r.t.chars().any(|c| !c.is_whitespace()));
        if !has_text {
            // Nothing to read: its anchors move to whatever comes next.
            self.pending_ids.extend(o.block.ids.into_iter().map(|a| a.id));
            if o.block.space {
                self.next_space = true;
            }
            return;
        }
        let len: usize = o.block.runs.iter().map(|r| r.t.encode_utf16().count()).sum();
        for a in &mut o.block.ids {
            a.at = a.at.min(len);
        }
        let spots = std::mem::take(&mut o.spots);
        self.push(o.block);
        if self.tracing {
            *self.spots.last_mut().expect("pushed") = spots;
        }
    }

    fn push(&mut self, mut block: Block) {
        if block.k != "p" && block.k != "h" && block.k != "pre" {
            block.ids.splice(0..0, self.pending_ids.drain(..).map(|id| Anchor { id, at: 0 }));
        }
        for f in &mut self.stack {
            f.produced = true;
        }
        self.blocks.push(block);
        if self.tracing {
            self.spots.push(Vec::new());
        }
    }

    fn image(&mut self, src: &str, alt: String, source: &mut dyn Source, cache: &mut Cache) {
        let path = resolve(self.href, split_fragment(src).0);
        let size = *cache.sizes.entry(path.clone()).or_insert_with(|| {
            let bytes = source.read(&path)?;
            imagesize::blob_size(&bytes).ok().map(|s| (s.width as u32, s.height as u32))
        });
        self.flush();
        let (w, h) = size.unwrap_or((0, 0));
        // An image set apart by the paragraph that holds it is set apart too.
        let holder = self.stack.iter().rev().find(|f| f.block).is_some_and(|f| f.space);
        let space = self.next_space || (holder && !self.blocks.is_empty());
        self.next_space = false;
        self.push(Block { k: "img", src: Some(path), w: Some(w), h: Some(h), alt: Some(alt), space, ..Block::default() });
    }
}

/// The structural kind an element declares: the first `epub:type` token
/// (without a vocabulary prefix), else a `doc-` role.
fn section_kind(attrs: &HashMap<String, String>) -> Option<String> {
    let from_type = attrs.get("type").and_then(|t| t.split_whitespace().next()).map(|t| t.rsplit(':').next().unwrap_or(t).to_ascii_lowercase());
    let from_role = attrs.get("role").and_then(|r| r.split_whitespace().find_map(|t| t.strip_prefix("doc-"))).map(str::to_ascii_lowercase);
    from_type.or(from_role).filter(|k| !k.is_empty())
}

/// Add text to the open block, merging with the last run when the style matches.
fn push_text(o: &mut Open, text: &str, f: &Frame) {
    o.len += text.encode_utf16().count();
    let run = Run { t: String::new(), i: f.italic, b: f.bold, sc: f.small_caps, sup: f.sup, sub: f.sub, href: f.href.clone() };
    match o.block.runs.last_mut() {
        Some(last) if last.same_style(&run) => last.t.push_str(text),
        _ => o.block.runs.push(Run { t: text.to_string(), ..run }),
    }
}

fn attributes(e: &BytesStart) -> HashMap<String, String> {
    e.attributes()
        .flatten()
        .map(|a| {
            let key = String::from_utf8_lossy(a.key.local_name().as_ref()).to_ascii_lowercase();
            let value = a.unescape_value_with(entity).map(|v| v.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
            (key, value)
        })
        .collect()
}

/// A link: kept as it is when it leaves the book, else a path in the book plus its fragment.
fn link(base: &str, href: &str) -> String {
    let lower = href.to_ascii_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("mailto:") {
        return href.to_string();
    }
    let (path, frag) = split_fragment(href);
    let target = if path.is_empty() { base.to_string() } else { resolve(base, path) };
    match frag {
        Some(f) => format!("{target}#{f}"),
        None => target,
    }
}

/// The named entities XHTML in the wild uses, which XML itself does not define.
pub fn entity(name: &str) -> Option<&'static str> {
    const TABLE: &[(&str, &str)] = &[
        ("amp", "&"), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"),
        ("nbsp", "\u{a0}"), ("shy", "\u{ad}"), ("ndash", "–"), ("mdash", "—"), ("lsquo", "‘"), ("rsquo", "’"), ("sbquo", "‚"),
        ("ldquo", "“"), ("rdquo", "”"), ("bdquo", "„"), ("hellip", "…"), ("prime", "′"), ("Prime", "″"), ("laquo", "«"), ("raquo", "»"),
        ("lsaquo", "‹"), ("rsaquo", "›"), ("copy", "©"), ("reg", "®"), ("trade", "™"), ("deg", "°"), ("middot", "·"), ("bull", "•"),
        ("dagger", "†"), ("Dagger", "‡"), ("sect", "§"), ("para", "¶"), ("times", "×"), ("divide", "÷"), ("plusmn", "±"), ("minus", "−"),
        ("frac12", "½"), ("frac14", "¼"), ("frac34", "¾"), ("sup1", "¹"), ("sup2", "²"), ("sup3", "³"), ("iexcl", "¡"), ("iquest", "¿"),
        ("cent", "¢"), ("pound", "£"), ("euro", "€"), ("yen", "¥"), ("thinsp", "\u{2009}"), ("ensp", "\u{2002}"), ("emsp", "\u{2003}"),
        ("zwj", "\u{200d}"), ("zwnj", "\u{200c}"), ("lrm", "\u{200e}"), ("rlm", "\u{200f}"), ("larr", "←"), ("rarr", "→"),
        ("aacute", "á"), ("Aacute", "Á"), ("agrave", "à"), ("Agrave", "À"), ("acirc", "â"), ("Acirc", "Â"), ("atilde", "ã"), ("Atilde", "Ã"),
        ("auml", "ä"), ("Auml", "Ä"), ("aring", "å"), ("Aring", "Å"), ("aelig", "æ"), ("AElig", "Æ"), ("ccedil", "ç"), ("Ccedil", "Ç"),
        ("eacute", "é"), ("Eacute", "É"), ("egrave", "è"), ("Egrave", "È"), ("ecirc", "ê"), ("Ecirc", "Ê"), ("euml", "ë"), ("Euml", "Ë"),
        ("iacute", "í"), ("Iacute", "Í"), ("igrave", "ì"), ("Igrave", "Ì"), ("icirc", "î"), ("Icirc", "Î"), ("iuml", "ï"), ("Iuml", "Ï"),
        ("ntilde", "ñ"), ("Ntilde", "Ñ"), ("oacute", "ó"), ("Oacute", "Ó"), ("ograve", "ò"), ("Ograve", "Ò"), ("ocirc", "ô"), ("Ocirc", "Ô"),
        ("otilde", "õ"), ("Otilde", "Õ"), ("ouml", "ö"), ("Ouml", "Ö"), ("oslash", "ø"), ("Oslash", "Ø"), ("uacute", "ú"), ("Uacute", "Ú"),
        ("ugrave", "ù"), ("Ugrave", "Ù"), ("ucirc", "û"), ("Ucirc", "Û"), ("uuml", "ü"), ("Uuml", "Ü"), ("yacute", "ý"), ("Yacute", "Ý"),
        ("yuml", "ÿ"), ("szlig", "ß"), ("eth", "ð"), ("ETH", "Ð"), ("thorn", "þ"), ("THORN", "Þ"), ("oelig", "œ"), ("OElig", "Œ"),
    ];
    TABLE.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}
