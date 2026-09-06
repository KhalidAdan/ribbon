import type { AudioFile, Chapter } from "../types";
import { fileStarts } from "../timeline";

/**
 * Effective chapters for a book. Embedded markers win, offset into the
 * book timeline by the file's start. Files without markers contribute
 * one chapter each, named by the file's title tag, else its filename,
 * else "Chapter N".
 */
export function buildChapters(files: readonly AudioFile[]): Chapter[] {
  const durations = files.map((f) => f.durationMs);
  const starts = fileStarts(durations);
  const out: Chapter[] = [];
  files.forEach((f, i) => {
    const start = starts[i]!;
    const end = start + Math.max(0, f.durationMs);
    if (f.chapters.length > 0) {
      for (const c of f.chapters) {
        const s = start + Math.max(0, c.startMs);
        const e = Math.min(end, start + c.endMs);
        if (e > s) out.push({ startMs: s, endMs: e, title: c.title });
      }
    } else if (f.durationMs > 0) {
      out.push({ startMs: start, endMs: end, title: f.title || stem(f.path) || `Chapter ${i + 1}` });
    }
  });
  return normalize(out);
}

function stem(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Sorted, no two equal starts, ends never overlap the next start, titles filled. */
export function normalize(chapters: readonly Chapter[]): Chapter[] {
  const sorted = [...chapters].sort((a, b) => a.startMs - b.startMs);
  const out: Chapter[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.startMs === prev.startMs) continue;
    if (prev && prev.endMs > c.startMs) prev.endMs = c.startMs;
    out.push({ ...c });
  }
  out.forEach((c, i) => {
    if (!c.title) c.title = `Chapter ${i + 1}`;
  });
  return out.filter((c) => c.endMs > c.startMs);
}

/** Index of the chapter containing `positionMs`, or -1. Last chapter owns its end. */
export function chapterAt(chapters: readonly Chapter[], positionMs: number): number {
  for (let i = chapters.length - 1; i >= 0; i--) {
    const c = chapters[i]!;
    if (positionMs >= c.startMs) return i;
  }
  return chapters.length > 0 ? 0 : -1;
}

/**
 * A hand correction to the effective chapter list. Applied in order, each
 * by the index the list has at that moment.
 */
export type Correction =
  | { op: "rename"; index: number; title: string }
  | { op: "move"; index: number; startMs: number }
  | { op: "delete"; index: number }
  | { op: "insert"; startMs: number; title: string };

export interface CorrectionReport {
  chapters: Chapter[];
  ignored: { correction: Correction; reason: string }[];
}

export function applyCorrections(chapters: readonly Chapter[], corrections: readonly Correction[], totalMs: number): CorrectionReport {
  let list = chapters.map((c) => ({ ...c }));
  const ignored: CorrectionReport["ignored"] = [];
  for (const c of corrections) {
    if (c.op === "insert") {
      if (c.startMs < 0 || c.startMs >= totalMs) {
        ignored.push({ correction: c, reason: "start outside book" });
        continue;
      }
      list.push({ startMs: c.startMs, endMs: totalMs, title: c.title });
      list = reflow(list, totalMs);
      continue;
    }
    const target = list[c.index];
    if (!target) {
      ignored.push({ correction: c, reason: `no chapter at index ${c.index}` });
      continue;
    }
    if (c.op === "rename") target.title = c.title;
    else if (c.op === "delete") list.splice(c.index, 1);
    else if (c.op === "move") {
      if (c.startMs < 0 || c.startMs >= totalMs) {
        ignored.push({ correction: c, reason: "start outside book" });
        continue;
      }
      target.startMs = c.startMs;
    }
    list = reflow(list, totalMs);
  }
  return { chapters: list, ignored };
}

/** After any edit, each chapter runs to the next start; the last runs to the end. */
function reflow(list: Chapter[], totalMs: number): Chapter[] {
  const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
  const out: Chapter[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.startMs === c.startMs) continue;
    out.push({ ...c });
  }
  for (let i = 0; i < out.length; i++) {
    out[i]!.endMs = i + 1 < out.length ? out[i + 1]!.startMs : totalMs;
  }
  return out.filter((c) => c.endMs > c.startMs);
}

export const CORRECTION_HEADERS = ["op", "index", "start_ms", "title"];

export function correctionsToRows(list: readonly Correction[]): Record<string, string>[] {
  return list.map((c) => ({
    op: c.op,
    index: "index" in c ? String(c.index) : "",
    start_ms: "startMs" in c ? String(c.startMs) : "",
    title: "title" in c ? c.title : "",
  }));
}

export function rowsToCorrections(rows: readonly Record<string, string>[]): Correction[] {
  const out: Correction[] = [];
  for (const r of rows) {
    const index = Number(r.index);
    const startMs = Number(r.start_ms);
    const title = r.title ?? "";
    switch (r.op) {
      case "rename":
        if (Number.isInteger(index)) out.push({ op: "rename", index, title });
        break;
      case "move":
        if (Number.isInteger(index) && Number.isFinite(startMs)) out.push({ op: "move", index, startMs });
        break;
      case "delete":
        if (Number.isInteger(index)) out.push({ op: "delete", index });
        break;
      case "insert":
        if (Number.isFinite(startMs)) out.push({ op: "insert", startMs, title });
        break;
      default:
        break;
    }
  }
  return out;
}
