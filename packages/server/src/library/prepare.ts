import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Host } from "@ribbon/core/host";
import { analyzeFiles, type BookAnalysis } from "@ribbon/core/analysis";
import { nothingMeasured } from "@ribbon/core/loudness";
import { bookDir, type BookIndex, type StoredAnalysis, type StoredBook } from "./books.ts";

/** A book's loudness and silences as `book.json` keeps them: plain JSON, the silences by the file's place in the book. */
export function storedAnalysis(a: BookAnalysis): StoredAnalysis {
  return { loudness: a.loudness, silence: [...a.silence].map(([file, ranges]) => ({ file, ranges })) };
}

/** Measure a stored book's loudness and find its silences, from the server's own copy of its audio. */
export async function analyzeStored(host: Host, dir: string, book: StoredBook): Promise<StoredAnalysis | null> {
  const done = await analyzeFiles(
    host,
    book.files.map((f) => ({ absPath: path.join(dir, ...f.path.split("/")), durationMs: f.durationMs })),
  );
  return done && storedAnalysis(done);
}

/** How preparing the books already here is going. */
export interface PrepareProgress {
  books: number;
  done: number;
  current: string | null;
}

/**
 * Whether a book wants measuring: it never was (added before the server measured books), or it was
 * measured as nothing, by an ffmpeg that refused the scan (#228). One that can't be measured at all
 * keeps no loudness and isn't tried again.
 */
export function unmeasured(stored: StoredBook): boolean {
  return !stored.analysis || nothingMeasured(stored.analysis.loudness);
}

/** The books with audio that want measuring (`unmeasured`). */
export async function booksToPrepare(dataDir: string, index: BookIndex): Promise<string[]> {
  const out: string[] = [];
  for (const b of index.list()) {
    if (!b.audio) continue;
    const stored = await readStored(dataDir, b.id);
    if (stored && unmeasured(stored)) out.push(b.id);
  }
  return out;
}

/**
 * Measure each book that hasn't been yet, once (docs/SERVER.md, section 9):
 * its loudness and silences go into its `book.json`, and every device gets
 * them with the book rather than working them out itself.
 */
export async function prepareBooks(host: Host, dataDir: string, ids: readonly string[], report: (p: PrepareProgress) => void): Promise<PrepareProgress> {
  const progress: PrepareProgress = { books: ids.length, done: 0, current: null };
  for (const id of ids) {
    const stored = await readStored(dataDir, id);
    if (stored && unmeasured(stored)) {
      progress.current = stored.book.title;
      report(progress);
      try {
        const analysis = await analyzeStored(host, bookDir(dataDir, id), stored);
        if (analysis) await writeStored(dataDir, id, { ...stored, analysis });
      } catch (e) {
        // Deleted while it was measured: nothing to keep, and the rest go on.
        if (await readStored(dataDir, id)) throw e;
      }
    }
    progress.done++;
    report(progress);
  }
  progress.current = null;
  return progress;
}

export async function readStored(dataDir: string, id: string): Promise<StoredBook | null> {
  return readFile(path.join(bookDir(dataDir, id), "book.json"), "utf8")
    .then((t) => JSON.parse(t) as StoredBook)
    .catch(() => null);
}

/** Written beside and moved into place, so a book's record is never half written. */
export async function writeStored(dataDir: string, id: string, stored: StoredBook): Promise<void> {
  const file = path.join(bookDir(dataDir, id), "book.json");
  await writeFile(`${file}.tmp`, JSON.stringify(stored, null, 2));
  await rename(`${file}.tmp`, file);
}
