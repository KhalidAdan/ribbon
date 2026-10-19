import type { Ebook } from "../ebook";
import { globalOffset } from "./align";
import type { Anchor } from "./anchors";

/**
 * Level 3 of read-along (#56): an EPUB's Media Overlay, as Storyteller
 * makes them, says when each passage is read in the book's own audio.
 * When that audio is the audiobook beside it, every passage is an exact
 * point mapping the text to the recording. Pure.
 */

export interface OverlayAudio {
  /** The audiobook's files in order, by path, with their lengths. */
  files: { path: string; durationMs: number }[];
  durationMs: number;
}

/** A file's name without folders or extension, compared loosely. */
function stem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Lengths this close are the same recording: an encoder pads or trims a little at each end. */
function sameLength(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(30_000, Math.max(a, b) * 0.015);
}

/**
 * The overlay's passages as points of the audiobook's timeline, in reading
 * order, or null when its audio is not this recording. The overlay's files
 * are matched to the audiobook's by name; failing that, taken in order,
 * when together they are as long as the audiobook (each file's length is
 * where its last passage ends, so the gaps are spread in proportion).
 */
export function overlayAnchors(ebook: Ebook, audio: OverlayAudio): Anchor[] | null {
  const passages: { chars: number; audio: string; begin: number }[] = [];
  ebook.sections.forEach((s, section) => {
    if (!s.linear || !s.narration?.length) return;
    const ids = new Map<string, { block: number; at: number }>();
    s.blocks.forEach((b, block) => b.ids?.forEach((a) => ids.set(a.id, { block, at: a.at })));
    for (const n of s.narration) {
      const where = ids.get(n.id);
      if (where) passages.push({ chars: globalOffset(ebook, { section, block: where.block, offset: where.at }), audio: n.audio, begin: n.begin });
    }
  });
  if (passages.length === 0) return null;

  // The overlay's files in the order the book first reads them, each as long as its last passage.
  const order: string[] = [];
  const lengths = new Map<string, number>();
  for (const s of ebook.sections) {
    for (const n of s.narration ?? []) {
      if (!lengths.has(n.audio)) order.push(n.audio);
      lengths.set(n.audio, Math.max(lengths.get(n.audio) ?? 0, n.end));
    }
  }

  const starts = new Map<string, number>();
  const bookStarts: number[] = [];
  audio.files.reduce((t, f) => (bookStarts.push(t), t + f.durationMs), 0);
  const byName = new Map(audio.files.map((f, i) => [stem(f.path), i]));
  if (order.every((a) => byName.has(stem(a)))) {
    for (const a of order) starts.set(a, bookStarts[byName.get(stem(a))!]!);
  } else {
    const sum = order.reduce((t, a) => t + lengths.get(a)!, 0);
    if (!sameLength(sum, audio.durationMs)) return null;
    const stretch = audio.durationMs / Math.max(1, sum);
    let t = 0;
    for (const a of order) {
      starts.set(a, Math.round(t));
      t += lengths.get(a)! * stretch;
    }
  }

  const out: Anchor[] = [];
  for (const p of passages) {
    const ms = starts.get(p.audio)! + p.begin;
    const last = out[out.length - 1];
    // Points run forward both ways; a passage read out of order (a note, a sidebar) is left out.
    if (!last || (ms > last.ms && p.chars > last.chars)) out.push({ ms, chars: p.chars });
  }
  return out.length > 0 ? out : null;
}
