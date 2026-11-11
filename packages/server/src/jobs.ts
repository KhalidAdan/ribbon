import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Where a job stands. It waits its turn in its lane, runs, and is done or
 * failed; a job still waiting or running when the server stopped is failed
 * when it starts again, rather than left hanging.
 *
 *     waiting ──its turn──▶ running ──its work returns──▶ done
 *        │                     │
 *        └──server stopped─────┴──its work throws, or the server stopped──▶ failed
 */
export type JobState = "waiting" | "running" | "done" | "failed";

/** The states each state can move to (`Jobs.move`); a finished job never moves again. */
const NEXT: Record<JobState, readonly JobState[]> = {
  waiting: ["running", "failed"],
  running: ["done", "failed"],
  done: [],
  failed: [],
};

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
 * while someone waits on a request). One job runs at a time in each lane,
 * in the order asked for, and each one's progress is kept in the database
 * as it goes, so the admin pages can show it. Work that takes days (the
 * narration transcribed) has a lane of its own, so adding a folder never
 * waits on it. A job's state moves only as `JobState` says, in one place
 * (`move`), and a lane goes on to its next job whatever happened to the
 * last, even a database that wouldn't note it.
 */
export class Jobs {
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    for (const row of db.prepare("SELECT id FROM job WHERE state IN ('waiting', 'running')").all()) this.move(String(row.id), "failed", { error: "The server stopped while it ran." });
  }

  /** Queue work, in `lane`. `work` reports its progress through `report` while it runs; what it returns is its last progress. */
  start<P>(kind: string, first: P, work: (report: (progress: P) => void) => Promise<P>, createdBy: string | null, lane = "work"): Job<P> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO job (id, kind, state, progress, created_by, created_at) VALUES (?, ?, 'waiting', ?, ?, ?)").run(id, kind, JSON.stringify(first), createdBy, this.now());
    // Only while it runs: a report after its work returned changes nothing.
    const report = (progress: P) => void this.db.prepare("UPDATE job SET progress = ? WHERE id = ? AND state = 'running'").run(JSON.stringify(progress), id);
    const run = async () => {
      try {
        this.move(id, "running");
        this.move(id, "done", { progress: await work(report) });
      } catch (e) {
        try {
          this.move(id, "failed", { error: e instanceof Error ? e.message : String(e) });
        } catch {
          // The database won't note it either: it's failed when the server next starts, and the lane goes on.
        }
      }
    };
    this.lanes.set(lane, (this.lanes.get(lane) ?? Promise.resolve()).then(run));
    return this.get<P>(id)!;
  }

  /**
   * Move a job to `to`, from a state that can move there (`NEXT`): the one
   * place its state is changed, noted with when it started or finished, and
   * its last progress or what went wrong. From any other state, nothing changes.
   */
  private move(id: string, to: JobState, noted: { progress?: unknown; error?: string } = {}): void {
    const from = (Object.keys(NEXT) as JobState[]).filter((state) => NEXT[state].includes(to));
    const where = `WHERE id = ? AND state IN (${from.map((state) => `'${state}'`).join(", ")})`;
    const at = this.now();
    switch (to) {
      case "waiting":
        throw new Error("A job only waits when it's queued.");
      case "running":
        this.db.prepare(`UPDATE job SET state = 'running', started_at = ? ${where}`).run(at, id);
        break;
      case "done":
        this.db.prepare(`UPDATE job SET state = 'done', progress = ?, finished_at = ? ${where}`).run(JSON.stringify(noted.progress), at, id);
        break;
      case "failed":
        this.db.prepare(`UPDATE job SET state = 'failed', error = ?, finished_at = ? ${where}`).run(noted.error ?? null, at, id);
        break;
    }
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

  /** Every job queued so far in `lane`, or in every lane, has finished. For tests, and for a server stopping cleanly. */
  async idle(lane?: string): Promise<void> {
    await Promise.all(lane === undefined ? [...this.lanes.values()] : [this.lanes.get(lane)]);
  }
}
