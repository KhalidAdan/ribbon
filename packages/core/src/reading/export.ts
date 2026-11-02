import type { BookText } from "./booktext";
import { locate } from "../timeline";
import { textToMs, type Alignment } from "./align";

/**
 * The read-along export (docs/READING.md, section 6): what Rust needs to
 * make a copy of a book's EPUB with its narration inside, as Media
 * Overlays. For each chapter the reader narrates: its sentences, when each
 * is read in the chapter's own stretch of the audiobook, and where that
 * stretch is in the audiobook's files. Pure.
 */

export interface ExportSentence {
  block: number;
  start: number;
  end: number;
  beginMs: number;
  endMs: number;
}

export interface ExportSection {
  href: string;
  /** Where its audio starts in the audiobook. */
  bookMs: number;
  sentences: ExportSentence[];
  audio: { path: string; fromMs: number; toMs: number }[];
}

export interface ExportPlan {
  epub: string;
  out: string;
  sections: ExportSection[];
}

/** Sentences shorter than this in the recording are joined to the next: a clip too short to hear is a jump. */
const SHORTEST_MS = 150;

/** The export's path beside its original: "Book.epub" becomes "Book (read-along).epub". */
export function exportPath(epub: string): string {
  return epub.replace(/(\.epub)?$/i, " (read-along).epub");
}

/**
 * The plan for a book: every narrated sentence of every linear chapter,
 * timed by the alignment (best with the whole narration transcribed),
 * each chapter's audio cut where its first sentence begins and its last
 * ends. `files` are the audiobook's files in order, by absolute path.
 */
export function exportPlan(book: BookText, alignment: Alignment, files: readonly { path: string; durationMs: number }[], epub: string): ExportPlan {
  const durations = files.map((f) => f.durationMs);
  const narrated = (chars: number) => alignment.pairs.some((p) => chars >= p.text.start && chars < p.text.end);
  const sections: ExportSection[] = [];
  book.ebook.sections.forEach((section, s) => {
    if (!section.linear) return;
    const found: { block: number; start: number; end: number; chars: number; ms: number }[] = [];
    section.blocks.forEach((_, b) => {
      for (const sentence of book.sentences(s, b)) {
        const chars = book.chars({ section: s, block: b, offset: sentence.start });
        if (narrated(chars)) found.push({ block: b, start: sentence.start, end: sentence.end, chars, ms: textToMs(alignment, chars) });
      }
    });
    if (found.length === 0) return;
    // The chapter's last sentence ends where the text after it begins to be read.
    const last = found[found.length - 1]!;
    const lastEnd = textToMs(alignment, book.chars({ section: s, block: last.block, offset: last.end }));
    const timed: ExportSentence[] = [];
    found.forEach((f, i) => {
      const endMs = i + 1 < found.length ? found[i + 1]!.ms : lastEnd;
      const prev = timed[timed.length - 1];
      // Out of order or too short to hear (a heading the narrator ran into the next line): joined to the one before.
      if (prev && (f.ms <= prev.beginMs || endMs - f.ms < SHORTEST_MS) && prev.block === f.block) {
        prev.end = f.end;
        prev.endMs = Math.max(prev.endMs, endMs);
        return;
      }
      if (endMs <= f.ms) return;
      timed.push({ block: f.block, start: f.start, end: f.end, beginMs: f.ms, endMs });
    });
    if (timed.length === 0) return;
    const fromMs = timed[0]!.beginMs;
    const toMs = timed[timed.length - 1]!.endMs;
    sections.push({
      href: section.href,
      bookMs: Math.round(fromMs),
      sentences: timed.map((t) => ({ ...t, beginMs: Math.round(t.beginMs - fromMs), endMs: Math.round(t.endMs - fromMs) })),
      audio: pieces(files, durations, fromMs, toMs),
    });
  });
  return { epub, out: exportPath(epub), sections };
}

/** A stretch of the book's timeline as pieces of its files. */
function pieces(files: readonly { path: string }[], durations: readonly number[], fromMs: number, toMs: number): ExportSection["audio"] {
  const out: ExportSection["audio"] = [];
  let at = fromMs;
  while (at < toMs - 1) {
    const loc = locate(durations, at);
    const left = durations[loc.fileIndex]! - loc.fileOffsetMs;
    const take = Math.min(left, toMs - at);
    if (take <= 0) break;
    out.push({ path: files[loc.fileIndex]!.path, fromMs: Math.round(loc.fileOffsetMs), toMs: Math.round(loc.fileOffsetMs + take) });
    at += take;
  }
  return out;
}
