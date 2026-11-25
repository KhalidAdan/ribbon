import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import type { PagesToChoose } from "../app/controller";
import type { WebPdf } from "../comic/pdf";
import { useController } from "./store";

/** How many pages are fetched and drawn small at once: enough to fill a row quickly, few enough that a server's comic isn't asked for whole. */
const AT_ONCE = 3;

/** The longer side of a cover made from a page, in pixels: twice the largest size Ribbon shows a cover at. */
const COVER_LONGEST = 1600;

/** The longer side of a page drawn small, in pixels: sharp on a screen of twice the density. */
const SMALL_LONGEST = 360;

/** A comic's pages as pictures, one at a time, each handed over to be drawn and then closed. */
export interface PagePictures {
  count: number;
  picture(at: number): Promise<ImageBitmap>;
  close(): void;
}

/** The pictures of a comic's pages, from wherever they are had (the controller's `pagesToChoose`). pdf.js comes with the first PDF. */
export async function openPagePictures(pages: PagesToChoose): Promise<PagePictures> {
  if (pages.from === "pdf") {
    const pdf: WebPdf = await (await import("../comic/pdf")).openWebPdf(pages.url, pages.bytes);
    return { count: pages.count, picture: (at) => pdf.picture(at, COVER_LONGEST), close: () => void pdf.close() };
  }
  const file = pages.from === "server" ? pages.page : async (at: number) => (await fetched(pages.url(at))).blob();
  return { count: pages.count, picture: async (at) => createImageBitmap(await file(at)), close: () => undefined };
}

async function fetched(url: string): Promise<Response> {
  const answer = await fetch(url);
  if (!answer.ok) throw new Error("the page could not be read");
  return answer;
}

/** A page as a JPEG no longer than a cover needs: what is kept as the book's cover. */
export async function coverFromPage(pictures: PagePictures, at: number): Promise<Uint8Array> {
  const picture = await pictures.picture(at);
  try {
    const scale = Math.min(1, COVER_LONGEST / Math.max(picture.width, picture.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(picture.width * scale)), Math.max(1, Math.round(picture.height * scale)));
    canvas.getContext("2d")!.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
  } finally {
    picture.close();
  }
}

/** Work done a few at a time, in the order asked: the pages on screen first, since they ask first. */
class Few {
  private waiting: (() => Promise<void>)[] = [];
  private running = 0;
  private stopped = false;

  constructor(private readonly atOnce: number) {}

  ask(work: () => Promise<void>): void {
    this.waiting.push(work);
    this.next();
  }

  /** What hasn't started never will. */
  stop(): void {
    this.stopped = true;
    this.waiting = [];
  }

  private next(): void {
    if (this.stopped || this.running >= this.atOnce) return;
    const work = this.waiting.shift();
    if (!work) return;
    this.running++;
    void work()
      .catch(() => undefined)
      .finally(() => {
        this.running--;
        this.next();
      });
  }
}

/**
 * A comic's pages, small, to choose its cover from: the first page is the
 * cover the files give it, and a collection often has better ones inside,
 * each issue's own. A page is fetched and drawn only when it comes on
 * screen, a few at a time, onto a small canvas of its own, and its full
 * picture is let go at once: a hundred and fifty pages kept as pictures
 * would be a gigabyte (docs/COMICS.md, section 5).
 */
export function CoverPages({ bookId, chosen, onChoose, onPictures }: { bookId: string; chosen: number | null; onChoose: (at: number) => void; onPictures: (pictures: PagePictures | null) => void }) {
  const c = useController();
  const [pictures, setPictures] = useState<PagePictures | null | "none">(null);
  const few = useRef<Few | null>(null);

  useEffect(() => {
    let gone = false;
    let opened: PagePictures | null = null;
    const queue = new Few(AT_ONCE);
    few.current = queue;
    void c
      .pagesToChoose(bookId)
      .then((pages) => (pages ? openPagePictures(pages) : null))
      .catch(() => null)
      .then((p) => {
        if (gone) return p?.close();
        opened = p;
        setPictures(p ?? "none");
        onPictures(p);
      });
    return () => {
      gone = true;
      queue.stop();
      opened?.close();
      onPictures(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, c]);

  if (pictures === null) return <p className="px-1 text-base/6 text-ink-2 sm:text-sm/5">Opening its pages…</p>;
  if (pictures === "none") return <p className="px-1 text-base/6 text-pretty text-ink-2 sm:text-sm/5">Its pages can’t be read just now. A server’s comic that isn’t downloaded needs the server in reach.</p>;
  return (
    <ul role="listbox" aria-label="The comic’s pages" className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-3">
      {Array.from({ length: pictures.count }, (_, at) => (
        <li key={at} role="option" aria-selected={chosen === at}>
          <SmallPage at={at} pictures={pictures} few={few.current!} chosen={chosen === at} onChoose={() => onChoose(at)} />
        </li>
      ))}
    </ul>
  );
}

/** One page, small: blank until it comes on screen, then drawn once. */
function SmallPage({ at, pictures, few, chosen, onChoose }: { at: number; pictures: PagePictures; few: Few; chosen: boolean; onChoose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = button.current;
    if (!el) return;
    let asked = false;
    const draw = async () => {
      const picture = await pictures.picture(at);
      try {
        const into = canvas.current;
        if (!into) return;
        const scale = Math.min(1, SMALL_LONGEST / Math.max(picture.width, picture.height));
        into.width = Math.max(1, Math.round(picture.width * scale));
        into.height = Math.max(1, Math.round(picture.height * scale));
        into.getContext("2d")!.drawImage(picture, 0, 0, into.width, into.height);
        setDrawn(true);
      } finally {
        picture.close();
      }
    };
    // Where nothing says what is on screen (a test's page), every page is asked for, in order.
    if (typeof IntersectionObserver === "undefined") {
      few.ask(draw);
      return;
    }
    const seen = new IntersectionObserver(
      (entries) => {
        if (asked || !entries.some((e) => e.isIntersecting)) return;
        asked = true;
        seen.disconnect();
        few.ask(draw);
      },
      // A row ahead of the scroll, so the next pages are there when they arrive.
      { rootMargin: "200px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [at, pictures, few]);

  return (
    <button
      ref={button}
      type="button"
      onClick={onChoose}
      aria-label={`Page ${at + 1}`}
      className={clsx("group flex w-full flex-col items-center gap-1 rounded-md p-1 focus-ring", chosen ? "bg-raised ring-2 ring-place" : "hover:bg-raised")}
    >
      <span className="flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded-[4px] bg-raised outline-1 -outline-offset-1 outline-line">
        <canvas ref={canvas} className={clsx("max-h-full max-w-full transition-opacity duration-150 ease-out", !drawn && "opacity-0")} />
      </span>
      <span className={clsx("text-sm/5 tabular-nums sm:text-[0.8125rem]/5", chosen ? "font-medium text-ink" : "text-ink-3")}>{at + 1}</span>
    </button>
  );
}
