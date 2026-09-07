import { matchWork, needsLookup, parseSearch, parseWork, searchUrl, workUrl, REQUEST_GAP_MS, type BookAbout } from "../core/about";
import type { ScannedBook } from "../core/scan/scan";
import type { LibraryService } from "./library";
import { log } from "./log";

export interface LookupStatus {
  running: boolean;
  /** Books asked about in this run so far, and how many the run will ask about. */
  done: number;
  total: number;
}

/**
 * Asks Open Library about each book that has no answer yet, one at a
 * time, a second apart, in the background, and records every answer
 * (including "nothing found") beside the books. Stops at the first
 * network failure: a machine that is offline should not keep trying.
 */
export class AboutLookup {
  private abort: AbortController | null = null;

  constructor(
    private readonly lib: LibraryService,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get running(): boolean {
    return this.abort !== null;
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  async run(books: readonly ScannedBook[], existing: Map<string, BookAbout>, onProgress: (about: BookAbout | null, status: LookupStatus) => void): Promise<void> {
    if (this.abort) return;
    const todo = books.filter((b) => needsLookup(existing.get(b.book.id)));
    if (todo.length === 0) return;
    const abort = new AbortController();
    this.abort = abort;
    const all = new Map(existing);
    let done = 0;
    log.info("about: looking up", todo.length, "books");
    try {
      for (const b of todo) {
        if (abort.signal.aborted) return;
        let about: BookAbout;
        try {
          about = await this.lookupOne(b, abort.signal);
        } catch (e) {
          if (abort.signal.aborted) return;
          log.warn("about: stopping, the lookup failed:", e instanceof Error ? e.message : String(e));
          return;
        }
        all.set(about.bookId, about);
        done++;
        try {
          await this.lib.writeAbout([...all.values()]);
        } catch (e) {
          log.warn("about: could not save:", e instanceof Error ? e.message : String(e));
        }
        onProgress(about, { running: true, done, total: todo.length });
        await sleep(REQUEST_GAP_MS, abort.signal);
      }
    } finally {
      if (this.abort === abort) this.abort = null;
      onProgress(null, { running: false, done, total: todo.length });
    }
  }

  private async lookupOne(b: ScannedBook, signal: AbortSignal): Promise<BookAbout> {
    const fetchedAt = new Date().toISOString();
    const miss: BookAbout = { bookId: b.book.id, source: "none", key: "", title: "", description: "", fetchedAt };
    const found = parseSearch(await this.json(searchUrl(b.book.rawTitle || b.book.title, b.book.author === "Various" ? "" : b.book.author), signal));
    const work = matchWork(found, b.book.rawTitle || b.book.title, b.book.author === "Various" ? "" : b.book.author);
    if (!work) return miss;
    await sleep(REQUEST_GAP_MS, signal);
    const description = parseWork(await this.json(workUrl(work.key), signal));
    if (!description) return miss;
    return { bookId: b.book.id, source: "openlibrary", key: work.key, title: work.title, description, fetchedAt };
  }

  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    const r = await this.fetchImpl(url, { signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
