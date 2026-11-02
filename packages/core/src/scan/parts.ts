import type { AudioFile, Chapter, Part } from "../types";
import { fileStarts } from "../timeline";

/**
 * The stories of an anthology, from its files in book order. Files that
 * carry the same part name one after another are one story; a book
 * whose files carry no part name has no stories. Each story runs from
 * its first file's start to its last file's end.
 */
export function buildParts(files: readonly AudioFile[]): Part[] {
  const starts = fileStarts(files.map((f) => f.durationMs));
  const out: Part[] = [];
  files.forEach((f, i) => {
    if (!f.part) return;
    const end = starts[i]! + Math.max(0, f.durationMs);
    const prev = out[out.length - 1];
    if (prev && prev.title === f.part) {
      prev.endMs = end;
      return;
    }
    out.push({ title: f.part, author: f.partAuthor, startMs: starts[i]!, endMs: end });
  });
  return out.filter((p) => p.endMs > p.startMs);
}

/** Index of the story containing `positionMs`, or -1 when there are none. The last story owns its end. */
export function partAt(parts: readonly Part[], positionMs: number): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (positionMs >= parts[i]!.startMs) return i;
  }
  return parts.length > 0 ? 0 : -1;
}

export interface PartChapters {
  /** Null for chapters before the first story, which only a hand correction can make. */
  part: Part | null;
  chapters: { chapter: Chapter; index: number }[];
}

/**
 * The chapter list folded under its stories, each chapter keeping the
 * index it has in the flat list, which is what the player and the
 * corrections address. A book with no stories is one unnamed group.
 */
export function groupByPart(chapters: readonly Chapter[], parts: readonly Part[]): PartChapters[] {
  if (parts.length === 0) return [{ part: null, chapters: chapters.map((chapter, index) => ({ chapter, index })) }];
  const groups: PartChapters[] = parts.map((part) => ({ part, chapters: [] }));
  const before: PartChapters = { part: null, chapters: [] };
  chapters.forEach((chapter, index) => {
    const i = chapter.startMs < parts[0]!.startMs ? -1 : partAt(parts, chapter.startMs);
    (i < 0 ? before : groups[i]!).chapters.push({ chapter, index });
  });
  return before.chapters.length > 0 ? [before, ...groups] : groups;
}
