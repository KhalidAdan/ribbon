import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.ts";
import { Jobs } from "../src/jobs.ts";

/**
 * The server's background work (docs/SERVER.md, section 7): each job
 * waits its turn in its lane, runs, and is done or failed, and the admin's
 * pages follow it in the database.
 */
describe("a job", () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-jobs-"));
    db = openDatabase(dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("whose start can't be written fails, and the jobs after it in its lane still run", async () => {
    // The database refuses to note this one running, as a full disk would.
    db.exec("CREATE TRIGGER refuse BEFORE UPDATE OF state ON job WHEN NEW.state = 'running' AND OLD.kind = 'unlucky' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    const jobs = new Jobs(db);
    const unlucky = jobs.start("unlucky", 0, async () => 1, null);
    const next = jobs.start("next", 0, async () => 1, null);
    await jobs.idle();
    expect(jobs.get(unlucky.id)).toMatchObject({ state: "failed", error: "database or disk is full" });
    expect(jobs.get(next.id)).toMatchObject({ state: "done", progress: 1 });
  });

  it("that has ended keeps the progress it ended with, whatever its work reports after", async () => {
    const jobs = new Jobs(db);
    let report: (p: number) => void = () => undefined;
    const job = jobs.start(
      "hasty",
      0,
      async (r) => {
        report = r;
        return 10;
      },
      null,
    );
    await jobs.idle();
    report(3);
    expect(jobs.get(job.id)).toMatchObject({ state: "done", progress: 10 });
  });

  it("still under way when the server stopped is failed when it starts, and stays failed", async () => {
    const before = new Jobs(db);
    const stopped = before.start("long", 0, () => new Promise<number>(() => undefined), null);
    const after = new Jobs(db);
    expect(after.get(stopped.id)).toMatchObject({ state: "failed", error: "The server stopped while it ran." });
  });
});
