import { CRC32 } from "@culvert/crc32";
import type { Bookmark, Highlight, HighlightText } from "./types";
import { bytesToRows, rowsToBytes, int, type ParseReport } from "./csv";
import { mergeById, ribbonClaim, type Locator, type LogRecord, type MarkRecord } from "./poslog";

export const BOOKMARK_HEADERS = ["book_id", "offset_ms", "created_at", "note", "clip"];
export const CLIP_MS = 30_000;

/** The CSV earlier versions read. A highlight is only in the log: as a row, its id would be read back as another bookmark's. */
export function serializeBookmarks(list: readonly Bookmark[]): Promise<Uint8Array> {
  const sorted = list.filter((b) => !b.text).sort((a, b) => a.offsetMs - b.offsetMs);
  return rowsToBytes(
    sorted.map((b) => ({
      book_id: b.bookId,
      offset_ms: String(Math.max(0, Math.round(b.offsetMs))),
      created_at: b.createdAt,
      note: b.note,
      clip: b.clip,
    })),
    BOOKMARK_HEADERS,
  );
}

export async function parseBookmarks(bytes: Uint8Array): Promise<{ bookmarks: Bookmark[]; problems: ParseReport["problems"] }> {
  const { rows, problems } = await bytesToRows(bytes);
  const bookmarks: Bookmark[] = [];
  for (const row of rows) {
    if (!row.book_id) {
      problems.push({ line: JSON.stringify(row), message: "missing book_id" });
      continue;
    }
    const offsetMs = Math.max(0, int(row.offset_ms));
    bookmarks.push({
      id: markId(row.book_id, offsetMs),
      bookId: row.book_id,
      offsetMs,
      createdAt: row.created_at ?? "",
      note: row.note ?? "",
      clip: row.clip ?? "",
    });
  }
  bookmarks.sort((a, b) => a.offsetMs - b.offsetMs);
  return { bookmarks, problems };
}

/** The thirty seconds before the bookmark, never starting before zero. */
export function clipRange(offsetMs: number, lengthMs = CLIP_MS): { startMs: number; endMs: number } {
  const endMs = Math.max(0, Math.round(offsetMs));
  return { startMs: Math.max(0, endMs - lengthMs), endMs };
}

export function clipName(bookId: string, offsetMs: number): string {
  return `${bookId}-${Math.max(0, Math.round(offsetMs))}.opus`;
}

/** ffmpeg args that cut `[startMs, endMs)` of `inputPath` to a small Opus file. */
export function clipArgs(inputPath: string, startMs: number, endMs: number, outputPath: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-y",
    "-ss",
    (startMs / 1000).toFixed(3),
    "-to",
    (endMs / 1000).toFixed(3),
    "-i",
    inputPath,
    "-vn",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    outputPath,
  ];
}

// Marks in the position log --------------------------------------------

/** The extension field (section 3) a mark keeps its clip's file name in. */
export const CLIP_X = "urn:ribbon:clip";
/** The device a row of a bookmarks CSV counts as, like a legacy position file. */
export const LEGACY_BOOKMARKS_DEV = "legacy:bookmarks";

/**
 * A bookmark's id: the same on every device for the same place in the
 * same book, a version 8 UUID from four CRC-32s of the book id and the
 * offset. A row of the bookmarks CSV and the mark written with it are
 * then one bookmark, and one `del` takes back both.
 */
export function markId(bookId: string, offsetMs: number): string {
  return uuid8(`${bookId}
${Math.max(0, Math.round(offsetMs))}`);
}

/**
 * A highlight's id, made the same way from the book id, where its words
 * start and the words, so the same words marked on two devices are one
 * bookmark. Never the id of a bookmark by time.
 */
export function highlightId(bookId: string, start: Locator, quote: string): string {
  return uuid8(`text
${bookId}
${start.href}
${start.locations?.progression ?? 0}
${quote}`);
}

function uuid8(key: string): string {
  let hex = "";
  for (let i = 0; i < 4; i++) {
    const crc = new CRC32();
    crc.update(new TextEncoder().encode(`${i}
${key}`));
    hex += (crc.digest() >>> 0).toString(16).padStart(8, "0");
  }
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The thirty seconds a bookmark keeps, as a Media Fragment in seconds. */
export function markSelector(offsetMs: number): { type: "FragmentSelector"; conformsTo: string; value: string } {
  const { startMs, endMs } = clipRange(offsetMs);
  return { type: "FragmentSelector", conformsTo: "http://www.w3.org/TR/media-frags/", value: `t=${startMs / 1000},${endMs / 1000}` };
}

export type MarkFields = Pick<MarkRecord, "k" | "id" | "motivation" | "created" | "modified" | "target" | "body" | "x">;

/** A bookmark as the fields of its `mark` record, without the ones every record has. */
export function markFields(b: Bookmark | Highlight): MarkFields {
  return {
    k: "mark",
    id: b.id,
    motivation: "bookmarking",
    created: b.createdAt,
    ...(b.modifiedAt ? { modified: b.modifiedAt } : {}),
    target: { ...(b.offsetMs !== null ? { ms: b.offsetMs, selector: markSelector(b.offsetMs) } : {}), ...(b.text ? { text: b.text } : {}) },
    ...(b.note ? { body: b.note } : {}),
    ...(b.clip ? { x: { [CLIP_X]: b.clip } } : {}),
  };
}

/** A row of a bookmarks CSV, read as a `mark` written when the bookmark was made. */
export function legacyMark(b: Bookmark): MarkRecord {
  const t = Number.isNaN(Date.parse(b.createdAt)) ? new Date(0).toISOString() : b.createdAt;
  return { v: 1, dev: LEGACY_BOOKMARKS_DEV, seq: 0, t, book: { ids: [ribbonClaim(b.bookId)] }, ...markFields(b) };
}

/**
 * A book's bookmarks: every device's bookmarking marks that claim it and
 * the rows of its bookmarks CSV, the latest per id, minus what a `del`
 * took back. A row is as old as its bookmark, so any mark written since
 * (a note edited, a bookmark deleted) wins over it.
 */
export function bookmarksOf(records: readonly LogRecord[], book: { id: string; claims: readonly string[] }, rows: readonly Bookmark[], nowMs = Date.now()): Bookmark[] {
  const out: Bookmark[] = [];
  for (const h of marksOf(records, book, rows, nowMs)) {
    if (h.offsetMs === null) continue;
    const { text, ...rest } = h;
    out.push({ ...rest, offsetMs: h.offsetMs, ...(text ? { text } : {}) });
  }
  return out.sort((a, b) => a.offsetMs - b.offsetMs || a.createdAt.localeCompare(b.createdAt));
}

/**
 * A book's bookmarks made from highlights, with a time or without one,
 * in the order their words come in the book.
 */
export function highlightsOf(records: readonly LogRecord[], book: { id: string; claims: readonly string[] }, nowMs = Date.now()): Highlight[] {
  const out: Highlight[] = [];
  for (const h of marksOf(records, book, [], nowMs)) if (h.text) out.push({ ...h, text: h.text });
  const at = (h: Highlight) => h.text.start.locations?.totalProgression ?? 0;
  return out.sort((a, b) => at(a) - at(b) || a.createdAt.localeCompare(b.createdAt));
}

/** Every bookmarking mark of a book that has a time, words in its text, or both. */
function marksOf(records: readonly LogRecord[], book: { id: string; claims: readonly string[] }, rows: readonly Bookmark[], nowMs: number): (Omit<Highlight, "text"> & { text?: HighlightText })[] {
  const clips = new Map(rows.filter((r) => r.clip).map((r) => [r.id, r.clip]));
  const claims = new Set(book.claims);
  const marks = mergeById<MarkRecord>([...rows.map(legacyMark), ...records], "mark", nowMs);
  const out: (Omit<Highlight, "text"> & { text?: HighlightText })[] = [];
  for (const m of marks) {
    if (m.motivation !== "bookmarking" || !m.book.ids.some((id) => claims.has(id))) continue;
    const ms = typeof m.target.ms === "number" && Number.isFinite(m.target.ms) ? Math.max(0, Math.round(m.target.ms)) : null;
    const text = highlightText(m.target.text);
    if (ms === null && !text) continue;
    const clip = m.x?.[CLIP_X];
    out.push({
      id: m.id,
      bookId: book.id,
      offsetMs: ms,
      createdAt: typeof m.created === "string" ? m.created : m.t,
      ...(typeof m.modified === "string" ? { modifiedAt: m.modified } : {}),
      note: typeof m.body === "string" ? m.body : "",
      clip: typeof clip === "string" ? clip : (clips.get(m.id) ?? ""),
      ...(text ? { text } : {}),
    });
  }
  return out;
}

/** A mark's `target.text`, when it is whole: claims, two Locators and the words. */
export function highlightText(v: unknown): HighlightText | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Partial<HighlightText>;
  const isLoc = (l: unknown): l is Locator => typeof l === "object" && l !== null && typeof (l as Locator).href === "string";
  if (!Array.isArray(t.ids) || !t.ids.every((x) => typeof x === "string") || !isLoc(t.start) || !isLoc(t.end) || typeof t.quote !== "string") return null;
  return { ids: t.ids, start: t.start, end: t.end, quote: t.quote };
}
