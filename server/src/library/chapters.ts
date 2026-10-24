import { readFile } from "node:fs/promises";
import path from "node:path";
import { bytesToRows, rowsToBytes, type Row } from "../../../src/core/csv.ts";
import { applyCorrections, buildChapters, correctionsToRows, rowsToCorrections, CORRECTION_HEADERS, type Correction } from "../../../src/core/scan/chapters.ts";
import type { Chapter } from "../../../src/core/types.ts";
import type { StoredBook } from "./books.ts";

/**
 * A book's chapters as every device has them: the files' own, with the
 * hand corrections carried in from its folder (`records/corrections.csv`,
 * never written here), then the names the server filled in (hydrate.ts,
 * kept in `book.json`). A device that downloads the book is given both as
 * the one corrections record it keeps beside the book, the way the
 * desktop keeps the names it looks up as corrections; a device that keeps
 * nothing (the TV) is given the chapters with both applied.
 */

/** One of the records carried in with a book, as rows; none when it came without it. */
export async function recordRows(dir: string, stored: StoredBook, kind: string): Promise<Row[]> {
  return stored.records?.includes(kind) ? (await bytesToRows(await readFile(path.join(dir, "records", `${kind}.csv`)))).rows : [];
}

/** The corrections made by hand, on a computer, before the book came to the server. */
export async function handCorrections(dir: string, stored: StoredBook): Promise<Correction[]> {
  return rowsToCorrections(await recordRows(dir, stored, "corrections"));
}

/** Someone named a chapter by hand: the book's names are theirs, all of them. */
export function namedByHand(hand: readonly Correction[]): boolean {
  return hand.some((c) => c.op === "rename" || c.op === "titles" || c.op === "insert");
}

/** Every correction a device applies to the book's chapters, in order: the names the server filled in after the hand corrections, and never over a name given by hand. */
export async function correctionsOf(dir: string, stored: StoredBook): Promise<Correction[]> {
  const hand = await handCorrections(dir, stored);
  if (namedByHand(hand)) return hand;
  return [...hand, ...(stored.filled?.chapters ?? []).map(({ index, title }): Correction => ({ op: "rename", index, title }))];
}

/** The book's chapters with these corrections applied, as a device that downloaded it has them. */
export function chaptersWith(stored: StoredBook, corrections: readonly Correction[]): Chapter[] {
  if (corrections.length === 0) return stored.chapters;
  return applyCorrections(buildChapters(stored.files), corrections, stored.book.durationMs, stored.files).chapters;
}

/** The records a device can fetch for the book: the ones carried in, and the corrections when the server named its chapters. */
export function servedRecords(stored: StoredBook): string[] {
  const carried = stored.records ?? [];
  return stored.filled?.chapters?.length && !carried.includes("corrections") ? [...carried, "corrections"] : carried;
}

/** The book as devices are given it (`GET /api/books/:id`): its chapters corrected, and every record they can fetch. */
export async function servedBook(dir: string, stored: StoredBook): Promise<StoredBook> {
  const records = servedRecords(stored);
  return { ...stored, chapters: chaptersWith(stored, await correctionsOf(dir, stored)), ...(records.length > 0 ? { records } : {}) };
}

/** `records/corrections.csv` as devices are given it when the server named the chapters: the hand corrections, then the names (`correctionsOf`). Null otherwise: the file is sent as it is. */
export async function servedCorrections(dir: string, stored: StoredBook): Promise<Uint8Array | null> {
  if (!stored.filled?.chapters?.length) return null;
  return rowsToBytes(correctionsToRows(await correctionsOf(dir, stored)), CORRECTION_HEADERS);
}
