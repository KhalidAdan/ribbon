import type { AudioFile, Book, Chapter } from "../types";
import { bytesToRows, rowsToBytes, int, num, bool, type Row } from "../csv";

export const LIBRARY_HEADERS = [
  "id",
  "path",
  "title",
  "raw_title",
  "author",
  "narrator",
  "series",
  "series_index",
  "year",
  "cover",
  "duration_ms",
  "size_bytes",
  "file_count",
];

export const FILE_HEADERS = ["book_id", "order", "path", "duration_ms", "size_bytes", "mtime_ms", "title", "disc", "track", "has_cover", "chapters"];

export const CHAPTER_HEADERS = ["index", "start_ms", "end_ms", "title"];

export function booksToBytes(books: readonly Book[]): Promise<Uint8Array> {
  return rowsToBytes(
    books.map((b) => ({
      id: b.id,
      path: b.path,
      title: b.title,
      raw_title: b.rawTitle,
      author: b.author,
      narrator: b.narrator,
      series: b.series,
      series_index: b.seriesIndex === null ? "" : String(b.seriesIndex),
      year: b.year === null ? "" : String(b.year),
      cover: b.cover,
      duration_ms: String(b.durationMs),
      size_bytes: String(b.sizeBytes),
      file_count: String(b.fileCount),
    })),
    LIBRARY_HEADERS,
  );
}

export async function bytesToBooks(bytes: Uint8Array): Promise<Book[]> {
  const { rows } = await bytesToRows(bytes);
  return rows
    .filter((r) => r.id && r.path)
    .map((r) => ({
      id: r.id!,
      path: r.path!,
      title: r.title ?? "",
      rawTitle: r.raw_title ?? "",
      author: r.author ?? "",
      narrator: r.narrator ?? "",
      series: r.series ?? "",
      seriesIndex: r.series_index ? num(r.series_index) : null,
      year: r.year ? int(r.year) : null,
      cover: r.cover ?? "",
      durationMs: int(r.duration_ms),
      sizeBytes: int(r.size_bytes),
      fileCount: int(r.file_count),
    }));
}

/** Embedded chapters are packed into one cell as `start:end:title|...` with `|` and `:` escaped. */
function packChapters(chapters: readonly Chapter[]): string {
  return chapters.map((c) => `${c.startMs}:${c.endMs}:${c.title.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/:/g, "\\:")}`).join("|");
}

function unpackChapters(cell: string | undefined): Chapter[] {
  if (!cell) return [];
  const out: Chapter[] = [];
  for (const part of splitEscaped(cell, "|")) {
    const [s, e, ...rest] = splitEscaped(part, ":");
    const startMs = int(s);
    const endMs = int(e);
    if (endMs > startMs) out.push({ startMs, endMs, title: unescapeCell(rest.join(":")) });
  }
  return out;
}

function splitEscaped(text: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      cur += ch + text[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function unescapeCell(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

export function filesToRows(bookId: string, files: readonly AudioFile[]): Row[] {
  return files.map((f) => ({
    book_id: bookId,
    order: String(f.order),
    path: f.path,
    duration_ms: String(f.durationMs),
    size_bytes: String(f.sizeBytes),
    mtime_ms: String(f.mtimeMs),
    title: f.title,
    disc: String(f.disc),
    track: String(f.track),
    has_cover: f.hasCover ? "1" : "0",
    chapters: packChapters(f.chapters),
  }));
}

export function filesToBytes(rows: readonly Row[]): Promise<Uint8Array> {
  return rowsToBytes(rows, FILE_HEADERS);
}

export async function bytesToFiles(bytes: Uint8Array): Promise<Map<string, AudioFile[]>> {
  const { rows } = await bytesToRows(bytes);
  const out = new Map<string, AudioFile[]>();
  for (const r of rows) {
    if (!r.book_id || !r.path) continue;
    const list = out.get(r.book_id) ?? [];
    list.push({
      path: r.path,
      order: int(r.order),
      durationMs: int(r.duration_ms),
      sizeBytes: int(r.size_bytes),
      mtimeMs: int(r.mtime_ms),
      title: r.title ?? "",
      disc: int(r.disc, 1),
      track: int(r.track),
      hasCover: bool(r.has_cover),
      chapters: unpackChapters(r.chapters),
    });
    out.set(r.book_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.order - b.order);
  return out;
}

export function chaptersToBytes(chapters: readonly Chapter[]): Promise<Uint8Array> {
  return rowsToBytes(
    chapters.map((c, i) => ({ index: String(i), start_ms: String(c.startMs), end_ms: String(c.endMs), title: c.title })),
    CHAPTER_HEADERS,
  );
}

export async function bytesToChapters(bytes: Uint8Array): Promise<Chapter[]> {
  const { rows } = await bytesToRows(bytes);
  return rows
    .map((r) => ({ startMs: int(r.start_ms), endMs: int(r.end_ms), title: r.title ?? "" }))
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** True when a previously recorded file no longer matches what is on disk. */
export function isStale(recorded: Pick<AudioFile, "sizeBytes" | "mtimeMs">, onDisk: { sizeBytes: number; mtimeMs: number }): boolean {
  return recorded.sizeBytes !== onDisk.sizeBytes || Math.abs(recorded.mtimeMs - onDisk.mtimeMs) > 1000;
}
