import { dominantHue, toneFor, type Tone } from "@ribbon/core/tint";

/** A cover's hue (0 to 1), null for a grey cover, undefined for one that can't be read. */
type Hue = number | null | undefined;

const hues = new Map<string, Promise<Hue>>();

/**
 * The hue of the image at `url`, from a 24 by 24 sample of it. Cached for
 * the session per URL, so the shelf's spines and a book's page ask once.
 */
export function hueFromImage(url: string): Promise<Hue> {
  let p = hues.get(url);
  if (!p) {
    p = new Promise<Hue>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 24;
          canvas.height = 24;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(undefined);
          ctx.drawImage(img, 0, 0, 24, 24);
          resolve(dominantHue(ctx.getImageData(0, 0, 24, 24).data));
        } catch {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = url;
    });
    hues.set(url, p);
  }
  return p;
}

/** The tone of the image at `url`, for a book's page. Null when the image cannot be read. */
export async function tintFromImage(url: string): Promise<Tone | null> {
  const hue = await hueFromImage(url);
  return hue === undefined ? null : toneFor(hue);
}
