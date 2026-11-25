/**
 * A picture's size in pixels, read from the first bytes of its file, with
 * nothing decoded. The comic reader needs every nearby page's shape (is it
 * drawn across two? how large is its place on screen?) long before it
 * needs the page's pixels, and decoding a scanned page costs a tenth of a
 * second and 24 MB (docs/COMICS.md, section 5).
 */
export interface PixelSize {
  width: number;
  height: number;
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

const be16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const le16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

function pngSize(b: Uint8Array): PixelSize | null {
  // The signature, then the IHDR chunk: its length, its name, width, height.
  if (b.length < 24 || b[0] !== 0x89 || !ascii(b, 1, "PNG") || !ascii(b, 12, "IHDR")) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gifSize(b: Uint8Array): PixelSize | null {
  if (b.length < 10 || !(ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return null;
  return { width: le16(b, 6), height: le16(b, 8) };
}

function jpegSize(b: Uint8Array): PixelSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  // Segment by segment to the frame header, which says the size; the ones before it hold thumbnails and colour profiles.
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    // Padding, and markers that stand alone.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // Start of frame, in any of its codings; not the tables that share the range (C4, C8, CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: be16(b, at + 7), height: be16(b, at + 5) };
    // The pictures' own data has begun, with no frame header before it.
    if (marker === 0xda) return null;
    at += 2 + be16(b, at + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): PixelSize | null {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  // Three ways a WebP is written, each saying its size differently.
  if (ascii(b, 12, "VP8X")) return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  if (ascii(b, 12, "VP8L")) {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8 ")) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  return null;
}

/**
 * The size of a JPEG, PNG, WebP or GIF from the start of its file, or
 * null when these bytes don't say: not one of those, or a JPEG whose
 * frame header lies past what was given (ask again with more of it).
 */
export function imageSize(start: Uint8Array): PixelSize | null {
  const size = pngSize(start) ?? jpegSize(start) ?? gifSize(start) ?? webpSize(start);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** How pages are fitted: the whole page in the window; as wide as the window, scrolled down; or as tall as it, a wide page moved sideways. */
export type Fit = "page" | "width" | "height";

/**
 * How large a page is drawn, in the window's own pixels: one of `across`
 * pages side by side (1, or 2 that face each other) in a space `room`
 * wide and tall. Fitted to the page, all of it shows; fitted to the
 * width, it fills its share of the width and its height is whatever that
 * makes it; fitted to the height, it is as tall as the room and as wide as
 * that makes it, past the sides for a page drawn across two. Never rounded
 * up past the room it has.
 */
export function pageBox(page: PixelSize, across: number, room: PixelSize, fit: Fit): PixelSize {
  const share = room.width / Math.max(1, across);
  const scale = fit === "width" ? share / page.width : fit === "height" ? room.height / page.height : Math.min(share / page.width, room.height / page.height);
  return { width: Math.max(1, Math.floor(page.width * scale)), height: Math.max(1, Math.floor(page.height * scale)) };
}
