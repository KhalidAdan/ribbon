import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { AppController, type Platform } from "../src/app/controller";
import { FIXTURE_ROOT } from "../tools/make-fixtures";

/** The controller against real fixtures, with no window and no audio. */
function platform(root: string): Platform {
  return {
    host: nodeHost(),
    pickFolder: async () => root,
    allowFolder: async () => undefined,
    fileUrl: (p) => `file:///${p}`,
    loadRoot: () => null,
    saveRoot: () => undefined,
  };
}

async function settle(c: AppController, until: () => boolean, ms = 60_000): Promise<void> {
  const started = Date.now();
  while (!until()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting for controller");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("AppController.openLibrary", () => {
  beforeAll(async () => {
    await fs.rm(path.join(FIXTURE_ROOT, ".odio"), { recursive: true, force: true });
  });

  it("scans a never-seen folder in the foreground and ends ready with books", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    const progress: number[] = [];
    c.subscribe(() => {
      const s = c.getState();
      if (s.scanning && s.scanning.walked > 0) progress.push(s.scanning.done);
    });
    await c.pickLibrary();
    const s = c.getState();
    expect(s.phase).toBe("ready");
    expect(s.error).toBeNull();
    expect(s.books.length).toBe(11);
    expect(s.scanning).toBeNull();
    expect(s.scanErrors).toEqual([]);
    expect(progress.length).toBeGreaterThan(0);
    expect(Object.keys(s.positions)).toHaveLength(11);
  });

  it("paints from cache on the next open, then rescans behind it", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    const phases: string[] = [];
    c.subscribe(() => {
      const p = c.getState().phase;
      if (phases[phases.length - 1] !== p) phases.push(p);
    });
    await c.openLibrary(FIXTURE_ROOT);
    expect(c.getState().phase).toBe("ready");
    expect(c.getState().books.length).toBe(11);
    // The background rescan is still running or just finished.
    await settle(c, () => c.getState().scanning === null && c.getState().lastScanMs !== null);
    expect(c.getState().books.length).toBe(11);
    expect(phases).toEqual(["loading", "ready"]);
  });

  it("reports a bad folder as an error on the pick screen, not a hang", async () => {
    const c = new AppController(platform(path.join(FIXTURE_ROOT, "does-not-exist")));
    await c.pickLibrary();
    expect(c.getState().phase).toBe("pick");
    expect(c.getState().error).toMatch(/Could not open/);
    expect(c.getState().scanning).toBeNull();
  });
});
