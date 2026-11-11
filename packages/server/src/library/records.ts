import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { bookId } from "@ribbon/core/bookid";
import { bytesToRows, int, num, rowsToBytes, type Row } from "@ribbon/core/csv";
import { nothingMeasured } from "@ribbon/core/loudness";
import { HEARD_FIELDS, heardFromRows, heardRows, mergeHeard, TRANSCRIPT_FIELDS, transcriptFromRows, transcriptRows, type Transcript } from "@ribbon/core/reading/narration";
import { untranscribed } from "@ribbon/core/reading/transcript";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import type { SilenceRange } from "@ribbon/core/types";
import { inTurn, readStored, type BookInTurn } from "./book-folder.ts";
import { bookDir, type StoredAnalysis, type StoredBook } from "./books.ts";

/**
 * The records a book keeps beside it in its folder's `.ribbon/` that the
 * server carries in with it, one file each: what people set about the book
 * (its chapters, hand corrections, pairing fixes), so nobody sets it again.
 * Loudness and silences come in as the book's measurements
 * (`carriedAnalysis`). What was heard of the narration doesn't: a folder's
 * transcript may hold clips that failed, kept as if nothing was said in
 * them (#152), so a book's transcript is only ever one a device made whole
 * for the server (`keepTranscript`).
 */
export const CARRIED = ["chapters", "corrections", "pairing"] as const;

/**
 * The records made by hearing the narration: the words at moments of it
 * (`heard`), and the whole narration transcribed, each phrase placed in the
 * text (`aligned`).
 */
export type HeardKind = "heard" | "aligned";

/** What a device sends of what it heard at moments of the narration: hearing more only adds to it, so it's kept merged, never replaced. */
export const HEARD = ["heard"] as const;

/** How many folders above the one being added to look for a book's records: it may have been part of a larger library. */
const ABOVE = 3;

/** Where a book's records are: the `.ribbon` folder that holds them, and the book's id there. */
export interface FoundRecords {
  dir: string;
  id: string;
}

/**
 * The libraries a book may have been kept in, nearest first. What Ribbon
 * kept about it is named by its id in that library (bookId: its path there
 * and its size), and that library may be the folder being added, one inside
 * it, or one above it: each folder from the book's own up is one, with the
 * id the book would have had in it.
 */
export function librariesOf(root: string, book: ScannedBook): FoundRecords[] {
  const bytes = book.files.length > 0 ? book.files.reduce((s, f) => s + f.sizeBytes, 0) : book.book.sizeBytes;
  const full = path.join(root, ...book.book.path.split("/"));
  const isFile = book.book.path === book.book.ebook || (book.files.length === 1 && book.files[0]!.path === book.book.path);
  const libraries: FoundRecords[] = [];
  let dir = isFile ? path.dirname(full) : full;
  const top = path.resolve(root, ...Array<string>(ABOVE).fill(".."));
  for (;;) {
    libraries.push({ dir: path.join(dir, ".ribbon"), id: bookId(path.relative(dir, full).split(path.sep).join("/"), bytes) });
    if (dir === top || path.dirname(dir) === dir) return libraries;
    dir = path.dirname(dir);
  }
}

/** Find a book's records: the nearest of its libraries that holds any. */
export async function findRecords(root: string, book: ScannedBook): Promise<FoundRecords | null> {
  if (book.files.length === 0) return null;
  for (const library of librariesOf(root, book)) {
    for (const kind of [...CARRIED, "loudness", "silence"]) {
      if (await exists(path.join(library.dir, kind, `${library.id}.csv`))) return library;
    }
  }
  return null;
}

/** Copy the records found into the book's `records/` folder, the kinds it hasn't got yet. The kinds it has now. */
export async function carryRecords(found: FoundRecords, bookDir: string, have: readonly string[]): Promise<string[]> {
  const now = [...have];
  for (const kind of CARRIED) {
    if (now.includes(kind)) continue;
    const from = path.join(found.dir, kind, `${found.id}.csv`);
    if (!(await exists(from))) continue;
    await mkdir(path.join(bookDir, "records"), { recursive: true });
    await copyFile(from, path.join(bookDir, "records", `${kind}.csv`));
    now.push(kind);
  }
  return now;
}

const WHOLE = /^\d+$/;
const WHOLE_OR_NONE = /^\d*$/;

/** Whether a row is one a record of its kind can hold: times and places as whole numbers. */
function holds(kind: HeardKind, r: Row): boolean {
  if (kind === "heard") return WHOLE.test(r.audio_ms ?? "") && WHOLE_OR_NONE.test(r.chars ?? "");
  return WHOLE.test(r.start_ms ?? "") && WHOLE.test(r.end_ms ?? "") && Number(r.start_ms) <= Number(r.end_ms) && WHOLE_OR_NONE.test(r.chars ?? "");
}

/** A heard record with more rows in it, as its file: what it had, and what's new, merged as the apps merge theirs. */
async function merged(had: readonly Row[], more: readonly Row[]): Promise<Uint8Array> {
  const all = mergeHeard(heardFromRows(had), heardFromRows(more));
  return rowsToBytes(heardRows(all.heard, all.anchors), HEARD_FIELDS);
}

/** Write one of a book's records beside it and move it into place, unless it already holds exactly this. In the book's turn. */
async function replace(book: BookInTurn, kind: HeardKind, bytes: Uint8Array): Promise<void> {
  const file = path.join(book.dir, "records", `${kind}.csv`);
  const before = await readFile(file).catch(() => null);
  if (before && Buffer.compare(before, bytes) === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, bytes);
  await rename(`${file}.tmp`, file);
}

/** The book's record with `kind` among its records: what devices fetch, and what its read-along is made from. */
function listing(kind: HeardKind): (now: StoredBook) => StoredBook {
  return (now) => (now.records?.includes(kind) ? now : { ...now, records: [...(now.records ?? []), kind] });
}

/**
 * Add rows to a stored book's record of moments heard, merged with what it
 * has, so everything every device heard stays. Rows that aren't times and
 * places are left out and counted. In the book's turn (book-folder.ts), so
 * each write merges with the one before; a write that adds nothing changes
 * nothing. Null when there's no such book.
 */
export async function keepHeard(dataDir: string, id: string, rows: readonly Row[]): Promise<{ kept: number; refused: number } | null> {
  const fine = rows.filter((r) => holds("heard", r));
  return inTurn(dataDir, id, async (book) => {
    if (!(await book.stored())) return null;
    const before = await readFile(path.join(book.dir, "records", "heard.csv")).catch(() => null);
    await replace(book, "heard", await merged(before ? (await bytesToRows(new Uint8Array(before))).rows : [], fine));
    await book.change(listing("heard"));
    return { kept: fine.length, refused: rows.length - fine.length };
  });
}

/**
 * A book's transcript, as a device that transcribed all of its narration
 * sends it: kept in place of what the book had, whole or not at all, so a
 * book's transcript is always one device's, start to end (#152). Its
 * phrases are placed in the book's text first, which takes a moment, then
 * it's kept in the book's turn: a book deleted meanwhile keeps nothing. The
 * minutes it's missing when it isn't whole; null when there's no such book.
 */
export async function keepTranscript(dataDir: string, id: string, rows: readonly Row[], place: Placer | null = null): Promise<{ missing: number } | null> {
  const stored = await readStored(dataDir, id);
  if (!stored) return null;
  const transcript = transcriptFromRows(rows.filter((r) => holds("aligned", r)));
  const missing = untranscribed(stored.files, transcript.spans).length;
  if (missing > 0) return { missing };
  const placed = place ? await place(transcript) : null;
  const kept = await inTurn(dataDir, id, (book) => keepWhole(book, placed?.transcript ?? transcript, placed?.how ?? null));
  return kept ? { missing: 0 } : null;
}

/**
 * Where a transcript's phrases are in the book's text, found by what was said
 * (place.ts), with the version of placing that found them; null when the book
 * can't be placed (its EPUB can't be read), and it's kept as it came.
 */
export type Placer = (transcript: Transcript) => Promise<{ transcript: Transcript; how: number } | null>;

/**
 * A whole transcript kept in place of the book's, and the book noted as
 * placed the way its phrases were found (`how`), when they were. In the
 * book's turn; false when the book isn't here.
 */
async function keepWhole(book: BookInTurn, transcript: Transcript, how: number | null): Promise<boolean> {
  if (!(await book.stored())) return false;
  await replace(book, "aligned", await rowsToBytes(transcriptRows(transcript), TRANSCRIPT_FIELDS));
  await book.change((now) => listing("aligned")(how === null ? now : { ...now, placed: how }));
  return true;
}

/**
 * A transcript kept before it was placed by what was said, placed now
 * (place.ts). False when it couldn't be, or when another came in while it
 * was placed: that one was placed as it came, and stays.
 */
export async function placeKept(dataDir: string, id: string, place: Placer): Promise<boolean> {
  const stored = await readStored(dataDir, id);
  const file = path.join(bookDir(dataDir, id), "records", "aligned.csv");
  const before = stored?.records?.includes("aligned") ? await readFile(file).catch(() => null) : null;
  if (!before) return false;
  const placed = await place(transcriptFromRows((await bytesToRows(new Uint8Array(before))).rows));
  if (!placed) return false;
  return inTurn(dataDir, id, async (book) => {
    const now = await readFile(file).catch(() => null);
    if (!now || Buffer.compare(now, before) !== 0) return false;
    return keepWhole(book, placed.transcript, placed.how);
  });
}

/** The book's loudness and silences from its records, when both are there: measured before, so not measured again. */
export async function carriedAnalysis(found: FoundRecords): Promise<StoredAnalysis | null> {
  const read = (kind: string) => readFile(path.join(found.dir, kind, `${found.id}.csv`)).then((b) => bytesToRows(new Uint8Array(b)), () => null);
  const [loudness, silence] = await Promise.all([read("loudness"), read("silence")]);
  const l = loudness?.rows[0];
  if (!l || !l.integrated_lufs || !silence) return null;
  const byFile = new Map<number, SilenceRange[]>();
  for (const r of silence.rows) {
    const file = int(r.file_index);
    byFile.set(file, [...(byFile.get(file) ?? []), { startMs: int(r.start_ms), endMs: int(r.end_ms) }]);
  }
  const measured = { integratedLufs: num(l.integrated_lufs), truePeakDbtp: l.true_peak_dbtp ? num(l.true_peak_dbtp) : null };
  // A device's copy of a reading that measured nothing (#228): measured here instead.
  if (nothingMeasured(measured)) return null;
  return { loudness: measured, silence: [...byFile].map(([file, ranges]) => ({ file, ranges })) };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
