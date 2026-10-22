import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JobState = "waiting" | "running" | "done" | "failed";

export interface Job<P = unknown> {
  id: string;
  kind: string;
  state: JobState;
  progress: P;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/**
 * The server's background work (docs/SERVER.md, section 7: nothing heavy
 * while someone waits on a request). One job runs at a time, in the order
 * asked for, and each one's progress is kept in the database as it goes,
 * so the admin pages can show it. A job still running when the server
 * stopped is marked failed on the next start rather than left hanging.
 */
export class Jobs {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.prepare("UPDATE job SET state = 'failed', error = 'The server stopped while it ran.', finished_at = ? WHERE state IN ('waiting', 'running')").run(now());
  }

  /** Queue work. `work` reports its progress through `report`; what it returns is its last progress. */
  start<P>(kind: string, first: P, work: (report: (progress: P) => void) => Promise<P>, createdBy: string | null): Job<P> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO job (id, kind, state, progress, created_by, created_at) VALUES (?, ?, 'waiting', ?, ?, ?)").run(id, kind, JSON.stringify(first), createdBy, this.now());
    const report = (progress: P) => void this.db.prepare("UPDATE job SET progress = ? WHERE id = ?").run(JSON.stringify(progress), id);
    this.queue = this.queue.then(async () => {
      this.db.prepare("UPDATE job SET state = 'running', started_at = ? WHERE id = ?").run(this.now(), id);
      try {
        const last = await work(report);
        this.db.prepare("UPDATE job SET state = 'done', progress = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(last), this.now(), id);
      } catch (e) {
        this.db.prepare("UPDATE job SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(e instanceof Error ? e.message : String(e), this.now(), id);
      }
    });
    return this.get<P>(id)!;
  }

  get<P = unknown>(id: string): Job<P> | null {
    const row = this.db.prepare("SELECT * FROM job WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      kind: String(row.kind),
      state: row.state as JobState,
      progress: JSON.parse(String(row.progress)) as P,
      error: row.error === null ? null : String(row.error),
      createdAt: Number(row.created_at),
      startedAt: row.started_at === null ? null : Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    };
  }

  /** Every job queued so far has finished. For tests, and for a server stopping cleanly. */
  idle(): Promise<void> {
    return this.queue;
  }
}
