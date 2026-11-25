import { useEffect, useReducer, useRef, type RefObject } from "react";
import type { ReadyComic } from "@ribbon/core/comic/session";
import { imageSize, type PixelSize } from "@ribbon/core/comic/size";
import { PageWindow, type WindowSize } from "@ribbon/core/comic/window";
import type { AppController } from "../app/controller";
import type { SharedPdf } from "./document";

/**
 * A page known and not yet drawn: the size its picture will be, and, for a
 * comic's page, its file's bytes. A PDF's page has no file of its own; it
 * is drawn out of the PDF (pdf.ts).
 */
export interface Fetched extends PixelSize {
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

/** The windows of pages kept ready, and every page's size learned so far. */
export interface PageWindows {
  fetched: RefObject<PageWindow<Fetched> | null>;
  decoded: RefObject<PageWindow<ImageBitmap> | null>;
  /** The size of every page whose file has been fetched while the comic is open, kept after the file is let go. */
  sizes: RefObject<Map<number, PixelSize>>;
}

/**
 * Two windows around the page being read (core/comic/window.ts), for
 * either way of reading a comic: turning its pages, or one long scroll.
 * The wide one keeps pages fetched: their files, a megabyte or two each,
 * which is the wait over a network share. The narrow one, `decodedSize`
 * wide, keeps the nearest decoded, which is the wait at the turn itself,
 * and what memory makes dear: 24 MB for a scanned page. Ribbon holds the
 * decoded pictures itself and frees each the moment it leaves the window;
 * left to the web view as <img>s, they stayed in its cache, 1.3 GB of them
 * after a few dozen turns, closed comic and all (measured in the Mac
 * build). Made in an effect: they start fetching at once, and are let go
 * when the comic closes.
 */
export function usePageWindows(comic: ReadyComic, c: AppController, pdf: SharedPdf | null, decodedSize: WindowSize): PageWindows {
  const count = comic.pages.length;
  const fetched = useRef<PageWindow<Fetched> | null>(null);
  const decoded = useRef<PageWindow<ImageBitmap> | null>(null);
  const sizes = useRef(new Map<number, PixelSize>());
  const page = useRef(comic.page);
  const size = useRef(decodedSize);
  size.current = decodedSize;
  // Drawn again when a page's file or picture lands.
  const [, landed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // A PDF's pages are drawn out of it, opened once for the comic (document.ts).
    const document = pdf?.take() ?? null;
    // A PDF's page is drawn as large as this screen could show it, and no larger.
    const longest = Math.min(4096, Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1) * 1.6);
    const files = new PageWindow<Fetched>(count, {
      load: async (at, signal) => {
        const address = document ? null : c.comicPageUrl(at);
        if (!document && !address) throw new Error("no address for the page");
        const file = document ? await (await document).size(at) : await fetchPage(address!, signal);
        sizes.current.set(at, { width: file.width, height: file.height });
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
          if (document) return (await document).picture(at, longest);
          return createImageBitmap(file.file!);
        },
        release: (_, picture) => picture.close(),
        landed,
      },
      size.current,
    );
    fetched.current = files;
    decoded.current = pictures;
    files.moveTo(page.current);
    pictures.moveTo(page.current);
    return () => {
      fetched.current = null;
      decoded.current = null;
      // The PDF is let go once the pages still being drawn out of it are done.
      pdf?.letGo(Promise.all([pictures.close(), files.close()]));
    };
  }, [comic.bookId, count, c, pdf]);
  useEffect(() => {
    const forward = comic.page >= page.current;
    fetched.current?.moveTo(comic.page, forward);
    decoded.current?.resize(decodedSize);
    decoded.current?.moveTo(comic.page, forward);
    page.current = comic.page;
  }, [comic.page, decodedSize.behind, decodedSize.ahead]); // eslint-disable-line react-hooks/exhaustive-deps
  return { fetched, decoded, sizes };
}
