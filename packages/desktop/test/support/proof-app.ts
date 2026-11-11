import { vi } from "vitest";
import { EBOOK_FORMAT, type Ebook } from "@ribbon/core/ebook";
import type { Host } from "@ribbon/core/host";
import type { Platform } from "../../src/app/controller";
import { memorySources } from "../../src/app/platform";
import { Held, MemoryHost } from "./memory-host";
import { FakeMedia } from "./fake-media";

/** Where the proofs' library is, in memory. */
export const ROOT = "/books";

const MINUTE = 60_000;

/** A text of two chapters, two paragraphs each, named as the audio's are. */
function model(title: string): Ebook {
  const p = (t: string) => ({ k: "p" as const, runs: [{ t }] });
  const one = ["The lamp was lit at dusk, and the keeper sat down with the ledger.", "Nobody came to the door that night."];
  const two = ["By morning the sea was calm and grey.", "The keeper wrote it down and slept."];
  return {
    format: EBOOK_FORMAT,
    meta: { title, authors: ["Ann Writer"], identifiers: [{ scheme: "isbn", value: "9781836093152" }] },
    layout: "reflowable",
    sections: [
      { href: "one.xhtml", linear: true, overlay: null, chars: one.join("").length, blocks: one.map(p) },
      { href: "two.xhtml", linear: true, overlay: null, chars: two.join("").length, blocks: two.map(p) },
    ],
    toc: [
      { label: "Chapter One", section: 0, block: 0, depth: 0 },
      { label: "Chapter Two", section: 1, block: 0, depth: 0 },
    ],
  };
}

/**
 * The books every proof opens: "Paired", an audiobook of two one-minute
 * chapters with its EPUB beside it; "Only", an EPUB alone; and "Broken",
 * an EPUB that can't be read.
 */
export function proofLibrary(): MemoryHost {
  const m = new MemoryHost(
    {
      "Ann Writer/Paired/one.mp3": { durationMs: MINUTE, chapters: [{ title: "Chapter One", startMs: 0, endMs: MINUTE }], tags: { album: "Paired", artist: "Ann Writer", title: "Chapter One" } },
      "Ann Writer/Paired/two.mp3": { durationMs: MINUTE, chapters: [{ title: "Chapter Two", startMs: 0, endMs: MINUTE }], tags: { album: "Paired", artist: "Ann Writer", title: "Chapter Two" } },
    },
    {
      "Ann Writer/Paired/Paired.epub": { title: "Paired", author: "Ann Writer" },
      "Only.epub": { title: "Only", author: "Ann Writer" },
      "Broken.epub": { title: "Broken", author: "Ann Writer" },
    },
  );
  m.put(`${ROOT}/Ann Writer/Paired/one.mp3`, "a".repeat(100));
  m.put(`${ROOT}/Ann Writer/Paired/two.mp3`, "b".repeat(100));
  m.put(`${ROOT}/Ann Writer/Paired/Paired.epub`, "PK1");
  m.put(`${ROOT}/Only.epub`, "PK2");
  m.put(`${ROOT}/Broken.epub`, "PK3");
  return m;
}

/** What the proofs hold back until an event lets it go. */
export class Holds {
  /** EPUBs opening, while texts load slowly. */
  texts = new Held<void>();
  slowTexts = false;
  /** The read-along export, until it ends. */
  exports = new Held<string>();
}

/** The host the proofs' controllers run on: the memory library, with EPUBs and the export it can hold back. */
export function proofHost(m: MemoryHost, holds: Holds, over: Partial<Host> = {}): Host {
  return m.host({
    openEbook: async (p) => {
      if (holds.slowTexts) await holds.texts.wait();
      if (p.endsWith("Broken.epub")) throw new Error("unreadable: not a zip file");
      const title = p.endsWith("Only.epub") ? "Only" : "Paired";
      return JSON.stringify(model(title));
    },
    exportEbook: () => holds.exports.wait(),
    ...over,
  });
}

/** A platform for one run: the library already added (or these folders), a fixed device id, the settings in memory. */
export function proofPlatform(host: Host, extra: Partial<Platform> = {}, roots: readonly string[] = [ROOT]): Platform {
  let settings: Record<string, unknown> = { deviceId: "proof-device" };
  const sources = memorySources();
  void sources.save(roots.map((root) => ({ root, addedAt: "2026-11-01T00:00:00.000Z" })));
  return {
    host,
    pickFolder: async () => ROOT,
    allowFolder: async () => undefined,
    fileUrl: (p) => `file://${p}`,
    sources,
    appSettings: { read: async () => ({ ...settings }), write: async (s) => void (settings = { ...s }) },
    ...extra,
  };
}

/** setImmediate as it really is: a turn of the event loop, which runs every promise waiting. */
const realImmediate = globalThis.setImmediate;
const turn = () => new Promise<void>((r) => realImmediate(() => r()));

/**
 * Let everything that can run, run: every promise, and the timers due in
 * the next quarter second. Always the same amount of time, so old and new
 * see their timers fire at the same steps.
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await turn();
  await vi.advanceTimersByTimeAsync(250);
  for (let i = 0; i < 4; i++) await turn();
}

/** Fake time (but not setImmediate, which `settle` turns the loop with), fake audio, and a quiet log. */
export function proofWorld(): () => void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  FakeMedia.reset();
  // Paired's two files, a minute each, as the player is given them.
  for (const f of ["one", "two"]) FakeMedia.durations.set(`file://${ROOT}/Ann Writer/Paired/${f}.mp3`, 60);
  vi.stubGlobal("Audio", FakeMedia);
  const quiet = [vi.spyOn(console, "info").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
  return () => {
    for (const q of quiet) q.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  };
}
