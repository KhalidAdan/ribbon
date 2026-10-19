import type { Ebook } from "../core/ebook";
import type { Locator, Why } from "../core/poslog";
import { locatorOf, placeOf, startOf, type TextPlace } from "../core/reading/place";
import { log } from "./log";

/** The book open in the reader, while it opens, once it has, or why it could not. */
export interface ReadingState {
  bookId: string;
  status: "opening" | "ready" | "failed";
  message?: string;
  ebook?: Ebook;
  place?: TextPlace;
}

/** The reading places this machine keeps, from the app's settings, by book id. */
export function parseKeptPlaces(v: unknown): Record<string, KeptPlace> {
  const out: Record<string, KeptPlace> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, k] of Object.entries(v as Record<string, unknown>)) {
    const kept = k as Partial<KeptPlace> | null;
    if (kept && typeof kept.t === "string" && typeof kept.loc === "object" && kept.loc !== null && typeof kept.loc.href === "string") out[id] = { loc: kept.loc, t: kept.t };
  }
  return out;
}

/** A reading place as this machine keeps it: the Locator and when it was written. */
export interface KeptPlace {
  loc: Locator;
  t: string;
}

/** How long a page stays before its place goes beside the books. */
export const SHARE_AFTER_MS = 5_000;

/**
 * Keeps the place in one open book's text: on this machine at once, and
 * in the position log beside the books a few seconds after the reader
 * settles on a page, or at once for a jump or on close. A failed write
 * beside the books is tried again with the next one.
 */
export class ReadingKeeper {
  private place: TextPlace;
  private pending: { loc: Locator; why: Why; at: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly ebook: Ebook,
    start: TextPlace,
    private readonly io: {
      /** Keep it on this machine. Cheap, and called on every move. */
      keepLocal: (kept: KeptPlace) => void;
      /** Write it beside the books, in the position log. */
      share: (loc: Locator, why: Why, atMs: number) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.place = start;
  }

  get current(): TextPlace {
    return this.place;
  }

  move(place: TextPlace, why: Why): void {
    this.place = place;
    const now = this.io.now?.() ?? Date.now();
    const loc = locatorOf(this.ebook, place);
    this.io.keepLocal({ loc, t: new Date(now).toISOString() });
    this.pending = { loc, why, at: now };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (why === "seek" || why === "close") void this.flush();
    else this.timer = setTimeout(() => void this.flush(), SHARE_AFTER_MS);
  }

  /** Write whatever is waiting, now. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    if (!p) return this.writing;
    this.pending = null;
    this.writing = this.writing.then(() =>
      this.io.share(p.loc, p.why, p.at).catch((e: unknown) => {
        log.warn("could not keep the reading place beside the books:", e instanceof Error ? e.message : String(e));
        // Keep it for the next try, unless something newer is already waiting.
        this.pending ??= p;
      }),
    );
    return this.writing;
  }
}

/**
 * Where to open a book's text: the newer of this machine's copy and the
 * log's, found in this book by its words; else the book's start.
 */
export function openingPlace(ebook: Ebook, local: KeptPlace | undefined, shared: KeptPlace | undefined): TextPlace {
  const newer = [local, shared].filter((k): k is KeptPlace => !!k && !Number.isNaN(Date.parse(k.t))).sort((a, b) => Date.parse(b.t) - Date.parse(a.t))[0];
  if (!newer) return startOf(ebook);
  return placeOf(ebook, newer.loc);
}
