import { randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bookDir, type BookIndex, type StoredBook } from "./books.ts";

/**
 * A book's folder on the server, written one thing at a time.
 *
 * Many things write there: the jobs that work out more about a book (its
 * loudness, its chapter names, a description, where its transcript's
 * phrases are), devices sending what they heard or a whole transcript, the
 * admin choosing a cover, the EPUB and MP3 tools keeping what they read, a
 * folder added again bringing records or an EPUB, and the admin deleting
 * the book. Each takes the book's turn (`inTurn`), and while it has it,
 * nothing else writes there:
 *
 *     listed ──its turn──▶ written ──▶ listed
 *       │
 *       └──deleted, in its turn──▶ gone: every turn after finds no book and writes nothing
 *
 * So its record, `book.json`, is changed in one step, on the record as it
 * is then (`BookInTurn.change`), never written back from a copy read before
 * slow work: each job changes only what it worked out, and keeps what the
 * others kept meanwhile. And once a book is deleted, nothing writes into
 * its folder again, so nothing is left there to stand in the way of the
 * book being added again.
 *
 * Slow work (measuring loudness, placing a transcript's phrases) is done
 * before the turn, and only what it found is kept in it, so a turn is
 * short and a delete never waits long. A turn never waits on a turn of the
 * same book: it would be waiting on itself.
 */

/** A book's folder in its turn: its record as it is now, and the one way to change it. */
export interface BookInTurn {
  readonly dir: string;
  /** Its record as it is now; null when the book isn't here (deleted, or not added yet). */
  stored(): Promise<StoredBook | null>;
  /**
   * Change its record: `change` is given it as it is now, and what it
   * returns is kept in its place (the same record back keeps it as it is).
   * The record kept; null, and nothing written, when the book isn't here.
   */
  change(change: (now: StoredBook) => StoredBook): Promise<StoredBook | null>;
}

/** The last turn asked for in each book's folder, by the folder: the next one waits for it. Gone once nothing waits. */
const turns = new Map<string, Promise<void>>();

/** Run `work` in the book's turn: once every write into its folder asked for before has finished, and before any asked for after. */
export function inTurn<T>(dataDir: string, id: string, work: (book: BookInTurn) => Promise<T>): Promise<T> {
  const dir = bookDir(dataDir, id);
  const book: BookInTurn = {
    dir,
    stored: () => readRecord(dir),
    change: async (change) => {
      const now = await readRecord(dir);
      if (!now) return null;
      const next = change(now);
      if (next !== now) await writeRecord(dir, next);
      return next;
    },
  };
  const mine = (turns.get(dir) ?? Promise.resolve()).then(() => work(book));
  // A turn that fails is still over: the next one goes ahead.
  const over = mine.then(
    () => undefined,
    () => undefined,
  );
  turns.set(dir, over);
  void over.then(() => {
    if (turns.get(dir) === over) turns.delete(dir);
  });
  return mine;
}

/** A book's record as it is now, or null when the book isn't here. Reading needs no turn: a record is always whole (`writeRecord`). */
export function readStored(dataDir: string, id: string): Promise<StoredBook | null> {
  return readRecord(bookDir(dataDir, id));
}

/** Change a book's record in its turn (`BookInTurn.change`). */
export function changeStored(dataDir: string, id: string, change: (now: StoredBook) => StoredBook): Promise<StoredBook | null> {
  return inTurn(dataDir, id, (book) => book.change(change));
}

/**
 * Take a deleted book's folder away, in its turn: whatever was writing
 * there finishes first, and whatever comes after finds no book. It's moved
 * aside in one step, so a book is never half there, and emptied after, so a
 * folder that won't empty never stands in the way of the same book being
 * added again.
 */
export async function removeBookDir(dataDir: string, id: string): Promise<void> {
  const aside = await inTurn(dataDir, id, async (book) => {
    const aside = `${book.dir}.deleting-${randomBytes(4).toString("hex")}`;
    try {
      await rename(book.dir, aside);
      return aside;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  });
  if (aside) await rm(aside, { recursive: true, force: true });
}

/**
 * Every book's records listed as its folder holds them (`records/<kind>.csv`).
 * Until each job changed only its own part of a book's record, one that took
 * minutes could write back the record as it read it, without a transcript
 * kept meanwhile: the admin's devices were told the book was transcribed,
 * and it waited to read along for good. Once, at start. How many books
 * were listed again.
 */
export async function relistRecords(dataDir: string, index: BookIndex): Promise<number> {
  let relisted = 0;
  for (const { id } of index.list()) {
    const held = await readdir(path.join(bookDir(dataDir, id), "records")).catch(() => []);
    const kinds = held.filter((name) => name.endsWith(".csv")).map((name) => name.slice(0, -".csv".length));
    if (kinds.length === 0) continue;
    await changeStored(dataDir, id, (now) => {
      const missing = kinds.filter((kind) => !now.records?.includes(kind));
      if (missing.length === 0) return now;
      relisted++;
      return { ...now, records: [...(now.records ?? []), ...missing] };
    });
  }
  return relisted;
}

async function readRecord(dir: string): Promise<StoredBook | null> {
  return readFile(path.join(dir, "book.json"), "utf8")
    .then((t) => JSON.parse(t) as StoredBook)
    .catch(() => null);
}

/** Written beside and moved into place, so a book's record is never half written. */
async function writeRecord(dir: string, stored: StoredBook): Promise<void> {
  const file = path.join(dir, "book.json");
  await writeFile(`${file}.tmp`, JSON.stringify(stored, null, 2));
  await rename(`${file}.tmp`, file);
}
