import { dominantHue, toneFor, type Tone } from "../core/tint";

const cache = new Map<string, Promise<Tone | null>>();

/**
 * The tone of the image at `url`, from a 24 by 24 sample of it. Cached
 * for the session per URL. Null when the image cannot be read.
 */
export function tintFromImage(url: string): Promise<Tone | null> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise<Tone | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 24;
          canvas.height = 24;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, 24, 24);
          resolve(toneFor(dominantHue(ctx.getImageData(0, 0, 24, 24).data)));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    cache.set(url, p);
  }
  return p;
}
