import { describe, expect, it } from "vitest";
import { nodeHost } from "@ribbon/host-node/node";
import { AppController, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";

/**
 * Where the player streams a book's audio from (#226): Apple's webview
 * refuses an .m4b through the asset protocol, so there the platform serves
 * every audio file itself; elsewhere the asset protocol plays them all.
 */
describe("the player's audio URL", () => {
  const platform = (extra: Partial<Platform> = {}): Platform => ({
    host: nodeHost(),
    pickFolder: async () => null,
    allowFolder: async () => undefined,
    fileUrl: (p) => `asset://localhost/${encodeURIComponent(p)}`,
    sources: memorySources(),
    ...extra,
  });
  const book = "/Users/k/Ribbon/servers/s/cc51fe93c19c3eb0/The High Kâhl's Oath.m4b";

  it("comes from the platform's own audio route where it has one, as on the Mac", () => {
    const c = new AppController(platform({ audioUrl: (p) => `ribbonaudio://localhost/?path=${encodeURIComponent(p)}` }));
    expect(c.audioUrlOf(book)).toBe(`ribbonaudio://localhost/?path=${encodeURIComponent(book)}`);
  });

  it("is the file's own URL everywhere else, as on the PC", () => {
    const c = new AppController(platform());
    expect(c.audioUrlOf(book)).toBe(`asset://localhost/${encodeURIComponent(book)}`);
  });
});
