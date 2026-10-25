import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { bookId } from "../../../src/core/bookid.ts";
import { bytesToRows, int, num, rowsToBytes, type Row } from "../../../src/core/csv.ts";
import { HEARD_FIELDS, heardFromRows, heardRows, mergeHeard, TRANSCRIPT_FIELDS, transcriptFromRows, transcriptRows, type Transcript } from "../../../src/core/reading/narration.ts";
import { untranscribed } from "../../../src/core/reading/transcript.ts";
import type { ScannedBook } from "../../../src/core/scan/scan.ts";
import type { SilenceRange } from "../../../src/core/types.ts";
import { bookDir, type StoredAnalysis } from "./books.ts";
import { readStored, writeStored } from "./prepare.ts";

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
 * Find a book's records. They're named by its id in the library they were
 * made in (bookId: its path there and its audio's size), and that library
 * may be the folder being added, one inside it, or one above it: each
 * folder from the book's own up is tried, with the id the book would have
 * had in it.
 */
export async function findRecords(root: string, book: ScannedBook): Promise<FoundRecords | null> {
  if (book.files.length === 0) return null;
  const audioBytes = book.files.reduce((s, f) => s + f.sizeBytes, 0);
  const full = path.join(root, ...book.book.path.split("/"));
  const isFile = book.files.length === 1 && book.files[0]!.path === book.book.path;
  let dir = isFile ? path.dirname(full) : full;
  const top = path.resolve(root, ...Array<string>(ABOVE).fill(".."));
  for (;;) {
    const id = bookId(path.relative(dir, full).split(path.sep).join("/"), audioBytes);
    const ribbon = path.join(dir, ".ribbon");
    for (const kind of [...CARRIED, "loudness", "silence"]) {
      if (await exists(path.join(ribbon, kind, `${id}.csv`))) return { dir: ribbon, id };
    }
    if (dir === top || path.dirname(dir) === dir) return null;
    dir = path.dirname(dir);
  }
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

/** Write a book's record beside it and move it into place, unless it already holds exactly this. */
async function replace(file: string, bytes: Uint8Array): Promise<void> {
  const before = await readFile(file).catch(() => null);
  if (before && Buffer.compare(before, bytes) === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, bytes);
  await rename(`${file}.tmp`, file);
}

/** The book's records list `kind`, read again just before it's written: other jobs write the book's record too. */
async function listRecord(dataDir: string, id: string, kind: HeardKind): Promise<void> {
  const stored = await readStored(dataDir, id);
  if (stored && !stored.records?.includes(kind)) await writeStored(dataDir, id, { ...stored, records: [...(stored.records ?? []), kind] });
}

/** Each book's last write to its records, so the next one merges with what it wrote. */
const writing = new Map<string, Promise<unknown>>();

/** Run `work` once every earlier write to the book's records has finished. */
function inTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
  const mine = (writing.get(id) ?? Promise.resolve()).then(work, work);
  writing.set(id, mine.catch(() => undefined));
  return mine;
}

/** The rows of one of a stored book's heard records: its file, whatever `book.json` lists, so a list written over by another job never loses one. */
export async function recordRows(dataDir: string, id: string, kind: HeardKind): Promise<Row[]> {
  const bytes = await readFile(path.join(bookDir(dataDir, id), "records", `${kind}.csv`)).catch(() => null);
  return bytes ? (await bytesToRows(new Uint8Array(bytes))).rows : [];
}

/**
 * Add rows to a stored book's record of moments heard, merged with what it
 * has, so everything every device heard stays. Rows that aren't times and
 * places are left out and counted. One write at a time per book; a write
 * that adds nothing changes nothing. Null when there's no such book.
 */
export async function keepHeard(dataDir: string, id: string, rows: readonly Row[]): Promise<{ kept: number; refused: number } | null> {
  const fine = rows.filter((r) => holds("heard", r));
  return inTurn(id, async () => {
    if (!(await readStored(dataDir, id))) return null;
    const file = path.join(bookDir(dataDir, id), "records", "heard.csv");
    const before = await readFile(file).catch(() => null);
    await replace(file, await merged(before ? (await bytesToRows(new Uint8Array(before))).rows : [], fine));
    await listRecord(dataDir, id, "heard");
    return { kept: fine.length, refused: rows.length - fine.length };
  });
}

/**
 * A book's transcript, as a device that transcribed all of its narration
 * sends it: kept in place of what the book had, whole or not at all, so a
 * book's transcript is always one device's, start to end (#152). The
 * minutes it's missing when it isn't whole; null when there's no such book.
 */
export async function keepTranscript(dataDir: string, id: string, rows: readonly Row[], place: Placer | null = null): Promise<{ missing: number } | null> {
  return inTurn(id, async () => {
    const stored = await readStored(dataDir, id);
    if (!stored) return null;
    const transcript = transcriptFromRows(rows.filter((r) => holds("aligned", r)));
    const missing = untranscribed(stored.files, transcript.spans).length;
    if (missing > 0) return { missing };
    await keepPlaced(dataDir, id, transcript, place);
    await listRecord(dataDir, id, "aligned");
    return { missing: 0 };
  });
}

/**
 * Where a transcript's phrases are in the book's text, found by what was said
 * (place.ts), with the version of placing that found them; null when the book
 * can't be placed (its EPUB can't be read), and it's kept as it came.
 */
export type Placer = (transcript: Transcript) => Promise<{ transcript: Transcript; how: number } | null>;

/** A whole transcript kept, placed first when it can be, and the book noted as placed that way. */
async function keepPlaced(dataDir: string, id: string, transcript: Transcript, place: Placer | null): Promise<void> {
  const placed = place ? await place(transcript) : null;
  await replace(path.join(bookDir(dataDir, id), "records", "aligned.csv"), await rowsToBytes(transcriptRows(placed?.transcript ?? transcript), TRANSCRIPT_FIELDS));
  const stored = await readStored(dataDir, id);
  if (stored && placed) await writeStored(dataDir, id, { ...stored, placed: placed.how });
}

/** A transcript kept before it was placed by what was said, placed now (place.ts): false when it couldn't be. */
export async function placeKept(dataDir: string, id: string, place: Placer): Promise<boolean> {
  return inTurn(id, async () => {
    const rows = await recordRows(dataDir, id, "aligned");
    if (rows.length === 0) return false;
    const placed = await place(transcriptFromRows(rows));
    if (!placed) return false;
    await keepPlaced(dataDir, id, placed.transcript, async () => placed);
    return true;
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
  return {
    loudness: { integratedLufs: num(l.integrated_lufs), truePeakDbtp: l.true_peak_dbtp ? num(l.true_peak_dbtp) : null },
    silence: [...byFile].map(([file, ranges]) => ({ file, ranges })),
  };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
