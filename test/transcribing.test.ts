import { describe, expect, it } from "vitest";
import { alignBook } from "../src/core/reading/align";
import { wordIndex } from "../src/core/reading/anchors";
import { BookText } from "../src/core/reading/booktext";
import { EBOOK_FORMAT } from "../src/core/ebook";
import type { Said } from "../src/core/reading/transcript";
import { HearingStalled, modelName, transcribeWhole, type TranscriptSoFar, type Transcription } from "../src/app/transcribing";

const TEXT = "The waygate hung in the void before them. Eluadhri watched the runes along its rim kindle one by one.";

/** A book this long (three minutes), nothing transcribed, heard by `hear`. */
function job(hear: Transcription["hear"], still = () => true, durationMs = 180_000): Transcription & { transcript: TranscriptSoFar; kept: number } {
  const text = new BookText({ format: EBOOK_FORMAT, meta: { title: "T", authors: [], identifiers: [] }, layout: "reflowable", sections: [{ href: "a.xhtml", linear: true, overlay: null, chars: TEXT.length, blocks: [{ k: "p", runs: [{ t: TEXT }] }] }], toc: [] });
  const alignment = alignBook(text, [{ title: "One", startMs: 0, endMs: durationMs }], durationMs, { generated: false, fixes: [], heard: new Map(), anchors: [] });
  const j = {
    transcript: { spans: new Map(), heardBy: new Map(), said: [], aligned: new Map(), dirty: false },
    files: [{ path: "/book/one.mp3", durationMs }],
    index: wordIndex(text),
    alignment: () => alignment,
    hear,
    model: "ggml-small-q5_1",
    keep: async () => {
      j.kept++;
    },
    progress: () => undefined,
    still,
    kept: 0,
  };
  return j;
}

const phrase = (startMs: number, words: string): Said => ({ startMs, endMs: startMs + 3000, words });

describe("transcribing a book whole (#152)", () => {
  it("hears every minute in order, keeps one with nothing said by the model that heard it, and hears one that failed again", async () => {
    const asked: number[][] = [];
    let failed = false;
    const j = job(async (clips) => {
      asked.push(clips.map((c) => c.startMs));
      return clips.map((c) => {
        // The second minute fails the first time it's heard.
        if (c.startMs === 60_000 && !failed) return (failed = true), null;
        return c.startMs === 0 ? [phrase(1000, "The waygate hung in the void before them.")] : [];
      });
    });
    expect(await transcribeWhole(j)).toBe("whole");
    // From the start, in order; then only the minute that failed.
    expect(asked).toEqual([[0, 60_000, 120_000], [60_000]]);
    expect([...j.transcript.spans.keys()].sort((a, b) => a - b)).toEqual([0, 60_000, 120_000]);
    expect([...j.transcript.heardBy.values()]).toEqual(["ggml-small-q5_1", "ggml-small-q5_1", "ggml-small-q5_1"]);
    expect(j.transcript.said.map((s) => [s.startMs, s.chars])).toEqual([[1000, 0]]);
    expect(j.kept).toBe(2);
  });

  it("stops when none of a call's minutes could be heard, keeping nothing of them", async () => {
    const j = job(async (clips) => clips.map(() => null));
    expect(await transcribeWhole(j)).toBe("failed");
    expect(j.transcript.spans.size).toBe(0);
  });

  it("stops when told to, keeping what it got to", async () => {
    let calls = 0;
    const j = job(
      async (clips) => (calls++, clips.map(() => [])),
      () => calls === 0,
      600_000,
    );
    expect(await transcribeWhole(j)).toBe("stopped");
    // Ten minutes, eight to a call: told to stop after the first.
    expect(calls).toBe(1);
    expect(j.transcript.spans.size).toBe(8);
  });

  it("gives up on a call that never answers (#158), keeping the minutes heard before it", async () => {
    let calls = 0;
    const j = job(
      (clips) => (calls++ === 0 ? Promise.resolve(clips.map(() => [])) : new Promise(() => undefined)),
      () => true,
      600_000,
    );
    j.deadlineMs = 20;
    await expect(transcribeWhole(j)).rejects.toBeInstanceOf(HearingStalled);
    // The first call's eight minutes are kept; the call that never answered keeps nothing.
    expect(j.transcript.spans.size).toBe(8);
    expect(j.kept).toBe(1);
  });

  it("names a model by its file", () => {
    expect(modelName("/Users/k/Library/Application Support/Ribbon/models/ggml-small-q5_1.bin")).toBe("ggml-small-q5_1");
    expect(modelName("C:\\Ribbon\\models\\ggml-base.bin")).toBe("ggml-base");
  });
});
