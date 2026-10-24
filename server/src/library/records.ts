import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { bookId } from "../../../src/core/bookid.ts";
import { bytesToRows, int, num, rowsToBytes, type Row } from "../../../src/core/csv.ts";
import { HEARD_FIELDS, heardFromRows, heardRows, mergeHeard, mergeTranscripts, TRANSCRIPT_FIELDS, transcriptFromRows, transcriptRows } from "../../../src/core/reading/narration.ts";
import type { ScannedBook } from "../../../src/core/scan/scan.ts";
import type { SilenceRange } from "../../../src/core/types.ts";
import { bookDir, type StoredAnalysis } from "./books.ts";
import { readStored, writeStored } from "./prepare.ts";

/**
 * The records a book keeps beside it in its folder's `.ribbon/` that the
 * server carries in with it, one file each: what Ribbon worked out about
 * the book (its chapters, hand corrections, what it heard of the narration
 * and how that lines up with the text, pairing fixes), so no device works
 * it out again. Loudness and silences come in as the book's measurements
 * (`carriedAnalysis`).
 */
export const CARRIED = ["chapters", "corrections", "heard", "aligned", "pairing"] as const;

/**
 * The records made by hearing the narration: the words at moments of it
 * (`heard`), and stretches of it transcribed, each phrase placed in the
 * text (`aligned`). Hearing more only ever adds to them, so they're kept
 * merged, never replaced: what a device sent, what came in from a folder,
 * and what the server transcribed itself (transcribe.ts).
 */
export const HEARD = ["heard", "aligned"] as const;
export type HeardKind = (typeof HEARD)[number];

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

/** The rows of one of the records found, or none when it isn't there. */
export async function foundRows(found: FoundRecords, kind: string): Promise<Row[]> {
  return readFile(path.join(found.dir, kind, `${found.id}.csv`)).then(
    async (b) => (await bytesToRows(new Uint8Array(b))).rows,
    () => [],
  );
}

const WHOLE = /^\d+$/;
const WHOLE_OR_NONE = /^\d*$/;

/** Whether a row is one a record of its kind can hold: times and places as whole numbers. */
function holds(kind: HeardKind, r: Row): boolean {
  if (kind === "heard") return WHOLE.test(r.audio_ms ?? "") && WHOLE_OR_NONE.test(r.chars ?? "");
  return WHOLE.test(r.start_ms ?? "") && WHOLE.test(r.end_ms ?? "") && Number(r.start_ms) <= Number(r.end_ms) && WHOLE_OR_NONE.test(r.chars ?? "");
}

/** A heard record with more rows in it, as its file: what it had, and what's new, merged as the apps merge theirs. */
async function merged(kind: HeardKind, had: readonly Row[], more: readonly Row[]): Promise<Uint8Array> {
  if (kind === "heard") {
    const all = mergeHeard(heardFromRows(had), heardFromRows(more));
    return rowsToBytes(heardRows(all.heard, all.anchors), HEARD_FIELDS);
  }
  return rowsToBytes(transcriptRows(mergeTranscripts(transcriptFromRows(had), transcriptFromRows(more))), TRANSCRIPT_FIELDS);
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
 * Add rows to one of a stored book's heard records, merged with what it
 * has, so everything every device and the server heard stays. Rows that
 * aren't times and places are left out and counted. Written beside and
 * moved into place, one write at a time per book; the kind joins the
 * book's records when it isn't listed, and a write that adds nothing
 * changes nothing. Null when there's no such book.
 */
export async function keepHeard(dataDir: string, id: string, kind: HeardKind, rows: readonly Row[]): Promise<{ kept: number; refused: number } | null> {
  const fine = rows.filter((r) => holds(kind, r));
  return inTurn(id, async () => {
    if (!(await readStored(dataDir, id))) return null;
    const file = path.join(bookDir(dataDir, id), "records", `${kind}.csv`);
    const before = await readFile(file).catch(() => null);
    const after = await merged(kind, before ? (await bytesToRows(new Uint8Array(before))).rows : [], fine);
    if (!before || Buffer.compare(before, after) !== 0) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, after);
      await rename(`${file}.tmp`, file);
    }
    // Read again just before it's written: other jobs write the book's record too.
    const stored = await readStored(dataDir, id);
    if (stored && !stored.records?.includes(kind)) await writeStored(dataDir, id, { ...stored, records: [...(stored.records ?? []), kind] });
    return { kept: fine.length, refused: rows.length - fine.length };
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
