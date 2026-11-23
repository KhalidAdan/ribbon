import { ArrowLeftIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onScreen, type ReadyComic } from "@ribbon/core/comic/session";
import type { ComicSettings } from "@ribbon/core/comic/settings";
import { PageWindow } from "@ribbon/core/comic/window";
import type { AppController } from "../app/controller";
import { Button } from "../ui/Button";
import { Menu, type MenuItem } from "../ui/kit";
import { useAppState, useController } from "../ui/store";
import { usePageSwipe } from "../reader/swipe";

/**
 * The comic reader (docs/COMICS.md, section 5): a comic's pages, shown
 * as they were drawn, one at a time or two as a printed comic opens. Over
 * everything, like the text reader; the page is kept as it turns.
 *
 * It shares nothing with the text reader's layout, since there is nothing
 * to lay out: a page is a picture. What it shares is what isn't about
 * text: the swipe (reader/swipe.ts) and the look of the header.
 */
export function ComicView() {
  const { r, title, settings, rightToLeft } = useAppState((s) => ({
    r: s.comic,
    title: s.comic ? (s.books.find((b) => b.book.id === s.comic!.bookId)?.book.title ?? "") : "",
    settings: s.comicSettings,
    // As a person said, else as the comic says of itself.
    rightToLeft: s.comic ? (s.comicDirections[s.comic.bookId] ?? s.books.find((b) => b.book.id === s.comic!.bookId)?.book.rightToLeft ?? false) : false,
  }));
  const c = useController();
  if (!r) return null;
  const ready = r.status === "ready" ? r : null;
  const shown = ready ? onScreen(ready, settings.up) : null;

  const view: MenuItem[] = [
    settings.up === "one" ? { label: "Two pages, as printed", onSelect: () => c.setComicSettings({ up: "two" }) } : { label: "One page at a time", onSelect: () => c.setComicSettings({ up: "one" }) },
    settings.fit === "page" ? { label: "Fit the width", onSelect: () => c.setComicSettings({ fit: "width" }) } : { label: "Fit the page", onSelect: () => c.setComicSettings({ fit: "page" }) },
    rightToLeft ? { label: "Read left to right", onSelect: () => c.setComicRightToLeft(r.bookId, false) } : { label: "Read right to left", onSelect: () => c.setComicRightToLeft(r.bookId, true) },
  ];

  return (
    <div role="dialog" aria-modal="true" aria-label={`Reading ${title || "a comic"}`} className="safe-area fixed inset-0 z-30 flex flex-col bg-canvas text-ink">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 sm:px-3">
        <Button variant="ghost" leading={ArrowLeftIcon} onClick={() => void c.closeComic()}>
          Back
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">{title}</p>
          {ready && shown && <p className="truncate text-xs/4 text-ink-3 tabular-nums">{folio(shown.pages, ready.pages.length)}</p>}
        </div>
        <Menu label="How the pages are shown" title="Pages" items={view} />
      </header>

      {r.status === "opening" && <div className="flex-1" aria-busy="true" />}
      {r.status === "failed" && (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-base/6 text-ink-2 sm:text-sm/5">
          <p className="text-base/6 font-medium text-ink sm:text-sm/5">This comic could not be opened</p>
          <p className="mt-1 max-w-md">{r.message}</p>
        </div>
      )}
      {ready && <Pages key={ready.bookId} comic={ready} settings={settings} rightToLeft={rightToLeft} c={c} />}
    </div>
  );
}

/** Where the reader is, as the header says it: "Page 3 of 24", or "Pages 2–3 of 24" with two up. */
export function folio(pages: readonly number[], of: number): string {
  const first = pages[0]! + 1;
  const last = pages[pages.length - 1]! + 1;
  return first === last ? `Page ${first} of ${of}` : `Pages ${first}–${last} of ${of}`;
}

/** A page's picture, fetched and decoded before it is needed. */
function loadPage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    const stop = () => {
      // Dropping the address stops the fetch, for a page the reader has left behind.
      img.src = "";
      reject(new Error("no longer wanted"));
    };
    signal.addEventListener("abort", stop, { once: true });
    img.onload = () => {
      signal.removeEventListener("abort", stop);
      // Decoded now, off the main thread, so drawing it later costs nothing; a browser that can't say still has the picture.
      img.decode().then(
        () => resolve(img),
        () => resolve(img),
      );
    };
    img.onerror = () => {
      signal.removeEventListener("abort", stop);
      reject(new Error("the page could not be read"));
    };
    img.src = url;
  });
}

function Pages({ comic, settings, rightToLeft, c }: { comic: ReadyComic; settings: ComicSettings; rightToLeft: boolean; c: AppController }) {
  const shown = onScreen(comic, settings.up);
  const count = comic.pages.length;

  // The window of pages around this one, fetched and decoded ahead of the reader (core/comic/window.ts).
  // Made in an effect, not while drawing: it starts fetching at once, and is let go when the comic closes.
  const pageWindow = useRef<PageWindow<HTMLImageElement> | null>(null);
  const page = useRef(comic.page);
  useEffect(() => {
    const made = new PageWindow<HTMLImageElement>(count, {
      load: async (at, signal) => {
        const url = c.comicPageUrl(at);
        if (!url) throw new Error("no address for the page");
        const img = await loadPage(url, signal);
        c.comicMeasured(comic.bookId, at, img.naturalWidth, img.naturalHeight);
        return img;
      },
      release: (_, img) => void (img.src = ""),
    });
    pageWindow.current = made;
    made.moveTo(page.current);
    return () => {
      pageWindow.current = null;
      void made.close();
    };
  }, [comic.bookId, count, c]);
  useEffect(() => {
    pageWindow.current?.moveTo(comic.page, comic.page >= page.current);
    page.current = comic.page;
  }, [comic.page]);

  const turn = (to: number | null) => {
    if (to !== null) c.turnComic(to);
  };
  // On screen, a comic read right to left goes on to the left.
  const [onLeft, onRight] = rightToLeft ? [shown.next, shown.previous] : [shown.previous, shown.next];

  // The keys a reader's hands are already on.
  const keys = useRef({ shown, onLeft, onRight, count });
  keys.current = { shown, onLeft, onRight, count };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // The page slider has the arrow keys while it has the focus.
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const k = keys.current;
      const go = (to: number | null, jump = false) => {
        e.preventDefault();
        if (to !== null) c.turnComic(to, jump ? "seek" : "periodic");
      };
      if (e.key === "ArrowRight") go(k.onRight);
      else if (e.key === "ArrowLeft") go(k.onLeft);
      else if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) go(k.shown.next);
      else if (e.key === "PageUp" || (e.key === " " && e.shiftKey)) go(k.shown.previous);
      else if (e.key === "Home") go(0, true);
      else if (e.key === "End") go(k.count - 1, true);
      else if (e.key === "Escape") {
        e.preventDefault();
        void c.closeComic();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);

  // A finger, or two on a trackpad, drags the page with the next one already beside it (reader/swipe.ts).
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);
  // The swipe's "forward" is a drag to the left: for a comic read right to left, that is the way back.
  const toward = (step: 1 | -1) => (step === 1 ? onRight : onLeft);
  const swipe = usePageSwipe({ track, width, has: (step) => toward(step) !== null, turn: (step) => turn(toward(step)) });
  // The turn has been drawn: the track goes back to the middle in the same frame.
  useLayoutEffect(() => swipe.settled(), [comic.page, settings.up]); // eslint-disable-line react-hooks/exhaustive-deps

  const neighbour = (to: number | null) => (to === null ? null : onScreen({ ...comic, page: to }, settings.up).pages);
  const fitWidth = settings.fit === "width";

  return (
    <>
      <div
        ref={viewport}
        className={clsx("relative min-h-0 flex-1 touch-pan-y select-none", fitWidth ? "overflow-x-hidden overflow-y-auto" : "overflow-hidden")}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}
        onWheel={swipe.onWheel}
      >
        <div ref={track} className={clsx("relative w-full", !fitWidth && "h-full")}>
          <Spread key={shown.pages.join("-")} pages={shown.pages} rightToLeft={rightToLeft} fitWidth={fitWidth} c={c} />
          {/* The spreads either side, already drawn where a swipe will bring them from. */}
          <Beside side="right-full" pages={neighbour(onLeft)} rightToLeft={rightToLeft} fitWidth={fitWidth} c={c} />
          <Beside side="left-full" pages={neighbour(onRight)} rightToLeft={rightToLeft} fitWidth={fitWidth} c={c} />
        </div>
        {/* A click on either side of the page turns it; the middle is the page's own. */}
        <button type="button" aria-label={rightToLeft ? "Next page" : "Previous page"} disabled={onLeft === null} onClick={() => !swipe.justSwiped() && turn(onLeft)} className="absolute inset-y-0 left-0 w-1/3 cursor-w-resize disabled:cursor-default" />
        <button type="button" aria-label={rightToLeft ? "Previous page" : "Next page"} disabled={onRight === null} onClick={() => !swipe.justSwiped() && turn(onRight)} className="absolute inset-y-0 right-0 w-1/3 cursor-e-resize disabled:cursor-default" />
      </div>

      {count > 1 && (
        <footer className="flex h-10 shrink-0 items-center gap-3 border-t border-line px-4">
          <input
            type="range"
            aria-label="Page"
            aria-valuetext={folio(shown.pages, count)}
            min={1}
            max={count}
            step={1}
            value={comic.page + 1}
            // The slider runs the way the comic reads.
            dir={rightToLeft ? "rtl" : "ltr"}
            onChange={(e) => c.turnComic(Number(e.target.value) - 1, "seek")}
            className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong accent-ink"
          />
          <p className="w-20 shrink-0 text-right text-[0.8125rem]/5 text-ink-2 tabular-nums">
            {comic.page + 1} of {count}
          </p>
        </footer>
      )}
    </>
  );
}

/** A spread waiting beside the one on screen, for a swipe to bring in. Never read out: it isn't there yet. */
function Beside({ side, pages, rightToLeft, fitWidth, c }: { side: "right-full" | "left-full"; pages: number[] | null; rightToLeft: boolean; fitWidth: boolean; c: AppController }) {
  if (!pages) return null;
  return (
    <div aria-hidden="true" className={clsx("absolute top-0 h-full w-full", side)}>
      <Spread pages={pages} rightToLeft={rightToLeft} fitWidth={fitWidth} c={c} />
    </div>
  );
}

/** One page, or two that face each other, as large as the window allows. */
function Spread({ pages, rightToLeft, fitWidth, c }: { pages: readonly number[]; rightToLeft: boolean; fitWidth: boolean; c: AppController }) {
  return (
    <div className={clsx("flex w-full items-center justify-center", !fitWidth && "h-full", rightToLeft && "flex-row-reverse")}>
      {pages.map((page) => {
        const url = c.comicPageUrl(page);
        if (!url) return null;
        return (
          <img
            key={page}
            src={url}
            alt={`Page ${page + 1}`}
            draggable={false}
            decoding="async"
            // Each page takes its share of the width; fitted to the page, it is never taller than the window either.
            style={fitWidth ? { width: `${100 / pages.length}%` } : { maxWidth: `${100 / pages.length}%` }}
            className={clsx("block object-contain", fitWidth ? "h-auto" : "max-h-full")}
          />
        );
      })}
    </div>
  );
}
