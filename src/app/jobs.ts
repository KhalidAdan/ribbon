import type { ScannedBook } from "../core/scan/scan";
import type { SilenceRange } from "../core/types";
import { analyzeFiles } from "../core/analysis";
import type { LibraryService } from "./library";

export interface Analysis {
  gainDb: number | null;
  silence: Map<number, SilenceRange[]>;
}

/**
 * Decode a whole book once, recording loudness and silence beside it
 * (core/analysis.ts). This is the expensive job, so it runs only for books
 * the listener opens, and never for a server's, which comes with it done.
 */
export async function analyzeBook(lib: LibraryService, book: ScannedBook, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<Analysis | null> {
  const done = await analyzeFiles(
    lib.host,
    book.files.map((f) => ({ absPath: lib.absPath(f.path), durationMs: f.durationMs })),
    signal,
    onProgress,
  );
  if (!done) return null;
  const gainDb = done.loudness ? await lib.writeLoudness(book.book.id, done.loudness) : null;
  await lib.writeSilence(book.book.id, done.silence);
  return { gainDb, silence: done.silence };
}

export interface JobStatus {
  bookId: string;
  state: "queued" | "running" | "done" | "failed";
  /** How far a running scan has got, 0 to 1. */
  progress?: number;
}

/**
 * A single-lane queue for the slow analysis. Never runs more than one
 * ffmpeg. The book being listened to goes to the front.
 */
export class JobQueue {
  private queue: ScannedBook[] = [];
  private running: { bookId: string; abort: AbortController } | null = null;
  private runningBook: ScannedBook | null = null;
  private listeners = new Set<(s: JobStatus, result: Analysis | null) => void>();

  /** `libFor` says which library a book's records live in; null when the book's source is gone. */
  constructor(private readonly libFor: (book: ScannedBook) => LibraryService | null) {}

  onStatus(fn: (s: JobStatus, result: Analysis | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  enqueue(book: ScannedBook, front = false): void {
    const id = book.book.id;
    if (this.running?.bookId === id) return;
    // Nothing to measure with where ffmpeg cannot run (iOS): the book plays as it is.
    if (this.libFor(book)?.host.tools === false) return;
    this.queue = this.queue.filter((b) => b.book.id !== id);
    if (front) this.queue.unshift(book);
    else this.queue.push(book);
    this.emit({ bookId: id, state: "queued" }, null);
    void this.pump();
  }

  cancelAll(): void {
    this.queue = [];
    this.running?.abort.abort();
  }

  /** Drop the queued books that match, and stop the running one if it does. */
  cancelWhere(pred: (book: ScannedBook) => boolean): void {
    this.queue = this.queue.filter((b) => !pred(b));
    if (this.running && this.runningBook && pred(this.runningBook)) this.running.abort.abort();
  }

  private emit(s: JobStatus, result: Analysis | null): void {
    for (const l of this.listeners) l(s, result);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const abort = new AbortController();
    this.running = { bookId: next.book.id, abort };
    this.runningBook = next;
    this.emit({ bookId: next.book.id, state: "running" }, null);
    try {
      const lib = this.libFor(next);
      // Said a percent at a time: the player shows it, and needn't redraw for less.
      let said = 0;
      const progress = (fraction: number) => {
        const percent = Math.floor(fraction * 100);
        if (percent <= said) return;
        said = percent;
        this.emit({ bookId: next.book.id, state: "running", progress: fraction }, null);
      };
      const result = lib ? await analyzeBook(lib, next, abort.signal, progress) : null;
      this.emit({ bookId: next.book.id, state: result ? "done" : "failed" }, result);
    } catch {
      this.emit({ bookId: next.book.id, state: "failed" }, null);
    } finally {
      this.running = null;
      this.runningBook = null;
      void this.pump();
    }
  }
}
