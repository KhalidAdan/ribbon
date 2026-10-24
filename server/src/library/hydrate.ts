import { stat } from "node:fs/promises";
import path from "node:path";
import { generatedTitles } from "../../../src/core/chapternames.ts";
import type { Ebook } from "../../../src/core/ebook.ts";
import { BookText } from "../../../src/core/reading/booktext.ts";
import { chapterNamesFromText } from "../../../src/core/reading/narration.ts";
import type { Correction } from "../../../src/core/scan/chapters.ts";
import { xmlText } from "../../../src/core/scan/sidefiles.ts";
import { bookDir, type BookIndex, type FilledIn, type StoredBook } from "./books.ts";
import { chaptersWith, handCorrections, namedByHand } from "./chapters.ts";
import { readStored, writeStored } from "./prepare.ts";
import { narrationOf, ReadAlongError, type ReadAlongs } from "./readalong.ts";

/**
 * Filling in what a book came without. Many books arrive from a folder
 * with chapters their files only number ("Chapter 1" to "Chapter 37", the
 * opening credits counted among them) and no description, though their
 * own EPUB has both:
 *
 * - **The description** is the EPUB's (`dc:description`), when the book has
 *   none.
 * - **Chapter names** come from the EPUB's contents, by pairing its text
 *   with the audio (src/core/chapternames.ts, `namesFromContents`), when
 *   the files only number the chapters.
 *
 * Nothing is asked of anyone else's service (docs/NORTHSTAR.md). Nothing set
 * by hand is replaced: a description is filled in only where there's none,
 * and a book with a chapter named by hand keeps its names. What's filled in
 * is noted in the book's record (`filled`) with what it was worked out
 * from, so it's worked out again when that changes, as when a transcript
 * comes in and confirms more names.
 */

/** Changed when the way books are filled in changes, so every book is looked at again. */
const HOW = 1;

/** How filling in the books is going. */
export interface HydrateProgress {
  books: number;
  done: number;
  /** Books given a description so far, and books given chapter names. */
  described: number;
  named: number;
  current: string | null;
}

/** What a book is filled in from: its EPUB and the records carried in with it. */
export async function hydrateStamp(dir: string, stored: StoredBook): Promise<string> {
  const files = [stored.book.ebook!, ...(stored.records ?? []).map((kind) => `records/${kind}.csv`)];
  const stamps = await Promise.all(files.map((f) => stat(path.join(dir, f)).then((s) => `${s.size}:${s.mtimeMs}`, () => "-")));
  return [HOW, ...stamps].join("|");
}

/**
 * Whether a book may lack what its EPUB can fill in: a description, or
 * names for chapters its files only number. Or it has names filled in that
 * hand corrections carried in since have made someone else's to give.
 */
function lacking(stored: StoredBook, hand: readonly Correction[]): boolean {
  if (!stored.book.ebook) return false;
  const chapters = namedByHand(hand) ? !!stored.filled?.chapters : stored.files.length > 0 && generatedTitles(chaptersWith(stored, hand));
  return !stored.book.description || chapters;
}

/** The books that may lack something and haven't been filled in from what they have now. */
export async function booksToHydrate(dataDir: string, index: BookIndex): Promise<string[]> {
  const out: string[] = [];
  for (const b of index.list()) {
    if (!b.ebook) continue;
    const stored = await readStored(dataDir, b.id);
    if (!stored) continue;
    const dir = bookDir(dataDir, b.id);
    if (lacking(stored, await handCorrections(dir, stored)) && stored.filled?.from !== (await hydrateStamp(dir, stored))) out.push(b.id);
  }
  return out;
}

/** Fill in each book, one at a time. A book deleted meanwhile is passed over. */
export async function hydrateBooks(readAlongs: ReadAlongs, dataDir: string, ids: readonly string[], report: (p: HydrateProgress) => void): Promise<HydrateProgress> {
  const progress: HydrateProgress = { books: ids.length, done: 0, described: 0, named: 0, current: null };
  for (const id of ids) {
    const stored = await readStored(dataDir, id);
    if (stored) {
      progress.current = stored.book.title;
      report(progress);
      try {
        const filled = await hydrateBook(readAlongs, dataDir, id, stored);
        if (filled.description && !stored.filled?.description) progress.described++;
        if (filled.chapters && !stored.filled?.chapters) progress.named++;
      } catch (e) {
        if (await readStored(dataDir, id)) throw e;
      }
    }
    progress.done++;
    report(progress);
  }
  progress.current = null;
  return progress;
}

/** One book: its description and its chapters' names, from its EPUB, where it lacks them. What was filled in. */
export async function hydrateBook(readAlongs: ReadAlongs, dataDir: string, id: string, stored: StoredBook): Promise<FilledIn> {
  const dir = bookDir(dataDir, id);
  const filled: FilledIn = { from: await hydrateStamp(dir, stored) };
  const book = { ...stored.book };
  let ebook: Ebook | null = null;
  try {
    ebook = await readAlongs.ebook(id, stored);
  } catch (e) {
    // An EPUB that can't be read fills in nothing, until it changes.
    if (!(e instanceof ReadAlongError && e.status === 422)) throw e;
  }
  if (ebook) {
    if (stored.filled?.description) filled.description = stored.filled.description;
    else if (!book.description) {
      // Publishers often put HTML in it, escaped once more.
      const description = xmlText(ebook.meta.description ?? "");
      if (description) {
        book.description = description;
        filled.description = "epub";
      }
    }
    const hand = await handCorrections(dir, stored);
    const chapters = chaptersWith(stored, hand);
    if (stored.files.length > 0 && !namedByHand(hand) && generatedTitles(chapters)) {
      const text = new BookText(ebook);
      const names = chapterNamesFromText(text, chapters, book.durationMs, await narrationOf(dir, stored, text));
      if (names.length > 0) filled.chapters = names;
    }
  }
  await writeStored(dataDir, id, { ...stored, book, filled });
  return filled;
}
