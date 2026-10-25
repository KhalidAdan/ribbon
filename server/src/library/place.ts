import { wordIndex } from "../../../src/core/reading/anchors.ts";
import { BookText } from "../../../src/core/reading/booktext.ts";
import { placeTranscript } from "../../../src/core/reading/placing.ts";
import type { BookIndex } from "./books.ts";
import { readStored } from "./prepare.ts";
import { placeKept, type Placer } from "./records.ts";
import type { ReadAlongs } from "./readalong.ts";

/**
 * Every book's transcript placed in its text by what was said in it (#163,
 * src/core/reading/placing.ts): a phrase found wherever it is in the book,
 * not only near where its chapter was thought to be. A transcript is placed
 * as it comes in (`PUT /api/books/:id/transcript`), and each one kept before
 * is placed once, in the background, when the server starts. Devices take
 * the server's transcript, so every one reads along from the same places.
 */

/** Changed when the way transcripts are placed changes, so every one is placed again. */
export const PLACING = 1;

/** How placing the books' transcripts is going. */
export interface PlaceProgress {
  books: number;
  done: number;
  placed: number;
  current: string | null;
}

/** Placing a book's transcript in its text, from its EPUB as `ribbon-ebook` reads it. */
export function placerFor(readAlongs: ReadAlongs, dataDir: string, id: string): Placer {
  return async (transcript) => {
    const stored = await readStored(dataDir, id);
    const ebook = stored?.book.ebook ? await readAlongs.ebook(id, stored).catch(() => null) : null;
    if (!ebook) return null;
    return { transcript: { ...transcript, said: placeTranscript(wordIndex(new BookText(ebook)), transcript.said) }, how: PLACING };
  };
}

/** The books with a transcript not yet placed the way placing is done now. */
export async function booksToPlace(dataDir: string, index: BookIndex): Promise<string[]> {
  const out: string[] = [];
  for (const b of index.list()) {
    if (!b.ebook) continue;
    const stored = await readStored(dataDir, b.id);
    if (stored?.records?.includes("aligned") && stored.placed !== PLACING) out.push(b.id);
  }
  return out;
}

/** Place each book's transcript, one at a time. A book deleted meanwhile is passed over. */
export async function placeBooks(readAlongs: ReadAlongs, dataDir: string, ids: readonly string[], report: (p: PlaceProgress) => void): Promise<PlaceProgress> {
  const progress: PlaceProgress = { books: ids.length, done: 0, placed: 0, current: null };
  for (const id of ids) {
    const stored = await readStored(dataDir, id);
    if (stored) {
      progress.current = stored.book.title;
      report({ ...progress });
      if (await placeKept(dataDir, id, placerFor(readAlongs, dataDir, id))) progress.placed++;
    }
    progress.done++;
  }
  progress.current = null;
  report({ ...progress });
  return progress;
}
