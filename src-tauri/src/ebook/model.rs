//! The book model Rust hands the reader, `ribbon-ebook/1`
//! (docs/READING.md, section 4). Text offsets are UTF-16 code units, the
//! way JavaScript counts.

use serde::Serialize;
use std::collections::BTreeMap;

pub const FORMAT: &str = "ribbon-ebook/1";

fn no(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Debug)]
pub struct Ebook {
    pub format: &'static str,
    pub meta: Meta,
    /// "reflowable", or "pre-paginated" for a fixed-layout book, which the reader refuses.
    pub layout: String,
    pub sections: Vec<Section>,
    pub toc: Vec<TocEntry>,
    /// Where each image is on this machine, by its path in the book. Set by the cache.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, String>,
}

#[derive(Serialize, Debug, Default)]
pub struct Meta {
    pub title: String,
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub language: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub publisher: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub date: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub identifiers: Vec<Identifier>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Identifier {
    /// "isbn", "uuid", or "other".
    pub scheme: String,
    pub value: String,
}

#[derive(Serialize, Debug)]
pub struct Section {
    pub href: String,
    pub linear: bool,
    /// The SMIL file of the section's Media Overlay, when the book has read-along.
    pub overlay: Option<String>,
    /// What the publisher says the section is (`epub:type` or a `doc-` role), when it says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub chars: usize,
    pub blocks: Vec<Block>,
    /// Its Media Overlay read (level 3 of read-along): each passage, by the id of its element, and
    /// where it is in the book's own audio.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub narration: Vec<Narrated>,
}

/// A passage of a Media Overlay: the element with this id is read in this audio file (a path in
/// the book) from `begin` to `end` milliseconds.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Narrated {
    pub id: String,
    pub audio: String,
    pub begin: u64,
    pub end: u64,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct Block {
    pub k: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<Run>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<Anchor>,
    #[serde(skip_serializing_if = "no")]
    pub indent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<&'static str>,
    #[serde(skip_serializing_if = "no")]
    pub space: bool,
    #[serde(skip_serializing_if = "no")]
    pub quote: bool,
    #[serde(skip_serializing_if = "no")]
    pub list: bool,
    #[serde(skip_serializing_if = "no")]
    pub table: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    /// An image's tone for dark mode, "ink" or "picture" (tone.rs). Set by the cache.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone: Option<&'static str>,
}

#[cfg(test)]
impl Block {
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.t.as_str()).collect()
    }
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct Run {
    pub t: String,
    #[serde(skip_serializing_if = "no")]
    pub i: bool,
    #[serde(skip_serializing_if = "no")]
    pub b: bool,
    #[serde(skip_serializing_if = "no")]
    pub sc: bool,
    #[serde(skip_serializing_if = "no")]
    pub sup: bool,
    #[serde(skip_serializing_if = "no")]
    pub sub: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

impl Run {
    pub fn same_style(&self, other: &Run) -> bool {
        self.i == other.i && self.b == other.b && self.sc == other.sc && self.sup == other.sup && self.sub == other.sub && self.href == other.href
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Anchor {
    pub id: String,
    pub at: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct TocEntry {
    pub label: String,
    pub section: usize,
    pub block: usize,
    pub depth: usize,
}
