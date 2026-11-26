import { comicShape, type ComicShape } from "@ribbon/core/comic-name";
import { comicVineAddress, numberToLookUp, type LookUpAsked } from "@ribbon/core/comicvine";
import type { Book } from "@ribbon/core/types";
import type { Events } from "../events.ts";
import type { Jobs } from "../jobs.ts";
import { readStored } from "./book-folder.ts";
import { asEdited, type BookIndex } from "./books.ts";
import { ComicVineUnreachable, type ComicVine } from "./comicvine.ts";
import type { LibrarySeries } from "./series.ts";

/**
 * A comic matched to its issue on ComicVine (docs/BOOK-DETAILS.md, section
 * 7), on a server whose owner set a key (RIBBON_COMICVINE_KEY): what the
 * edit form's "Look it up" asks, and the one match the server makes by
 * itself.
 *
 * - **A person looks it up** (comicvine-routes.ts, and the MCP's
 *   `set_details`): by an address they give, or the comic's own; read as
 *   they say, or as the comic is now (`lookUpAsked`). Nothing is kept
 *   until they press "Use these" (`BookIndex.keepMatch`).
 * - **The server matches by itself only by an exact address**: a comic
 *   whose file's ComicInfo `Web` is a ComicVine issue's page is matched to
 *   that issue, in the background, one comic at a time, after a folder is
 *   added and when the server starts, as Audible's descriptions are
 *   (`matchComics`). It never searches without a person. Each comic is
 *   looked up by itself once, found or not, and never again once a person
 *   forgot its match. A person's look-up goes through ComicVine's door
 *   before the job's next request (comicvine.ts).
 */

/** What a look-up is asked by, as a request gives it: any of it may be left to the comic. */
export interface LookUpRequest {
  /** An issue's or a run's page on ComicVine, or its id. */
  address?: string | undefined;
  /** For a run's address: the number of the issue in it (a collection's volume). */
  issue?: string | undefined;
  /** How ComicVine's issue number is read: as an issue's, a collection's volume, or neither. */
  as?: ComicShape | undefined;
}

/**
 * What to look a comic up by: the address given, else the comic's own
 * (its match's, or its file's); read as said, else as the comic is now;
 * a run's issue by the number given, else the comic's own. A sentence a
 * person can act on when it can't be looked up by any.
 */
export function lookUpAsked(standing: Pick<Book, "comicvine" | "issue" | "volume" | "collects">, asked: LookUpRequest): LookUpAsked | string {
  const text = asked.address?.trim() || standing.comicvine || "";
  if (!text) return "Give the comic's page on ComicVine, an issue's (…/4000-1234567/) or its run's (…/4050-123456/) with the issue's number, or search for its run by name.";
  const address = comicVineAddress(text);
  if (!address) return `That isn't a page on ComicVine: give an issue's (…/4000-1234567/), or its run's (…/4050-123456/) with the issue's number.`;
  const as = asked.as ?? comicShape(standing);
  const number = asked.issue?.trim() || numberToLookUp(standing, as);
  if (address.kind === "run" && !number) return "Give the number of the issue in that run: a collection's is its volume.";
  return { address, as, ...(number ? { number } : {}) };
}

/** How a comic is read, from a request's words, or undefined when they say none. */
export function shapeAsked(value: unknown): ComicShape | undefined {
  return value === "issue" || value === "collection" || value === "alone" ? value : undefined;
}

/** How matching the comics by their files' addresses is going. */
export interface MatchProgress {
  comics: number;
  done: number;
  matched: number;
  current: string | null;
}

/** ComicVine out of reach for this many comics in a row, and it's taken to be out of reach until the next run, as describe.ts does. */
const GIVE_UP_AFTER = 3;

/**
 * Match each comic whose file names its issue on ComicVine to that issue
 * (above), one at a time. A comic ComicVine has no such issue for is noted
 * as asked, and so is one matched; one it couldn't be asked about isn't,
 * so it's asked next time. `matched` hears of each comic matched.
 */
export async function matchComics(comicVine: ComicVine, dataDir: string, index: BookIndex, report: (p: MatchProgress) => void, matched: (id: string) => void): Promise<MatchProgress> {
  const comics = index.comicsToMatch();
  const progress: MatchProgress = { comics: comics.length, done: 0, matched: 0, current: null };
  let unreachable = 0;
  for (const { id, issue } of comics) {
    if (unreachable >= GIVE_UP_AFTER) break;
    // Matched by a person meanwhile, or deleted: nothing to do.
    const stored = index.match(id) ? null : await readStored(dataDir, id);
    const address = comicVineAddress(issue);
    if (stored?.book.comic && address) {
      const standing = asEdited(stored.book, index.edits(id)?.values ?? {}, index.hasDetails(id));
      progress.current = standing.title;
      report(progress);
      try {
        const found = await comicVine.lookUp({ address, as: comicShape(standing) }, "background");
        unreachable = 0;
        // Kept unless a person matched it while it was being asked about.
        if (found && !index.match(id) && index.keepMatch(id, found, null, new Date().toISOString())) {
          progress.matched++;
          matched(id);
        }
        index.noteAsked(id, issue, Date.now());
      } catch (e) {
        if (!(e instanceof ComicVineUnreachable)) throw e;
        unreachable++;
      }
    }
    progress.done++;
    report(progress);
  }
  progress.current = null;
  return progress;
}

/**
 * Match, in the background, the comics whose files name their issue on
 * ComicVine (`matchComics`), in a lane of their own so adding a folder
 * never waits on ComicVine's pace. Every device hears of each comic
 * matched, and of the series a match makes.
 */
export function startMatching(deps: { jobs: Jobs; comicVine: ComicVine; books: BookIndex; series: LibrarySeries; events: Events; dataDir: string }, by: string | null): void {
  deps.jobs.start<MatchProgress>(
    "comicvine",
    { comics: 0, done: 0, matched: 0, current: null },
    async (report) => {
      const done = await matchComics(deps.comicVine, deps.dataDir, deps.books, report, (id) => deps.events.toEveryone({ type: "books", data: { edited: id } }));
      // A series a match names is one its comics belong to, as a series a book arrives naming is.
      if (done.matched > 0 && deps.series.find(deps.books.list(), Date.now()) > 0) deps.events.toEveryone({ type: "series", data: {} });
      return done;
    },
    by,
    "comicvine",
  );
}
