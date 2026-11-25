import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { closeOn, stepped, wholeOn, type Panel } from "@ribbon/core/comic/panels";
import type { ReadyComic } from "@ribbon/core/comic/session";
import type { PixelSize } from "@ribbon/core/comic/size";
import type { AppController } from "../app/controller";
import { usePagePicture } from "./PanelEditor";

/**
 * A comic read a panel at a time (docs/COMICS.md, section 14), where its
 * panels are marked: one panel fills the room the reader has, with
 * nothing else of the page showing, and each step glides to the next.
 * Past a page's last panel is the next page's first; back past its first
 * is the page before, at its last. A page nobody has marked is shown
 * whole, and a step turns it.
 *
 * Right, Space and Page Down go on, Left and Page Up go back (the arrows
 * swap in a comic that reads right to left); a click on either side does
 * the same. The page is drawn once and moved, as the Apple apps move it,
 * by core's arithmetic (`closeOn`, core/comic/panels.ts).
 */
export function PanelReader({ comic, panels, rightToLeft, c }: { comic: ReadyComic; panels: Map<number, Panel[]>; rightToLeft: boolean; c: AppController }) {
  const count = comic.pages.length;
  const here = panels.get(comic.page) ?? [];
  const [at, setAt] = useState(0);
  /** A page come back to from the one after it comes in at its last panel, since that is where the reader left off. */
  const arrivesAtEnd = useRef(false);
  // Another page: from its first panel, or its last. Before the frame that shows it, so no other panel flashes by.
  const shownPage = useRef(comic.page);
  if (shownPage.current !== comic.page) {
    shownPage.current = comic.page;
    const to = arrivesAtEnd.current ? Math.max(0, here.length - 1) : 0;
    arrivesAtEnd.current = false;
    if (to !== at) setAt(to);
  }

  /** Onward or back: to the next panel or the one before, and to another page past the page's last or its first. */
  const step = (by: 1 | -1) => {
    const to = here.length > 0 ? stepped(at, by, here.length) : null;
    if (to !== null) return setAt(to);
    const page = comic.page + by;
    if (page < 0 || page >= count) return;
    arrivesAtEnd.current = by === -1;
    c.turnComic(page);
  };

  const keys = useRef({ step, rightToLeft });
  keys.current = { step, rightToLeft };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = keys.current;
      const go = (by: 1 | -1) => {
        e.preventDefault();
        k.step(by);
      };
      if (e.key === "ArrowRight") go(k.rightToLeft ? -1 : 1);
      else if (e.key === "ArrowLeft") go(k.rightToLeft ? 1 : -1);
      else if (e.key === "PageDown" || e.key === "ArrowDown" || (e.key === " " && !e.shiftKey)) go(1);
      else if (e.key === "PageUp" || e.key === "ArrowUp" || (e.key === " " && e.shiftKey)) go(-1);
      else if (e.key === "Escape") {
        e.preventDefault();
        void c.closeComic();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);

  const picture = usePagePicture(c, comic.page);
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<PixelSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setRoom({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);

  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !picture) return;
    // Drawn once at the page's own size: a panel is a part of it enlarged, and wants every pixel the scan has.
    el.width = picture.width;
    el.height = picture.height;
    el.getContext("2d")?.drawImage(picture.bitmap, 0, 0);
  }, [picture]);

  const panel = here[at];
  const placed = picture && room.width > 0 ? (panel ? closeOn(panel, picture, room) : wholeOn(picture, room)) : null;
  // A page just arrived is simply there; from panel to panel of one page, it glides.
  const glides = useRef<number | null>(null);
  const glide = glides.current === comic.page;
  useEffect(() => {
    if (placed) glides.current = comic.page;
  });
  const moving = glide ? "transition-[width,height,transform] duration-300 ease-in-out motion-reduce:transition-none" : "";
  const [onLeft, onRight] = rightToLeft ? ([1, -1] as const) : ([-1, 1] as const);

  return (
    <div ref={stage} data-panel-reader data-panel={panel ? at + 1 : 0} className="relative min-h-0 flex-1 overflow-hidden select-none">
      {placed && picture && (
        <div className={`absolute top-1/2 left-1/2 -translate-1/2 overflow-hidden ${moving}`} style={{ width: placed.width, height: placed.height }}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={panel ? `Page ${comic.page + 1}, panel ${at + 1} of ${here.length}` : `Page ${comic.page + 1}`}
            className={`absolute top-1/2 left-1/2 max-w-none ${moving}`}
            style={{ width: picture.width * placed.scale, height: picture.height * placed.scale, transform: `translate(-50%, -50%) translate(${placed.x}px, ${placed.y}px)` }}
          />
        </div>
      )}
      {/* A click on either side steps; the middle is the page's own. The keys do the same, so these are a pointer's alone and take no focus. */}
      <button type="button" tabIndex={-1} aria-label={rightToLeft ? "Onward" : "Back"} onMouseDown={(e) => e.preventDefault()} onClick={() => step(onLeft)} className="absolute inset-y-0 left-0 w-1/3 cursor-w-resize outline-none" />
      <button type="button" tabIndex={-1} aria-label={rightToLeft ? "Back" : "Onward"} onMouseDown={(e) => e.preventDefault()} onClick={() => step(onRight)} className="absolute inset-y-0 right-0 w-1/3 cursor-e-resize outline-none" />
    </div>
  );
}
