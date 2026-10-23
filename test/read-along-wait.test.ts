import { describe, expect, it } from "vitest";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { nodeHost } from "../src/host/node";

/** What the reader calls as transcribing goes, and what it keeps between calls (controller.ts, hearPlaces). */
interface Waiting {
  waitForReadAlong(bookId: string, done: number, total: number): void;
  readAlongReady(bookId: string, resume?: boolean): void;
  msPerSpan: number | null;
}

async function started(settings = memorySettings()) {
  const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings };
  const c = new AppController(platform);
  await c.boot();
  return { c, inside: c as unknown as Waiting };
}

describe("waiting for read-along before playing", () => {
  it("is what Ribbon does unless told otherwise, and says how far it has got", async () => {
    const { c, inside } = await started();
    expect(c.getState().readAlongMode).toBe("wait");
    inside.waitForReadAlong("book", 3, 10);
    expect(c.getState().readAlongWait).toEqual({ bookId: "book", done: 3, total: 10, leftMs: null });
    // Once a stretch has been timed, how long is left.
    inside.msPerSpan = 600;
    inside.waitForReadAlong("book", 4, 10);
    expect(c.getState().readAlongWait?.leftMs).toBe(3_600);
    // All of it transcribed: nothing to wait for.
    inside.waitForReadAlong("book", 10, 10);
    expect(c.getState().readAlongWait).toBeNull();
  });

  it("lets the listener play anyway, for that book, from then on", async () => {
    const { c, inside } = await started();
    inside.waitForReadAlong("book", 1, 10);
    c.playAnyway();
    expect(c.getState().readAlongWait).toBeNull();
    inside.waitForReadAlong("book", 2, 10);
    expect(c.getState().readAlongWait).toBeNull();
    inside.waitForReadAlong("another", 2, 10);
    expect(c.getState().readAlongWait?.bookId).toBe("another");
  });

  it("can be turned off in Settings, which lifts a wait, and stays off", async () => {
    const settings = memorySettings();
    const { c, inside } = await started(settings);
    inside.waitForReadAlong("book", 1, 10);
    c.setReadAlongMode("play");
    expect(c.getState().readAlongWait).toBeNull();
    inside.waitForReadAlong("book", 2, 10);
    expect(c.getState().readAlongWait).toBeNull();
    const again = await started(settings);
    expect(again.c.getState().readAlongMode).toBe("play");
  });

  it("ends when transcribing stops part way, without starting playback", async () => {
    const { c, inside } = await started();
    inside.waitForReadAlong("book", 1, 10);
    inside.readAlongReady("book", false);
    expect(c.getState().readAlongWait).toBeNull();
    expect(c.getState().player.playing).toBe(false);
  });
});
