import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import type { Host } from "../src/host/host";

let root = "";

/** The node host, with the library folder read-only, as the iPhone's Files app reaches some shares. */
function readOnlyHost(): Host {
  const h = nodeHost();
  const refuse = (p: string) => {
    if (p.startsWith(root)) throw new Error(`failed to open file at path: ${p} with error: Read-only file system (os error 30)`);
  };
  return {
    ...h,
    writeFile: async (p, data) => (refuse(p), h.writeFile(p, data)),
    mkdir: async (p) => (refuse(p), h.mkdir(p)),
    remove: async (p) => (refuse(p), h.remove(p)),
    rename: async (from, to) => (refuse(from), refuse(to), h.rename(from, to)),
    ...(h.appendFile ? { appendFile: async (p: string, data: Uint8Array) => (refuse(p), h.appendFile!(p, data)) } : {}),
    ...(h.writeTextFiles ? { writeTextFiles: async (files: { path: string; text: string }[]) => (files.forEach((f) => refuse(f.path)), h.writeTextFiles!(files)) } : {}),
  };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-read-only-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
}

describe("a folder read-only from this device", () => {
  it("is said once, and stays said across starts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = memorySettings();
    const sources = memorySources();
    const platform = (): Platform => ({ host: readOnlyHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources, appSettings: settings, phone: true });

    const first = new AppController(platform());
    await first.boot();
    await first.pickLibrary();
    await until(() => first.getState().readOnlyNotice.length > 0);
    const id = first.getState().sources[0]!.id;
    expect(first.getState().readOnlyNotice).toEqual([id]);
    expect(first.getState().sourceStatus[id]!.readOnly).toBe(true);
    expect(first.here).toBe("this phone");
    first.dismissReadOnly();
    expect(first.getState().readOnlyNotice).toEqual([]);

    // The next start finds it read-only again, and Settings says so, but the library has already said it.
    const next = new AppController(platform());
    await next.boot();
    await until(() => next.getState().sourceStatus[id]?.readOnly === true);
    expect(next.getState().sourceStatus[id]!.readOnly).toBe(true);
    expect(next.getState().readOnlyNotice).toEqual([]);
    vi.restoreAllMocks();
  });
});
