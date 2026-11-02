//! A chapter's XHTML as Ribbon's model sees it: the file, and where in it
//! each character the reader shows was read from. A stretch of the model's
//! text (a sentence, a highlight) can then be marked in the book's own
//! file, at its own bytes, and nothing else in the file changes. The
//! read-along export wraps every sentence this way.
//!
//! Places here are the model's: a block of the chapter and UTF-16 offsets
//! in its text, as the TypeScript side's `TextPlace` has them.

use super::content::{read_chapter_traced, Cache, Source, Spot};
use std::ops::Range;

/// A stretch of one block's text: from `start` up to, not including, `end`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlockRange {
    pub block: usize,
    pub start: u32,
    pub end: u32,
}

/// A stretch to mark, and the tags to put around it.
pub struct Mark {
    pub range: BlockRange,
    pub open: String,
    pub close: String,
}

pub struct ChapterSource {
    xhtml: String,
    /// For each block of the model, where each of its characters came from.
    spots: Vec<Vec<Spot>>,
}

impl ChapterSource {
    pub fn read(xhtml: &str, href: &str, source: &mut dyn Source, cache: &mut Cache) -> Self {
        let (_, spots) = read_chapter_traced(xhtml, href, source, cache);
        Self { xhtml: xhtml.to_string(), spots }
    }

    pub fn xhtml(&self) -> &str {
        &self.xhtml
    }

    /// The bytes of the file a stretch was read from, as far as its first run of text goes: a tag
    /// put around them keeps the file well formed. None when none of it was read from the file's
    /// text (a list number, a preformatted block).
    pub fn bytes(&self, r: BlockRange) -> Option<Range<usize>> {
        let inside = self.spots.get(r.block)?.iter().filter(|s| s.at >= r.start && s.at < r.end);
        let mut from: Option<&Spot> = None;
        let mut to = 0;
        for s in inside {
            let first = *from.get_or_insert(s);
            if s.node == first.node {
                to = to.max(s.to);
            }
        }
        from.map(|f| f.from..to)
    }

    /// The file with each stretch wrapped in its tags, and for each whether it could be. A stretch
    /// running across a tag (a sentence ending in italics) is wrapped up to the tag.
    pub fn wrap(&self, marks: &[Mark]) -> (String, Vec<bool>) {
        // (byte, 0 for a close and 1 for an open, so a stretch ending where the next begins closes first, tag)
        let mut cuts: Vec<(usize, u8, &str)> = Vec::new();
        let wrapped = marks
            .iter()
            .map(|m| match self.bytes(m.range) {
                Some(b) => {
                    cuts.push((b.start, 1, &m.open));
                    cuts.push((b.end, 0, &m.close));
                    true
                }
                None => false,
            })
            .collect();
        cuts.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut out = String::with_capacity(self.xhtml.len() + cuts.len() * 24);
        let mut at = 0;
        for (pos, _, tag) in cuts {
            out.push_str(&self.xhtml[at..pos]);
            out.push_str(tag);
            at = pos;
        }
        out.push_str(&self.xhtml[at..]);
        (out, wrapped)
    }
}
