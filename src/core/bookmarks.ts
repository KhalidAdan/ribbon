import type { Bookmark } from "./types";
import { bytesToRows, rowsToBytes, int, type ParseReport } from "./csv";

export const BOOKMARK_HEADERS = ["book_id", "offset_ms", "created_at", "note", "clip"];
export const CLIP_MS = 30_000;

export function serializeBookmarks(list: readonly Bookmark[]): Promise<Uint8Array> {
  const sorted = [...list].sort((a, b) => a.offsetMs - b.offsetMs);
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
    bookmarks.push({
      bookId: row.book_id,
      offsetMs: Math.max(0, int(row.offset_ms)),
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
