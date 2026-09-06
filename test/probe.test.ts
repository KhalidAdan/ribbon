import { describe, expect, it } from "vitest";
import { parseProbe, ProbeError } from "../src/core/scan/probe";

const sample = JSON.stringify({
  streams: [
    { codec_type: "audio", codec_name: "aac", duration: "88.050023", sample_rate: "22050", channels: 2, tags: { language: "und" } },
    { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
  ],
  chapters: [
    { start_time: "0.000000", end_time: "2.000000", tags: { title: "One" } },
    { start_time: "2.000000", end_time: "4.5", tags: { title: "Two" } },
  ],
  format: { duration: "88.050023", tags: { title: "Chapter 10", TRACKNUMBER: "10", album: "Horus Rising" } },
});

describe("parseProbe", () => {
  it("extracts duration in ms, tags lower-cased, cover, chapters", () => {
    const r = parseProbe(sample);
    expect(r.durationMs).toBe(88_050);
    expect(r.tags.title).toBe("Chapter 10");
    expect(r.tags.tracknumber).toBe("10");
    expect(r.hasCover).toBe(true);
    expect(r.chapters).toEqual([
      { startMs: 0, endMs: 2000, title: "One" },
      { startMs: 2000, endMs: 4500, title: "Two" },
    ]);
    expect(r.codec).toBe("aac");
    expect(r.sampleRate).toBe(22_050);
    expect(r.channels).toBe(2);
  });

  it("falls back to the stream duration", () => {
    const r = parseProbe(JSON.stringify({ streams: [{ codec_type: "audio", duration: "5.5" }], format: {} }));
    expect(r.durationMs).toBe(5500);
  });

  it("treats N/A as missing", () => {
    const r = parseProbe(JSON.stringify({ streams: [{ codec_type: "audio", duration: "N/A" }], format: { duration: "N/A" } }));
    expect(r.durationMs).toBe(0);
  });

  it("rejects malformed JSON with a ProbeError naming the file", () => {
    expect(() => parseProbe("{not json", "x.mp3")).toThrow(ProbeError);
    expect(() => parseProbe("{not json", "x.mp3")).toThrow(/x\.mp3/);
  });

  it("rejects files without an audio stream", () => {
    expect(() => parseProbe(JSON.stringify({ streams: [{ codec_type: "video" }] }), "pic.jpg")).toThrow(/no audio/);
  });

  it("drops zero-length chapters and sorts", () => {
    const r = parseProbe(
      JSON.stringify({
        streams: [{ codec_type: "audio" }],
        chapters: [
          { start_time: "5", end_time: "5" },
          { start_time: "3", end_time: "4" },
          { start_time: "0", end_time: "1" },
        ],
      }),
    );
    expect(r.chapters.map((c) => c.startMs)).toEqual([0, 3000]);
    expect(r.chapters[0]!.title).toBe("");
  });
});
