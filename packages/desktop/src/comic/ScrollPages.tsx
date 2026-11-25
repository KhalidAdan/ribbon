import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { comicKey } from "@ribbon/core/comic/keys";
import { columnNarrower, columnWider, COLUMNS, keptReading, pageReading, pagesShowing, scrollLayout, type ScrollLayout } from "@ribbon/core/comic/scroll";
import type { ReadyComic } from "@ribbon/core/comic/session";
import type { ComicSettings } from "@ribbon/core/comic/settings";
import type { PixelSize } from "@ribbon/core/comic/size";
import { DECODED, type WindowSize } from "@ribbon/core/comic/window";
import type { AppController } from "../app/controller";
import type { SharedPdf } from "./document";
import { usePageWindows } from "./page-windows";
import { PageCanvas } from "./PageCanvas";
import { readerKey } from "./reader-keys";

/**
 * One long scroll (docs/COMICS.md, section 15): the comic's pages one under
 * another, as wide as the window and never wider than they were drawn, for
 * comics drawn as a single column and for reading a chapter without
 * turning. The page being read is the one filling the window's top third.
 *
 * Only the pages near the window are decoded and drawn, by the same
 * windows as turning (page-windows.ts); the rest are spaces the size their
 * page is, or is taken to be until it is fetched (core/comic/scroll.ts),
 * so the scroll bar is right from the start and a 600-page book costs what
 * an issue does. The slider, the strip, going to a page and the keys all
 * move it; `+` and `-` make the column wider or narrower. Two pages up and
 * reading by panels don't apply here.
 */
export function ScrollPages({ comic, settings, rightToLeft, c, pdf, ground }: { comic: ReadyComic; settings: ComicSettings; rightToLeft: boolean; c: AppController; pdf: SharedPdf | null; ground: string | undefined }) {
  const count = comic.pages.length;
  const viewport = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<PixelSize>({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  // As many pages decoded as show at once, and one either side; at least the window turning keeps.
  const [decodedSize, setDecodedSize] = useState<WindowSize>(DECODED);
  const { decoded, sizes } = usePageWindows(comic, c, pdf, decodedSize);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setRoom((was) => (was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);

  // Laid out again only when something it is made from changes: a page's size learned, the window, the column.
  const known = sizes.current.size;
  const layout = useMemo(() => scrollLayout(sizes.current, count, room.width, settings.column), [known, count, room.width, settings.column]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The page the scroll was last at, as it told the reader: a page asked for from anywhere else is scrolled to. */
  const reading = useRef(comic.page);
  /** The layout the view was last placed by, so a new one keeps what is being read where it was. */
  const placedBy = useRef<ScrollLayout | null>(null);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || !layout) return;
    const before = placedBy.current;
    placedBy.current = layout;
    if (!before) {
      // First laid out: at the page the comic opened at, its top at the window's.
      el.scrollTop = layout.tops[comic.page]!;
    } else if (comic.page !== reading.current) {
      // A page asked for by the slider, the strip, a key or Go to page.
      el.scrollTop = layout.tops[comic.page]!;
    } else if (before !== layout) {
      el.scrollTop = keptReading(before, layout, el.scrollTop);
    } else return;
    reading.current = comic.page;
    setScrollTop(el.scrollTop);
  }, [layout, comic.page]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = viewport.current;
    if (!el || !layout) return;
    setScrollTop(el.scrollTop);
    const now = pageReading(layout, el.scrollTop, el.clientHeight);
    if (now === reading.current) return;
    reading.current = now;
    c.turnComic(now);
  };

  const showing = layout ? pagesShowing(layout, scrollTop, room.height) : { first: comic.page, last: comic.page };
  useEffect(() => {
    const behind = Math.max(DECODED.behind, comic.page - showing.first + 1);
    const ahead = Math.max(DECODED.ahead, showing.last - comic.page + 1);
    setDecodedSize((was) => (was.behind === behind && was.ahead === ahead ? was : { behind, ahead }));
  }, [comic.page, showing.first, showing.last]);

  // The reader's keys, in a scroll: the arrows across go a page at a time, the way the comic reads; up and down, Space
  // and Page Up and Down move the view; `+`, `-` and `0` the column.
  const keys = useRef({ rightToLeft, count, column: settings.column });
  keys.current = { rightToLeft, count, column: settings.column };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!readerKey(e)) return;
      const el = viewport.current;
      const k = keys.current;
      const page = (by: 1 | -1) => {
        const to = (c.getState().comic?.status === "ready" ? (c.getState().comic as ReadyComic).page : 0) + by;
        if (to >= 0 && to < k.count) c.turnComic(to);
      };
      const by = (part: number) => el?.scrollBy({ top: part * el.clientHeight });
      const action = comicKey(e.key);
      let used = true;
      if (e.key === "ArrowRight") page(k.rightToLeft ? -1 : 1);
      else if (e.key === "ArrowLeft") page(k.rightToLeft ? 1 : -1);
      else if (e.key === "ArrowDown") by(0.15);
      else if (e.key === "ArrowUp") by(-0.15);
      else if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) by(0.85);
      else if (e.key === "PageUp" || (e.key === " " && e.shiftKey)) by(-0.85);
      else if (e.key === "Home") c.turnComic(0, "seek");
      else if (e.key === "End") c.turnComic(k.count - 1, "seek");
      else if (action === "zoom-in") c.setComicSettings({ column: columnWider(k.column) });
      else if (action === "zoom-out") c.setComicSettings({ column: columnNarrower(k.column) });
      else if (action === "zoom-whole") c.setComicSettings({ column: COLUMNS[COLUMNS.length - 1]! });
      else if (e.key === "Escape") void c.closeComic();
      else used = false;
      if (used) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);

  // The pages showing, and one either side, have their places drawn; the rest of the scroll is space.
  const near: number[] = [];
  if (layout) for (let at = Math.max(0, showing.first - 1); at <= Math.min(count - 1, showing.last + 1); at++) near.push(at);

  return (
    <div ref={viewport} data-comic-scroll role="presentation" onScroll={onScroll} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto select-none" style={{ backgroundColor: ground }}>
      {layout && (
        <div className="relative w-full" style={{ height: layout.total }}>
          {near.map((at) => {
            const picture = decoded.current?.peek(at);
            const box = { width: layout.widths[at]!, height: layout.heights[at]! };
            return (
              <div key={at} data-scroll-page={at + 1} {...(at === comic.page ? { "data-reading": true } : {})} className="absolute left-1/2 -translate-x-1/2" style={{ top: layout.tops[at], width: box.width, height: box.height }}>
                {picture && <PageCanvas page={at} box={box} picture={picture} waiting={false} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
