import { clsx } from "clsx";
import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { ReadyComic } from "@ribbon/core/comic/session";
import { pagesInView, scrollToCentre, slotLeft, slotsDrawn, SMALL_PAGE_HEIGHT, stripWidth, stripWindow, type StripSlots } from "@ribbon/core/comic/strip";
import { PageWindow } from "@ribbon/core/comic/window";
import type { AppController } from "../app/controller";
import type { SharedPdf } from "./document";

/** The row's slots: a page about two wide to three tall in each, 8 between, and 16 of room at either end. */
const SLOTS: StripSlots = { width: 64, gap: 8, inset: 16 };
/** How tall a small page is shown: about 100 points, as its picture was made for (core/comic/strip.ts). */
const PICTURE_HEIGHT = 96;
/** Slots drawn past either side of what shows, with their pictures held, so a little scrolling finds them there. */
const MARGIN = 6;

/**
 * A small page's picture, fetched from Ribbon (made once from the page and
 * kept, comic_small.rs) or, for a PDF's page not drawn small before, drawn
 * now out of the PDF and handed to Ribbon to keep. Decoded here, a few
 * hundred kilobytes each, and freed when it leaves the window.
 */
async function smallPicture(c: AppController, page: number, pdf: Promise<import("./pdf").WebPdf> | null, signal: AbortSignal): Promise<ImageBitmap> {
  const address = c.comicPageUrl(page, true);
  let jpeg: Blob | null = null;
  if (address) {
    const answer = await fetch(address, { signal });
    if (answer.status === 200) jpeg = await answer.blob();
    // 204: a PDF's page that hasn't been drawn small yet.
    else if (answer.status !== 204) throw new Error(`the small page could not be had (${answer.status})`);
  }
  if (!jpeg && pdf) {
    const drawn = await (await pdf).small(page, SMALL_PAGE_HEIGHT);
    void c.keepSmallPage(page, drawn).catch(() => undefined);
    jpeg = new Blob([drawn as BlobPart], { type: "image/jpeg" });
  }
  if (!jpeg) throw new Error("no small picture for the page");
  return createImageBitmap(jpeg);
}

/**
 * The strip of small pages along the foot of the reader (docs/COMICS.md,
 * section 15): every page of the comic in a row, the one being read
 * outlined and kept in the middle, a click going to a page. It runs right
 * to left for a comic that reads that way. Only the slots near what it
 * shows are drawn and only their pictures fetched (core/comic/strip.ts), so
 * a 600-page book costs what an issue does.
 */
export function ComicStrip({ comic, shown, rightToLeft, c, pdf }: { comic: ReadyComic; shown: readonly number[]; rightToLeft: boolean; c: AppController; pdf: SharedPdf | null }) {
  const count = comic.pages.length;
  const scroller = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  const [width, setWidth] = useState(0);
  const inView = pagesInView(left, width, count, rightToLeft, SLOTS);
  /** Whether the strip has been put at the page being read yet: until then, what it shows is nothing to fetch for. */
  const placed = useRef(false);

  // The small pictures held, as a window around what the strip shows (core/comic/window.ts). Made in an effect,
  // so React's second mounting in development makes a second, rather than closing the only one.
  const pictures = useRef<PageWindow<ImageBitmap> | null>(null);
  const [, landed] = useReducer((n: number) => n + 1, 0);
  /** Hold the pictures for what the strip shows when scrolled `scrollLeft` along: as it scrolls, not a frame after. */
  const follow = (scrollLeft: number, viewWidth: number) => {
    if (viewWidth === 0 || !placed.current) return;
    const { centre, size } = stripWindow(pagesInView(scrollLeft, viewWidth, count, rightToLeft, SLOTS), MARGIN);
    pictures.current?.resize(size);
    pictures.current?.moveTo(centre);
  };
  const following = useRef(follow);
  following.current = follow;
  useEffect(() => {
    const document = pdf?.take() ?? null;
    const held = new PageWindow<ImageBitmap>(
      count,
      {
        load: (at, signal) => smallPicture(c, at, document, signal),
        release: (_, picture) => picture.close(),
        landed,
      },
      { behind: MARGIN, ahead: MARGIN },
      // A PDF's are drawn by pdf.js, which draws the pages being read too: fewer at once, so those aren't kept waiting.
      document ? 2 : 4,
    );
    pictures.current = held;
    const el = scroller.current;
    if (el) following.current(el.scrollLeft, el.clientWidth);
    return () => {
      pictures.current = null;
      const closed = held.close();
      pdf?.letGo(closed);
    };
  }, [c, count, pdf]);
  // How wide the strip is, as the window changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);

  // The pages being read in the middle. When the strip first shows, or the window's width changes, before the
  // frame that shows it, so it never shows elsewhere first.
  const reading = shown.join(",");
  const centre = () => {
    const el = scroller.current;
    if (!el || width === 0) return;
    const to = scrollToCentre(shown, count, width, rightToLeft, SLOTS);
    // Straight there, not gliding: a glide's scrolling went on into the next turn, and at six times slower a turn
    // waited behind it (measured on GitHub's Windows runner).
    el.scrollTo({ left: to, behavior: "instant" });
    placed.current = true;
    // Where it is going, fetched for at once: a glide there needn't fetch for every page it passes.
    follow(to, width);
    return to;
  };
  useLayoutEffect(() => {
    const to = centre();
    if (to !== undefined) setLeft(to);
  }, [count, rightToLeft, width]); // eslint-disable-line react-hooks/exhaustive-deps
  // As the reader turns: after the turn has been drawn, since the turn shouldn't wait on the strip. The scroll says
  // where it got to.
  const turned = useRef(reading);
  useEffect(() => {
    if (turned.current === reading) return;
    turned.current = reading;
    centre();
  }, [reading]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = useCallback((at: number) => c.turnComic(at, "seek"), [c]);

  const drawn = slotsDrawn(inView, count, MARGIN);
  const slots: number[] = [];
  for (let at = drawn.first; at <= drawn.last; at++) slots.push(at);

  return (
    <nav aria-label="Pages" data-comic-strip className="shrink-0 border-t border-line">
      <div
        ref={scroller}
        onScroll={(e) => {
          setLeft(e.currentTarget.scrollLeft);
          follow(e.currentTarget.scrollLeft, e.currentTarget.clientWidth);
        }}
        // A mouse's wheel turns up and down: along the row is what it means here.
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
        className="overflow-x-auto overflow-y-hidden py-2 [scrollbar-width:thin]"
      >
        <div className="relative" style={{ width: stripWidth(count, SLOTS), height: PICTURE_HEIGHT + 18 }}>
          {slots.map((at) => (
            <SmallPage key={at} page={at} left={slotLeft(at, count, rightToLeft, SLOTS)} picture={pictures.current?.peek(at)} current={shown.includes(at)} onGo={go} />
          ))}
        </div>
      </div>
    </nav>
  );
}

/**
 * One page of the strip: its small picture drawn onto a canvas the size it
 * shows at, whole, as it was drawn; a page drawn across two is as tall and
 * wider, within its slot. Its place is held, empty, until its picture comes.
 * Drawn again only when something of its own changes, so a turn redraws the
 * two pages whose outline moved, not the strip.
 */
const SmallPage = memo(function SmallPage({ page, left, picture, current, onGo }: { page: number; left: number; picture: ImageBitmap | undefined; current: boolean; onGo: (page: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scale = picture ? Math.min(SLOTS.width / picture.width, PICTURE_HEIGHT / picture.height) : 0;
  const box = picture ? { width: Math.max(1, Math.round(picture.width * scale)), height: Math.max(1, Math.round(picture.height * scale)) } : { width: Math.round(PICTURE_HEIGHT * 0.66), height: PICTURE_HEIGHT };
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !picture) return;
    const density = Math.min(window.devicePixelRatio || 1, picture.width / box.width);
    el.width = Math.max(1, Math.round(box.width * density));
    el.height = Math.max(1, Math.round(box.height * density));
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(picture, 0, 0, el.width, el.height);
    el.dataset.drawn = "true";
  }, [picture, box.width, box.height]);
  return (
    <button
      type="button"
      // The keys and the slider move through the pages already; the strip is a pointer's, and takes no focus from the page.
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onGo(page)}
      aria-label={`Page ${page + 1}`}
      aria-current={current ? "page" : undefined}
      data-strip-page={page + 1}
      className="group absolute top-0 flex flex-col items-center gap-1"
      style={{ left, width: SLOTS.width }}
    >
      <span className="flex items-end justify-center" style={{ height: PICTURE_HEIGHT, width: SLOTS.width }}>
        {picture ? (
          <canvas ref={canvas} style={{ width: box.width, height: box.height }} className={clsx("block rounded-[2px]", current ? "outline-2 outline-offset-2 outline-ink" : "outline-1 outline-line group-hover:outline-line-strong")} />
        ) : (
          <span style={{ width: box.width, height: box.height }} className={clsx("block rounded-[2px] bg-line", current && "outline-2 outline-offset-2 outline-ink")} />
        )}
      </span>
      <span className={clsx("text-[0.6875rem]/3 tabular-nums", current ? "font-medium text-ink" : "text-ink-3 group-hover:text-ink-2")}>{page + 1}</span>
    </button>
  );
});
