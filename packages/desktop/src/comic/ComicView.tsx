import { ArrowLeftIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { onScreen, type ReadyComic } from "@ribbon/core/comic/session";
import type { ComicSettings } from "@ribbon/core/comic/settings";
import { imageSize, pageBox, type PixelSize } from "@ribbon/core/comic/size";
import { DECODED, DECODED_FACING, PageWindow } from "@ribbon/core/comic/window";
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

/**
 * A page known and not yet drawn: the size its picture will be, and, for a
 * comic's page, its file's bytes. A PDF's page has no file of its own; it
 * is drawn out of the PDF (pdf.ts).
 */
interface Fetched extends PixelSize {
  file?: Blob;
}

/** How much of a file is read to learn its picture's size: a JPEG's says after its thumbnail and colour profile. */
const HEADER_BYTES = 256 * 1024;

/**
 * Fetch a page's file and read its size from its first bytes. Nothing is
 * decoded: that is the dear part, done only for the nearest pages.
 */
async function fetchPage(address: string, signal: AbortSignal): Promise<Fetched> {
  const answer = await fetch(address, { signal });
  if (!answer.ok) throw new Error("the page could not be read");
  const file = await answer.blob();
  const start = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  let size = imageSize(start) ?? (file.size > HEADER_BYTES ? imageSize(new Uint8Array(await file.arrayBuffer())) : null);
  if (!size) {
    // A file whose header doesn't say: decode it once to ask.
    const picture = await createImageBitmap(file);
    size = { width: picture.width, height: picture.height };
    picture.close();
  }
  return { file, ...size };
}

function Pages({ comic, settings, rightToLeft, c }: { comic: ReadyComic; settings: ComicSettings; rightToLeft: boolean; c: AppController }) {
  const shown = onScreen(comic, settings.up);
  const count = comic.pages.length;

  // Two windows around this page (core/comic/window.ts). The wide one keeps pages fetched: their files, a megabyte
  // or two each, which is the wait over a network share. The narrow one keeps the nearest decoded, which is the
  // wait at the turn itself, and what memory makes dear: 24 MB for a scanned page. Ribbon holds the decoded
  // pictures itself and frees each the moment it leaves the window; left to the web view as <img>s, they stayed
  // in its cache, 1.3 GB of them after a few dozen turns, closed comic and all (measured in the Mac build).
  // Made in an effect: they start fetching at once, and are let go when the comic closes.
  const fetched = useRef<PageWindow<Fetched> | null>(null);
  const decoded = useRef<PageWindow<ImageBitmap> | null>(null);
  const page = useRef(comic.page);
  const up = useRef(settings.up);
  up.current = settings.up;
  // Drawn again when a page's file or picture lands.
  const [, landed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // A PDF is opened once, when its reader opens, and its pages are drawn out of it; pdf.js comes with the first PDF.
    const document = c.comicDocument();
    const pdf = document ? import("./pdf").then((m) => m.openWebPdf(document.url, document.bytes)) : null;
    pdf?.catch(() => undefined);
    // A PDF's page is drawn as large as this screen could show it, and no larger.
    const longest = Math.min(4096, Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1) * 1.6);
    const files = new PageWindow<Fetched>(count, {
      load: async (at, signal) => {
        const address = pdf ? null : c.comicPageUrl(at);
        if (!pdf && !address) throw new Error("no address for the page");
        const file = pdf ? await (await pdf).size(at) : await fetchPage(address!, signal);
        c.comicMeasured(comic.bookId, at, file.width, file.height);
        return file;
      },
      landed,
    });
    const pictures = new PageWindow<ImageBitmap>(
      count,
      {
        load: async (at) => {
          const file = await files.get(at);
          if (!file) throw new Error("the page's file didn't arrive");
          if (pdf) return (await pdf).picture(at, longest);
          return createImageBitmap(file.file!);
        },
        release: (_, picture) => picture.close(),
        landed,
      },
      up.current === "two" ? DECODED_FACING : DECODED,
    );
    fetched.current = files;
    decoded.current = pictures;
    files.moveTo(page.current);
    pictures.moveTo(page.current);
    return () => {
      fetched.current = null;
      decoded.current = null;
      // The PDF last: the pages still being drawn are drawn out of it.
      void Promise.all([pictures.close(), files.close()]).then(() => pdf?.then((open) => open.close(), () => undefined));
    };
  }, [comic.bookId, count, c]);
  useEffect(() => {
    const forward = comic.page >= page.current;
    fetched.current?.moveTo(comic.page, forward);
    // Two pages up, the spreads either side are four pages, not two.
    decoded.current?.resize(settings.up === "two" ? DECODED_FACING : DECODED);
    decoded.current?.moveTo(comic.page, forward);
    page.current = comic.page;
  }, [comic.page, settings.up]);

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

  // The room the pages have, measured: a page's size on screen is worked out from it (core/comic/size.ts).
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<PixelSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setRoom((was) => (was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);

  // A finger, or two on a trackpad, drags the page with the next one already beside it (reader/swipe.ts).
  // The swipe's "forward" is a drag to the left: for a comic read right to left, that is the way back.
  const toward = (step: 1 | -1) => (step === 1 ? onRight : onLeft);
  const swipe = usePageSwipe({ track, width: room.width, has: (step) => toward(step) !== null, turn: (step) => turn(toward(step)) });
  // The turn has been drawn: the track goes back to the middle in the same frame.
  useLayoutEffect(() => swipe.settled(), [comic.page, settings.up]); // eslint-disable-line react-hooks/exhaustive-deps

  const neighbour = (to: number | null) => (to === null ? null : onScreen({ ...comic, page: to }, settings.up).pages);
  const fitWidth = settings.fit === "width";
  /** One page of a spread, as it is drawn now: its place on screen, and its picture once that has been decoded. */
  const drawn = (at: number, across: number): Drawn | null => {
    const file = fetched.current?.peek(at);
    if (!file || room.width === 0) return null;
    return { page: at, box: pageBox(file, across, room, settings.fit), picture: decoded.current?.peek(at) };
  };
  /** The spreads to have drawn: the one on screen, and its neighbours on the side each will come in from. */
  const beside: { side: "left" | "middle" | "right"; pages: number[] }[] = [
    ...(neighbour(onLeft) ? [{ side: "left" as const, pages: neighbour(onLeft)! }] : []),
    { side: "middle", pages: shown.pages },
    ...(neighbour(onRight) ? [{ side: "right" as const, pages: neighbour(onRight)! }] : []),
  ];

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
        <div ref={track} data-comic-track className={clsx("relative w-full will-change-transform", !fitWidth && "h-full")}>
          {/* The spread on screen and the one either side, already drawn where a swipe will bring it from. Each is
              known by its pages, so at a turn the spread coming in is the one that was waiting beside: it moves to
              the middle as it is, nothing drawn again, and only the new one waiting is drawn, after the turn shows. */}
          {beside.map((b) => (
            <div
              key={b.pages.join("-")}
              {...(b.side === "middle" ? { "data-on-screen": true } : { "aria-hidden": true })}
              className={clsx(b.side === "middle" ? "relative w-full" : "absolute top-0 w-full", (b.side !== "middle" || !fitWidth) && "h-full", b.side === "left" && "right-full", b.side === "right" && "left-full")}
            >
              <div className={clsx("flex w-full items-center justify-center", !fitWidth && "h-full", rightToLeft && "flex-row-reverse")}>
                {b.pages.map((at) => {
                  const p = drawn(at, b.pages.length);
                  return p && <PageCanvas key={p.page} {...p} waiting={b.side !== "middle"} />;
                })}
              </div>
            </div>
          ))}
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

/** A page as it is drawn: which, how large on screen, and its picture when that is decoded. */
interface Drawn {
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
function PageCanvas({ page, box, picture, waiting }: Drawn & { waiting: boolean }) {
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
