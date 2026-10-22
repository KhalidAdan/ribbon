import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Host } from "../../../src/host/host.ts";

/**
 * The widths covers are made at, once, on the server: the apps draw a
 * cover at about 200 points across, at 1x, 2x and 3x (docs/SERVER.md,
 * section 7). Never wider than the picture itself.
 */
export const COVER_WIDTHS = [200, 400, 800] as const;

/** A book's cover as the apps need it to lay the shelf out before the picture arrives. */
export interface Cover {
  /** A hash of the picture: part of every size's file name, so a new picture is a new name. */
  hash: string;
  /** Width over height. */
  aspect: number;
  /** The picture's average colour, `#rrggbb`, to tint its place on the shelf. */
  colour: string;
}

/**
 * Make a book's covers from a picture file, or from the picture inside an
 * audio file, with ffmpeg: the original's hash, shape and colour, and a
 * JPEG at each width in `dir`. The picture file is tried first and the
 * audio after it, since a cover the scan names may not exist (one a
 * computer would have pulled out of the audio, in a folder that is only
 * read). Null when there's no picture to be had.
 */
export async function makeCovers(host: Host, source: { image?: string; audio?: string }, dir: string): Promise<Cover | null> {
  await mkdir(dir, { recursive: true });
  const original = path.join(dir, "original");
  const pixelFile = path.join(dir, "pixel");
  try {
    // The picture as it is, before any resizing: what its hash, shape and colour come from.
    let pulled = false;
    for (const input of [source.image, source.audio]) {
      if (!input) continue;
      pulled = (await host.run("ffmpeg", ["-v", "error", "-y", "-i", input, "-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-f", "image2", original])).code === 0;
      if (pulled) break;
    }
    if (!pulled) return null;
    const bytes = await readFile(original);
    if (bytes.length === 0) return null;
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

    const probed = await host.run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", original]);
    const stream = (JSON.parse(probed.stdout || "{}") as { streams?: { width?: number; height?: number }[] }).streams?.[0];
    if (!stream?.width || !stream.height) return null;

    // One pixel, averaged from the whole picture: three raw bytes, read back from a file because ffmpeg's output comes back as text.
    await host.run("ffmpeg", ["-v", "error", "-y", "-i", original, "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", pixelFile]);
    const colour = hexColour(await readFile(pixelFile).catch(() => Buffer.alloc(0)));

    for (const width of COVER_WIDTHS) {
      const made = await host.run("ffmpeg", ["-v", "error", "-y", "-i", original, "-vf", `scale='min(${width},iw)':-2:flags=lanczos`, "-q:v", "3", path.join(dir, `${hash}-${width}.jpg`)]);
      if (made.code !== 0) return null;
    }
    return { hash, aspect: Math.round((stream.width / stream.height) * 1000) / 1000, colour };
  } finally {
    await rm(original, { force: true });
    await rm(pixelFile, { force: true });
  }
}

/** Three bytes of RGB as `#rrggbb`; a middle grey when there aren't three. */
function hexColour(rgb: Uint8Array): string {
  if (rgb.length < 3) return "#808080";
  return `#${[rgb[0]!, rgb[1]!, rgb[2]!].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
