import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { bookId } from "../../../src/core/bookid.ts";
import { bytesToRows, int, num } from "../../../src/core/csv.ts";
import type { ScannedBook } from "../../../src/core/scan/scan.ts";
import type { SilenceRange } from "../../../src/core/types.ts";
import type { StoredAnalysis } from "./books.ts";

/**
 * The records a book keeps beside it in its folder's `.ribbon/` that the
 * server carries in with it, one file each: what Ribbon worked out about
 * the book (its chapters, hand corrections, what it heard of the narration
 * and how that lines up with the text, pairing fixes), so no device works
 * it out again. Loudness and silences come in as the book's measurements
 * (`carriedAnalysis`).
 */
export const CARRIED = ["chapters", "corrections", "heard", "aligned", "pairing"] as const;

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
