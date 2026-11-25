import { useEffect, useLayoutEffect, useRef } from "react";
import type { PixelSize } from "@ribbon/core/comic/size";

/** A page as it is drawn: which, how large on screen, and its picture when that is decoded. */
export interface Drawn {
  page: number;
  box: PixelSize;
  picture: ImageBitmap | undefined;
}

/**
 * A page, drawn from its decoded picture onto a canvas the size it shows
 * at, so what is kept for it is its size on screen, not the scan's. Until
 * its picture is decoded its place is held, empty, at its size, and
 * nothing moves when it arrives.
 */
export function PageCanvas({ page, box, picture, waiting }: Drawn & { waiting: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  /** What this canvas shows now, so a page that only moved from beside to the middle is not drawn again. */
  const shows = useRef<{ picture: ImageBitmap; width: number; height: number } | null>(null);
  const draw = () => {
    const el = canvas.current;
    if (!el || !picture) return;
    if (shows.current?.picture === picture && shows.current.width === box.width && shows.current.height === box.height) return;
    // As many pixels as the screen shows it with, and never more than the page has.
    const density = Math.min(window.devicePixelRatio || 1, picture.width / box.width);
    const [w, h] = [Math.min(picture.width, Math.max(1, Math.round(box.width * density))), Math.min(picture.height, Math.max(1, Math.round(box.height * density)))];
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(picture, 0, 0, w, h);
    shows.current = { picture, width: box.width, height: box.height };
    el.dataset.drawn = "true";
  };
  // On screen, it is drawn before the frame that shows it. Waiting beside, it is drawn once that frame has gone:
  // scaling a page down takes a few milliseconds, more on a slow machine, and the turn itself shouldn't wait on it.
  useLayoutEffect(() => {
    if (!waiting) draw();
  });
  useEffect(() => {
    if (!waiting) return;
    const later = setTimeout(draw, 0);
    return () => clearTimeout(later);
  });
  return <canvas ref={canvas} role="img" aria-label={`Page ${page + 1}`} data-page={page + 1} style={{ width: box.width, height: box.height }} className="block shrink-0" />;
}
