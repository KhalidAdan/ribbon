import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { LibraryService } from "../src/app/library";

const dirs: string[] = [];
async function library(): Promise<LibraryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-reading-records-"));
  dirs.push(dir);
  return new LibraryService(nodeHost(), dir);
}
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

describe("what was heard and transcribed, kept beside the book", () => {
  it("never loses a transcript to a smaller one: a write merges with what is there", async () => {
    const lib = await library();
    await lib.writeAligned(
      "b",
      new Map([[0, 60_000], [60_000, 120_000]]),
      [
        { startMs: 1000, endMs: 4000, words: "The waygate hung.", chars: 10 },
        { startMs: 61_000, endMs: 64_000, words: "It was a giant circle.", chars: 900 },
      ],
      new Map(),
    );
    // Opened again while the share was away: nothing read, one new minute transcribed.
    await lib.writeAligned("b", new Map([[120_000, 180_000]]), [{ startMs: 121_000, endMs: 125_000, words: "Eluadhri watched.", chars: 1800 }], new Map());
    const back = await lib.readAligned("b");
    expect([...back.spans.keys()].sort((a, b) => a - b)).toEqual([0, 60_000, 120_000]);
    expect(back.said.map((x) => x.words)).toEqual(["The waygate hung.", "It was a giant circle.", "Eluadhri watched."]);
  });

  it("keeps which model heard each minute, and when each word starts, so a minute with nothing said stays heard (#152)", async () => {
    const lib = await library();
    await lib.writeAligned(
      "b",
      new Map([[0, 60_000], [60_000, 120_000]]),
      [{ startMs: 1000, endMs: 4000, words: "The waygate hung.", chars: 10, wordMs: [1000, 1400, 2600] }],
      new Map([[0, "ggml-small-q5_1"], [60_000, "ggml-small-q5_1"]]),
    );
    const back = await lib.readAligned("b");
    // The second minute had nothing said in it: heard, by the model named, so it's kept.
    expect([...back.spans.keys()]).toEqual([0, 60_000]);
    expect(back.heardBy.get(60_000)).toBe("ggml-small-q5_1");
    expect(back.said[0]!.wordMs).toEqual([1000, 1400, 2600]);
  });

  it("merges heard places too, this device's words winning a tie", async () => {
    const lib = await library();
    await lib.writeHeard("b", new Map([[0, "one"], [90_000, "two"]]), new Map([[90_000, 500]]));
    await lib.writeHeard("b", new Map([[90_000, "two, heard again"], [180_000, "three"]]), new Map());
    const back = await lib.readHeard("b");
    expect([...back.heard]).toEqual([[0, "one"], [90_000, "two, heard again"], [180_000, "three"]]);
    expect(back.anchors.get(90_000)).toBe(500);
  });
});
