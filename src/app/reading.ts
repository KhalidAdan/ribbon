import type { Ebook } from "../core/ebook";
import type { Alignment } from "../core/reading/align";
import type { Highlight } from "../core/types";
import type { Locator, Why } from "../core/poslog";
import type { BookText, TextPlace } from "../core/reading/booktext";
import { log } from "./log";
import { isReadOnly } from "./read-only";

/** The book open in the reader, while it opens, once it has, or why it could not. */
export interface ReadingState {
  bookId: string;
  status: "opening" | "ready" | "failed";
  message?: string;
  /** The book's text, and through it its EPUB model (`text.ebook`). */
  text?: BookText;
  place?: TextPlace;
  /** The text's chapters paired with the audio's, for switching between them (level 1). */
  alignment?: Alignment;
  /** Hearing the narrator, while it runs: chapter openings first (#65), then checkpoints inside chapters. */
  listening?: { done: number; total: number; what: "openings" | "checkpoints" | "aligning" };
  /**
   * Getting read-along ready: the minutes around the reader are being
   * transcribed, so the sentence is marked from the first page. The
   * reader waits on it, unless it is told to read now.
   */
  preparing?: boolean;
  /** The read-along export: chapters encoded so far while it runs, then what it made or why it could not. */
  exporting?: { done: number; total: number };
  exported?: { path: string } | { error: string };
  /** The pages follow the narrator: turned as it reads on, the sentence being read marked. A turn by hand stops it. */
  following?: boolean;
  /** Hearing one place before "Listen from here" or "Go to the narrator" acts. */
  finding?: boolean;
  /** Bookmarks made from highlights in this book, drawn in its text. */
  highlights?: Highlight[];
}

/** The reading places this machine keeps, from the app's settings, by book id. */
export function parseKeptPlaces(v: unknown): Record<string, KeptPlace> {
  const out: Record<string, KeptPlace> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, k] of Object.entries(v as Record<string, unknown>)) {
    const kept = k as Partial<KeptPlace> | null;
    if (kept && typeof kept.t === "string" && typeof kept.loc === "object" && kept.loc !== null && typeof kept.loc.href === "string") out[id] = { loc: kept.loc, t: kept.t, ...(typeof kept.ms === "number" && Number.isFinite(kept.ms) ? { ms: kept.ms } : {}) };
  }
  return out;
}

/** A reading place as this machine keeps it: the Locator and when it was written. */
export interface KeptPlace {
  loc: Locator;
  t: string;
  /** Where the same place is in the audiobook, by chapter and proportion, when the book has one. */
  ms?: number;
}

/** How long a page stays before its place goes beside the books. */
export const SHARE_AFTER_MS = 5_000;

/**
 * Keeps the place in one open book's text: on this machine at once, and
 * in the position log beside the books a few seconds after the reader
 * settles on a page, or at once for a jump or on close. A failed write
 * beside the books is tried again with the next one, unless the folder is
 * read-only from this device.
 */
export class ReadingKeeper {
  private place: TextPlace;
  private pending: { loc: Locator; why: Why; at: number; ms?: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Set once the reader has moved: opening a book is not reading it. */
  private moved = false;

  constructor(
    private readonly book: BookText,
    start: TextPlace,
    private readonly io: {
      /** Keep it on this machine. Cheap, and called on every move. */
      keepLocal: (kept: KeptPlace) => void;
      /** Write it beside the books, in the position log. */
      share: (loc: Locator, why: Why, atMs: number, ms?: number) => Promise<void>;
      /** The same place in the audiobook, when there is one. */
      toMs?: (place: TextPlace) => number | null;
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
    this.moved = true;
    const now = this.io.now?.() ?? Date.now();
    const loc = this.book.locator(place);
    const ms = this.io.toMs?.(place) ?? undefined;
    this.io.keepLocal({ loc, t: new Date(now).toISOString(), ...(ms !== undefined ? { ms } : {}) });
    this.pending = { loc, why, at: now, ...(ms !== undefined ? { ms } : {}) };
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
      this.io.share(p.loc, p.why, p.at, p.ms).catch((e: unknown) => {
        // A folder read-only from here keeps the place on this machine alone (keepLocal); the library has said so once.
        if (isReadOnly(e)) return;
        log.warn("could not keep the reading place beside the books:", e instanceof Error ? e.message : String(e));
        // Keep it for the next try, unless something newer is already waiting.
        this.pending ??= p;
      }),
    );
    return this.writing;
  }

  /** Closing the book: keep the place everywhere, but only if the reader read. */
  finish(): Promise<void> {
    if (this.moved) this.move(this.place, "close");
    return this.flush();
  }
}

/**
 * Where to open a book's text: the newest of this machine's reading
 * place, the log's, and the narrator's place mapped into the text; else
 * the book's start. Listening on after reading opens the text where the
 * narrator is.
 */
export function openingPlace(book: BookText, local: KeptPlace | undefined, shared: KeptPlace | undefined, narrator?: { place: TextPlace; t: string }): TextPlace {
  type Candidate = { t: number; place: () => TextPlace };
  const all: Candidate[] = [];
  for (const k of [local, shared]) if (k && !Number.isNaN(Date.parse(k.t))) all.push({ t: Date.parse(k.t), place: () => book.fromLocator(k.loc) });
  if (narrator && !Number.isNaN(Date.parse(narrator.t))) all.push({ t: Date.parse(narrator.t), place: () => narrator.place });
  const newest = all.sort((a, b) => b.t - a.t)[0];
  return newest ? newest.place() : book.start();
}
