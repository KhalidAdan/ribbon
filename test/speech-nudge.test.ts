import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { nodeHost } from "../src/host/node";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-nudge-"));
  // One book in both editions, and one with its audio alone.
  for (const folder of ["Both", "Heard"]) {
    await fs.mkdir(path.join(root, folder));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-b:a", "64k", path.join(root, folder, "01.mp3")]);
  }
  await fs.writeFile(path.join(root, "Both", "book.epub"), "PK");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The app on a computer (or a phone) whose host can download the speech model. */
async function started(opts: { phone?: boolean; settings?: ReturnType<typeof memorySettings> } = {}) {
  const download = vi.fn(async () => path.join(root, "ggml-base-q5_1.bin"));
  const platform: Platform = { host: { ...nodeHost(), downloadSpeechModel: download }, pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: opts.settings ?? memorySettings(), ...(opts.phone ? { phone: true } : {}) };
  const c = new AppController(platform);
  await c.boot();
  await c.pickLibrary();
  const id = (folder: string) => c.getState().books.find((b) => b.book.path === folder)!.book.id;
  return { c, download, both: id("Both"), heard: id("Heard") };
}

describe("the speech model, suggested once", () => {
  it("is suggested the first time a book in both editions opens, and only then", async () => {
    const settings = memorySettings();
    const { c, both, heard } = await started({ settings });
    c.openReader(heard);
    expect(c.getState().speechNudge).toBe(false);
    c.openReader(both);
    expect(c.getState().speechNudge).toBe(true);
    c.dismissSpeechNudge();
    expect(c.getState().speechNudge).toBe(false);
    c.openReader(both);
    expect(c.getState().speechNudge).toBe(false);

    // The next start on this device remembers it was said.
    const again = await started({ settings });
    again.c.openReader(again.both);
    expect(again.c.getState().speechNudge).toBe(false);
  });

  it("downloads the model from the suggestion, and isn't said on a device that has one", async () => {
    const { c, download, both } = await started();
    c.openReader(both);
    await c.downloadSpeechModelFromNudge();
    expect(download).toHaveBeenCalledTimes(1);
    expect(c.getState().speechNudge).toBe(false);
    expect(c.getState().speech.model).toBe(path.join(root, "ggml-base-q5_1.bin"));
  });

  it("isn't said on a phone, which doesn't transcribe", async () => {
    const { c, both } = await started({ phone: true });
    c.openReader(both);
    expect(c.getState().speechNudge).toBe(false);
  });
});
