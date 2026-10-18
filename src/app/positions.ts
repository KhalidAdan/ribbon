import type { Position } from "../core/types";
import { comparePositions } from "../core/position";

/** Where a source's positions are kept. */
export interface PositionSinks {
  /**
   * The copy on this machine: every position of the source as one file,
   * written before anything goes near the share. Optional: hosts without
   * a local folder (tests, the browser harness) have only the share.
   */
  local?: ((all: Position[]) => Promise<void>) | undefined;
  /** The record beside the books, one book at a time. */
  share: (p: Position) => Promise<void>;
  log?: (message: string) => void;
}

export interface KeeperOptions {
  /** Least time between two local writes while playing. */
  localEveryMs?: number;
  /** Least time between two share writes while playing. */
  shareEveryMs?: number;
  /** Wait before retry number n after the share refused a write. */
  retryDelayMs?: (attempt: number) => number;
}

const DEFAULT_RETRY = (n: number) => Math.min(60_000, 2_000 * 2 ** Math.min(n, 5));

/**
 * The positions of one source, kept so that none is ever lost.
 *
 * A position is recorded in memory at once. The local copy follows
 * within `localEveryMs` (at once when urgent: a pause, a seek, the
 * window closing). The share follows within `shareEveryMs`, one writer
 * at a time, latest value per book: ten skips in a second write once.
 * A share that refuses (offline, read-only, reconnecting) keeps the
 * write queued and retried with backoff, and anything still queued
 * when the app quits is still in the local copy, which the next start
 * merges and pushes back.
 *
 * Merging is newest-wins per book everywhere, so a slow read of the
 * share can never replace a newer position with an older one.
 */
export class PositionKeeper {
  private readonly known = new Map<string, Position>();
  private readonly toShare = new Map<string, Position>();
  private localDirty = false;
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  private shareTimer: ReturnType<typeof setTimeout> | null = null;
  private localRun: Promise<void> | null = null;
  private shareRun: Promise<void> | null = null;
  private lastLocal = 0;
  private lastShare = 0;
  private failures = 0;
  private closed = false;
  private readonly localEveryMs: number;
  private readonly shareEveryMs: number;
  private readonly retryDelayMs: (n: number) => number;

  constructor(
    private readonly sinks: PositionSinks,
    opts: KeeperOptions = {},
  ) {
    this.localEveryMs = opts.localEveryMs ?? 2_000;
    this.shareEveryMs = opts.shareEveryMs ?? 15_000;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY;
  }

  get(bookId: string): Position | undefined {
    return this.known.get(bookId);
  }

  /** Every book's newest known position. */
  all(): Map<string, Position> {
    return new Map(this.known);
  }

  /** Writes the share has not taken yet. */
  pendingShare(): number {
    return this.toShare.size;
  }

  /**
   * Take positions read from somewhere (the local copy, the share), newest
   * wins per book. Returns the ids whose position changed.
   */
  absorb(incoming: Iterable<Position>, opts: { fromLocal?: boolean } = {}): string[] {
    const changed: string[] = [];
    for (const p of incoming) {
      const have = this.known.get(p.bookId);
      if (have && comparePositions(have, p) >= 0) continue;
      this.known.set(p.bookId, p);
      changed.push(p.bookId);
    }
    // What came from the local copy is already in it.
    if (changed.length > 0 && !opts.fromLocal) {
      this.localDirty = true;
      this.scheduleLocal(false);
    }
    return changed;
  }

  /**
   * After reading the share: every position known here that is newer than
   * what the share holds goes back to it. That is how a write made while
   * the share was away, or before a crash, reaches the books.
   */
  reconcile(share: ReadonlyMap<string, Position>): number {
    let behind = 0;
    for (const [id, p] of this.known) {
      const there = share.get(id);
      if (there && comparePositions(there, p) >= 0) continue;
      if (!this.toShare.has(id)) behind++;
      this.toShare.set(id, p);
    }
    if (behind > 0) {
      this.sinks.log?.(`${behind} position(s) newer here than beside the books; writing them back`);
      this.scheduleShare(true);
    }
    return behind;
  }

  /**
   * A new position from the player. It always wins: if a clock somewhere
   * ran ahead and the newest known position is stamped later than now,
   * this one is stamped just after it, so what the listener just did is
   * never outranked by what they did before. Urgent ones go out at once.
   * Returns the position as kept.
   */
  record(p: Position, urgent: boolean): Position {
    if (this.closed) return p;
    const have = this.known.get(p.bookId);
    if (have && Date.parse(have.updatedAt) >= Date.parse(p.updatedAt)) {
      p = { ...p, updatedAt: new Date(Date.parse(have.updatedAt) + 1).toISOString() };
    }
    this.known.set(p.bookId, p);
    this.toShare.set(p.bookId, p);
    this.localDirty = true;
    this.scheduleLocal(urgent);
    this.scheduleShare(urgent);
    return p;
  }

  /** Write everything now and wait. Never rejects. */
  async flush(): Promise<void> {
    this.clearTimers();
    await this.runLocal();
    await this.runShare();
  }

  /** Flush and stop accepting new positions. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.localTimer !== null) clearTimeout(this.localTimer);
    if (this.shareTimer !== null) clearTimeout(this.shareTimer);
    this.localTimer = null;
    this.shareTimer = null;
  }

  private scheduleLocal(urgent: boolean): void {
    if (!this.sinks.local) return;
    const wait = urgent ? 0 : Math.max(0, this.lastLocal + this.localEveryMs - Date.now());
    if (this.localTimer !== null) {
      if (!urgent) return;
      clearTimeout(this.localTimer);
    }
    this.localTimer = setTimeout(() => {
      this.localTimer = null;
      void this.runLocal();
    }, wait);
  }

  private scheduleShare(urgent: boolean): void {
    if (this.closed) return;
    // After a refusal the backoff decides, not the throttle.
    const wait = this.failures > 0 ? this.retryDelayMs(this.failures - 1) : urgent ? 0 : Math.max(0, this.lastShare + this.shareEveryMs - Date.now());
    if (this.shareTimer !== null) {
      if (!urgent || this.failures > 0) return;
      clearTimeout(this.shareTimer);
    }
    this.shareTimer = setTimeout(() => {
      this.shareTimer = null;
      void this.runShare();
    }, wait);
  }

  /** One local writer at a time; a write asked for during one runs after it. */
  private async runLocal(): Promise<void> {
    const local = this.sinks.local;
    if (!local) return;
    while (this.localRun) await this.localRun;
    if (!this.localDirty) return;
    this.localDirty = false;
    this.lastLocal = Date.now();
    const snapshot = [...this.known.values()];
    this.localRun = local(snapshot)
      .catch((e: unknown) => {
        this.localDirty = true;
        this.sinks.log?.(`could not keep positions on this machine: ${describe(e)}`);
      })
      .finally(() => {
        this.localRun = null;
      });
    await this.localRun;
  }

  /** One share writer at a time, latest value per book, oldest book first. */
  private async runShare(): Promise<void> {
    while (this.shareRun) await this.shareRun;
    if (this.toShare.size === 0) return;
    this.lastShare = Date.now();
    this.shareRun = (async () => {
      for (const [id, p] of [...this.toShare]) {
        try {
          await this.sinks.share(p);
          // Only clear it if nothing newer arrived while it was being written.
          if (this.toShare.get(id) === p) this.toShare.delete(id);
          if (this.failures > 0) this.sinks.log?.(`the books are reachable again; ${this.toShare.size} position(s) still to write`);
          this.failures = 0;
        } catch (e) {
          this.failures++;
          if (this.failures === 1 || this.failures % 10 === 0) this.sinks.log?.(`could not write a position beside the books (attempt ${this.failures}); kept on this machine and retrying: ${describe(e)}`);
          break;
        }
      }
    })().finally(() => {
      this.shareRun = null;
    });
    await this.shareRun;
    if (this.toShare.size > 0 && !this.closed) this.scheduleShare(false);
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}
