import type { ScannedBook } from "../core/scan/scan";
import type { SilenceRange } from "../core/types";
import { combineLoudness, loudnessArgs, parseEbur128, type FileLoudness } from "../core/loudness";
import { parseSilenceDetect, silenceArgs } from "../core/silence";
import type { LibraryService } from "./library";

/**
 * Measure a whole book with ffmpeg's ebur128 filter and record the
 * gain. One file at a time; a book is one job. Returns the gain in dB.
 */
export async function measureLoudness(lib: LibraryService, book: ScannedBook, signal?: AbortSignal): Promise<number | null> {
  const parts: FileLoudness[] = [];
  for (const f of book.files) {
    if (signal?.aborted) return null;
    const r = await lib.host.run("ffmpeg", loudnessArgs(lib.absPath(f.path)), signal);
    const m = parseEbur128(r.stderr);
    if (m) parts.push({ ...m, durationMs: f.durationMs });
  }
  const combined = combineLoudness(parts);
  if (!combined) return null;
  return lib.writeLoudness(book.book.id, combined);
}

/** Find every gap over a second in every file and record it. */
export async function detectSilence(lib: LibraryService, book: ScannedBook, signal?: AbortSignal): Promise<Map<number, SilenceRange[]> | null> {
  const out = new Map<number, SilenceRange[]>();
  for (const [i, f] of book.files.entries()) {
    if (signal?.aborted) return null;
    const r = await lib.host.run("ffmpeg", silenceArgs(lib.absPath(f.path)), signal);
    const ranges = parseSilenceDetect(r.stderr, f.durationMs);
    if (ranges.length > 0) out.set(i, ranges);
  }
  await lib.writeSilence(book.book.id, out);
  return out;
}

export type JobKind = "loudness" | "silence";

export interface JobStatus {
  bookId: string;
  kind: JobKind;
  state: "queued" | "running" | "done" | "failed";
}

/**
 * A single-lane queue for the slow scans. Books the user is listening
 * to can be pushed to the front. Never runs more than one ffmpeg.
 */
export class JobQueue {
  private queue: { book: ScannedBook; kind: JobKind }[] = [];
  private running: { bookId: string; kind: JobKind; abort: AbortController } | null = null;
  private listeners = new Set<(s: JobStatus) => void>();

  constructor(private readonly lib: LibraryService) {}

  onStatus(fn: (s: JobStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  enqueue(book: ScannedBook, kind: JobKind, front = false): void {
    const id = book.book.id;
    if (this.running && this.running.bookId === id && this.running.kind === kind) return;
    if (this.queue.some((j) => j.book.book.id === id && j.kind === kind)) {
      if (front) this.queue = [{ book, kind }, ...this.queue.filter((j) => !(j.book.book.id === id && j.kind === kind))];
      return;
    }
    if (front) this.queue.unshift({ book, kind });
    else this.queue.push({ book, kind });
    this.emit({ bookId: id, kind, state: "queued" });
    void this.pump();
  }

  cancelAll(): void {
    this.queue = [];
    this.running?.abort.abort();
  }

  private emit(s: JobStatus): void {
    for (const l of this.listeners) l(s);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const abort = new AbortController();
    this.running = { bookId: next.book.book.id, kind: next.kind, abort };
    this.emit({ bookId: next.book.book.id, kind: next.kind, state: "running" });
    try {
      if (next.kind === "loudness") await measureLoudness(this.lib, next.book, abort.signal);
      else await detectSilence(this.lib, next.book, abort.signal);
      this.emit({ bookId: next.book.book.id, kind: next.kind, state: "done" });
    } catch {
      this.emit({ bookId: next.book.book.id, kind: next.kind, state: "failed" });
    } finally {
      this.running = null;
      void this.pump();
    }
  }
}
