import { describe, expect, it } from "vitest";
import { imageSize, pageBox } from "@ribbon/core/comic/size";

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((ch) => ch.charCodeAt(0)) : p)));

describe("a picture's size from the start of its file", () => {
  it("reads a PNG's", () => {
    expect(imageSize(bytes([0x89], "PNG", [13, 10, 26, 10], [0, 0, 0, 13], "IHDR", [0, 0, 0x07, 0xc4], [0, 0, 0x0b, 0xf0], [8, 2, 0, 0, 0]))).toEqual({ width: 1988, height: 3056 });
  });

  it("reads a JPEG's, past the segments that come before the frame header", () => {
    const app0 = [0xff, 0xe0, 0, 16, ...Array(14).fill(0)];
    const exif = [0xff, 0xe1, 0, 8, 1, 2, 3, 4, 5, 6];
    const tables = [0xff, 0xdb, 0, 4, 0, 0];
    const frame = [0xff, 0xc0, 0, 17, 8, 0x0b, 0xf0, 0x07, 0xc4, 3, ...Array(9).fill(0)];
    expect(imageSize(bytes([0xff, 0xd8], app0, exif, tables, frame))).toEqual({ width: 1988, height: 3056 });
    // A progressive JPEG's frame header has another marker.
    expect(imageSize(bytes([0xff, 0xd8], app0, [0xff, 0xc2, 0, 17, 8, 0, 100, 0, 50, 3, ...Array(9).fill(0)]))).toEqual({ width: 50, height: 100 });
  });

  it("says a JPEG doesn't say yet when its frame header lies further on", () => {
    // A long segment (a colour profile, say) that these bytes end inside.
    expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xe2, 0xff, 0xff], Array(64).fill(0)))).toBeNull();
  });

  it("reads a GIF's", () => {
    expect(imageSize(bytes("GIF89a", [0x20, 0x03, 0xb0, 0x04], [0, 0]))).toEqual({ width: 800, height: 1200 });
  });

  it("reads a WebP's, in each of the ways one is written", () => {
    const riff = (kind: string, rest: number[]) => bytes("RIFF", [0, 0, 0, 0], "WEBP", kind, rest, Array(12).fill(0));
    // Extended: width and height less one, three bytes each, after the chunk's size and flags.
    expect(imageSize(riff("VP8X", [10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0, 0xaf, 0x04, 0]))).toEqual({ width: 800, height: 1200 });
    // Lossy: after the frame tag and start code, fourteen bits each.
    expect(imageSize(riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0xb0, 0x04]))).toEqual({ width: 800, height: 1200 });
    // Lossless: after a signature byte, fourteen bits each, less one, packed together.
    const packed = (800 - 1) | ((1200 - 1) << 14);
    expect(imageSize(riff("VP8L", [0, 0, 0, 0, 0x2f, packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >> 24) & 0xff]))).toEqual({ width: 800, height: 1200 });
  });

  it("is null for what isn't a picture", () => {
    expect(imageSize(bytes("<ComicInfo></ComicInfo>"))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
  });
});

describe("how large a page is drawn", () => {
  const page = { width: 2000, height: 3000 };

  it("fits the whole page in the room, by whichever of its sides is tighter", () => {
    expect(pageBox(page, 1, { width: 1100, height: 700 }, "page")).toEqual({ width: 466, height: 700 });
    expect(pageBox(page, 1, { width: 300, height: 700 }, "page")).toEqual({ width: 300, height: 450 });
  });

  it("gives each of two facing pages half the width", () => {
    expect(pageBox(page, 2, { width: 800, height: 700 }, "page")).toEqual({ width: 400, height: 600 });
  });

  it("fills the width when fitted to it, however tall that makes the page", () => {
    expect(pageBox(page, 1, { width: 1100, height: 700 }, "width")).toEqual({ width: 1100, height: 1650 });
  });

  it("shows a wide page whole", () => {
    expect(pageBox({ width: 4000, height: 3000 }, 1, { width: 1100, height: 700 }, "page")).toEqual({ width: 933, height: 700 });
  });
});
