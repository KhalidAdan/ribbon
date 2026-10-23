import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Host } from "../../../src/host/host.ts";
import { analyzeFiles, type BookAnalysis } from "../../../src/core/analysis.ts";
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

/** The books with audio that haven't been measured yet: added before the server measured them. */
export async function booksToPrepare(dataDir: string, index: BookIndex): Promise<string[]> {
  const out: string[] = [];
  for (const b of index.list()) {
    if (!b.audio) continue;
    const stored = await readStored(dataDir, b.id);
    if (stored && !stored.analysis) out.push(b.id);
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
    if (stored && !stored.analysis) {
      progress.current = stored.book.title;
      report(progress);
      const analysis = await analyzeStored(host, bookDir(dataDir, id), stored);
      if (analysis) await writeStored(dataDir, id, { ...stored, analysis });
    }
    progress.done++;
    report(progress);
  }
  progress.current = null;
  return progress;
}

async function readStored(dataDir: string, id: string): Promise<StoredBook | null> {
  return readFile(path.join(bookDir(dataDir, id), "book.json"), "utf8")
    .then((t) => JSON.parse(t) as StoredBook)
    .catch(() => null);
}

/** Written beside and moved into place, so a book's record is never half written. */
async function writeStored(dataDir: string, id: string, stored: StoredBook): Promise<void> {
  const file = path.join(bookDir(dataDir, id), "book.json");
  await writeFile(`${file}.tmp`, JSON.stringify(stored, null, 2));
  await rename(`${file}.tmp`, file);
}
