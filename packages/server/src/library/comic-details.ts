import { movedComicEdits } from "@ribbon/core/comic-edits";
import { namedComic } from "@ribbon/core/comic-name";
import { parseComicInfo, type ComicInfo } from "@ribbon/core/comic/comicinfo";
import { comicInfoEntry } from "@ribbon/core/comic/pages";
import { comicFromFiles } from "@ribbon/core/scan/comics";
import type { EditValues } from "@ribbon/core/edits";
import type { Book } from "@ribbon/core/types";
import { comicEntries, comicEntry } from "@ribbon/host-node/comic";
import { changeStored, readStored } from "./book-folder.ts";
import { bookDir, type BookIndex } from "./books.ts";
import { comicPath, PDF_FILE } from "./comic.ts";

/**
 * A comic's own details on a server (docs/BOOK-DETAILS.md, sections 4 and
 * 6). A comic added since keeps them as its scan found them. A comic added
 * before kept an audiobook's: its whole name as its title ("Saga #14"), its
 * issue or volume as its number in the series, and its writers as its
 * author. Once, when the server starts, each of those is brought into the
 * shape a comic has now:
 *
 * 1. **Its file is read again**: its ComicInfo.xml, out of its `book.cbz`,
 *    in full this time, and what its file's name said read back from its
 *    record, since the name is gone (`comicAgain`). Its `book.json` is
 *    written in the new shape, in the book's turn.
 * 2. **Its edits are moved** into its own details (`movedComicEdits`,
 *    packages/core/src/comic-edits.ts): "Transformers #10" as a title,
 *    which the shelf now makes from the series and the issue, is dropped;
 *    "Transformers Vol. 1 (#1–#6)" is volume 1, collecting "1–6".
 * 3. **It is listed again**, named from its details as edited, with its
 *    details in the book table: every comic in one transaction, with its
 *    edits as they were kept beside the moved ones.
 *
 * The book table's `details`, null until then, says which comics are still
 * to do, so a start that stops halfway does the rest on the next. A comic
 * whose file can't be read is left as it was, and tried again next time.
 * Reading a comic again is the same whether it was read before or not: a
 * `book.json` already written in the new shape comes back as it is.
 */

/** How reading the comics again went: how many were, how many of their edits moved, and the ones whose file couldn't be read. */
export interface ReadAgain {
  read: number;
  moved: number;
  unreadable: string[];
}

/** Read every comic added before comics had details of their own again, and move its edits (above). */
export async function readComicsAgain(dataDir: string, index: BookIndex): Promise<ReadAgain> {
  const done: ReadAgain = { read: 0, moved: 0, unreadable: [] };
  const again: { id: string; book: Book; moved: EditValues | null }[] = [];
  for (const id of index.comicsToReadAgain()) {
    const stored = await readStored(dataDir, id);
    if (!stored?.book.comic) continue;
    let info: ComicInfo | undefined;
    try {
      // A PDF has no ComicInfo.xml: what it says of itself is all in its record.
      info = stored.book.comic === PDF_FILE ? undefined : await comicInfoOf(comicPath(bookDir(dataDir, id)));
    } catch {
      done.unreadable.push(id);
      continue;
    }
    const kept = await changeStored(dataDir, id, (now) => ({ ...now, book: comicAgain(now.book, info) }));
    if (!kept) continue;
    const edits = index.edits(id)?.values ?? null;
    const moved = edits ? movedComicEdits(edits, kept.book) : null;
    if (edits && moved && !sameEdits(edits, moved)) done.moved++;
    again.push({ id, book: kept.book, moved });
    done.read++;
  }
  if (again.length > 0) index.readAgain(again);
  return done;
}

/** Whether two sets of edits say the same, in whatever order their fields come. */
function sameEdits(a: EditValues, b: EditValues): boolean {
  const keys = Object.keys(a) as (keyof EditValues)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** What a comic's archive says of it in its ComicInfo.xml, found as a scan finds it, or nothing when it has none. Rejects when the archive can't be opened. */
async function comicInfoOf(file: string): Promise<ComicInfo | undefined> {
  const entry = comicInfoEntry((await comicEntries(file)).map((e) => e.name));
  return entry ? parseComicInfo(new TextDecoder().decode(await comicEntry(file, entry))) : undefined;
}

/** A comic's own details, which a comic stored before comics had them never has, and which are worked out again here. */
const WORKED_OUT = ["credits", "issue", "volume", "imprint", "coverDate", "storyArcs", "comicvine"] as const;

/**
 * A comic stored before comics had details of their own, in the shape a
 * comic's book has now (docs/BOOK-DETAILS.md, section 4): what its
 * ComicInfo.xml says, read in full by the scan's own rules
 * (`comicFromFiles`), with what its file's name said read back from its
 * record:
 *
 * - **Its series is as it was stored.** The library's series were found by
 *   it, and a run's year added now ("Transformers (2023)") would make a
 *   second series beside the first. Only a comic added from now on is
 *   named with it.
 * - **Its number** is ComicInfo's, an issue's or a collection's volume as
 *   its `Format` says. Where ComicInfo gave none, it came from the file's
 *   name, and is its number in the series as stored: an issue, as it was
 *   shown ("Saga #2"), since a collection's "Saga Vol. 2" can no longer be
 *   told from it. A person can say it is a collection.
 * - **Its story's own name** is ComicInfo's title. Else it is the title it
 *   was stored with, unless it has a number now: then that title was the
 *   name made from its series and number ("Saga #2"), or a file's name the
 *   new name has no room for.
 * - **Its cover date** is ComicInfo's year and month, else the year it was
 *   stored with, from its file's name.
 *
 * Its people, imprint, story arcs and ComicVine address are ComicInfo's.
 * What else it says (publisher, description, language, genres, which way it
 * reads) was read the same way before, and is kept as stored. Then it is
 * named from all that, as a scan names one (comic-name.ts). A comic already
 * in the new shape comes back as it is.
 */
export function comicAgain(stored: Book, info: ComicInfo | undefined): Book {
  // ComicInfo's number counts where it names a series or a number of its own, as the scan before this read it too.
  const byName = !info?.series && !info?.number;
  // Read with the series as stored, so a number ComicInfo gives without a series is read as the scan before read it.
  const read = comicFromFiles({ path: "", sizeBytes: 0, mtimeMs: 0, pages: 0, ...info, series: info?.series || stored.series }, "", "");
  let issue = read.issue;
  let volume = read.volume;
  if (byName && stored.series) {
    if (stored.issue || stored.volume) {
      // Read again already, or added since: as it is.
      issue = stored.issue;
      volume = stored.volume;
    } else if (stored.seriesIndex !== null) issue = String(stored.seriesIndex);
  }
  // A comic stored before has its name as its title, both the same; one in the new shape has its story's name apart.
  const storyName = info?.title || (stored.rawTitle !== stored.title ? stored.rawTitle : issue || volume ? "" : stored.title);
  const coverDate = read.coverDate ?? stored.coverDate ?? (stored.year !== null ? String(stored.year) : undefined);

  const book: Book = { ...stored };
  for (const detail of WORKED_OUT) delete book[detail];
  return namedComic({
    ...book,
    rawTitle: storyName,
    seriesIndex: null,
    year: read.year ?? stored.year,
    ...(issue ? { issue } : {}),
    ...(volume ? { volume } : {}),
    ...(read.credits ? { credits: read.credits } : {}),
    ...(read.imprint ? { imprint: read.imprint } : {}),
    ...(coverDate ? { coverDate } : {}),
    ...(read.storyArcs ? { storyArcs: read.storyArcs } : {}),
    ...(read.comicvine ? { comicvine: read.comicvine } : {}),
  });
}
