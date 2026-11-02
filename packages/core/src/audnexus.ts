import type { Chapter } from "./types";
import type { Correction } from "./scan/chapters";

/**
 * Chapters from Audnexus (api.audnex.us), the open service that serves
 * Audible's chapter data by ASIN. Asked only when the listener presses
 * the button; nothing else about the library is sent.
 */

export const REGIONS = ["us", "uk", "ca", "au", "de", "fr", "it", "es", "in", "jp"] as const;
export type Region = (typeof REGIONS)[number];

export function chaptersUrl(asin: string, region: Region = "us"): string {
  return `https://api.audnex.us/books/${encodeURIComponent(asin.trim().toUpperCase())}/chapters?region=${region}`;
}

export interface LookedUp {
  asin: string;
  chapters: Chapter[];
  runtimeMs: number;
  /** Audible's own intro and outro ("This is Audible."), when it says. */
  introMs: number;
  outroMs: number;
}

/** Read the service's answer. Null when it is not a chapter list. */
export function parseChapters(json: unknown): LookedUp | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const list = Array.isArray(o.chapters) ? o.chapters : null;
  if (!list || list.length === 0) return null;
  const chapters: Chapter[] = [];
  for (const c of list) {
    const r = c as Record<string, unknown>;
    const start = Number(r.startOffsetMs);
    const length = Number(r.lengthMs);
    if (!Number.isFinite(start) || !Number.isFinite(length)) return null;
    chapters.push({ startMs: start, endMs: start + length, title: String(r.title ?? "").trim() || `Chapter ${chapters.length + 1}` });
  }
  const last = chapters[chapters.length - 1]!;
  return {
    asin: String(o.asin ?? ""),
    chapters,
    runtimeMs: Number(o.runtimeLengthMs) || last.endMs,
    introMs: Number(o.brandIntroDurationMs) || 0,
    outroMs: Number(o.brandOutroDurationMs) || 0,
  };
}

export interface Fit {
  /** The looked-up runtime minus the book's, in milliseconds. */
  diffMs: number;
  /** True when the two are close enough that the times can be trusted as they are. */
  timesFit: boolean;
  /** True when there are as many chapters here as there; titles can go across one for one. */
  countsMatch: boolean;
}

/** How well a lookup fits the book in hand: within 1% and a minute, the times are good. */
export function fit(lookup: LookedUp, bookMs: number, chapterCount: number): Fit {
  const diffMs = lookup.runtimeMs - bookMs;
  return { diffMs, timesFit: Math.abs(diffMs) <= Math.max(60_000, bookMs * 0.01), countsMatch: lookup.chapters.length === chapterCount };
}

/** Corrections that put the looked-up titles on the chapters there are. */
export function titlesOnly(lookup: LookedUp, chapterCount: number): Correction[] {
  return lookup.chapters.slice(0, chapterCount).map((c, index) => ({ op: "rename", index, title: c.title }));
}

/**
 * Corrections that replace the chapters with the looked-up ones, times
 * scaled to this book's length when the two differ a little (a different
 * encode), so the last chapter still ends at the end.
 */
export function titlesAndTimes(lookup: LookedUp, bookMs: number): Correction[] {
  const scale = lookup.runtimeMs > 0 ? bookMs / lookup.runtimeMs : 1;
  const out: Correction[] = [{ op: "clear" }];
  for (const c of lookup.chapters) {
    const startMs = Math.round(c.startMs * scale);
    if (startMs < bookMs) out.push({ op: "insert", startMs, title: c.title });
  }
  return out;
}
