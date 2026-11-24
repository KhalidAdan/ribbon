/// <reference path="./pdf-worker.d.ts" />
// pdf.js's build for web views that aren't this month's: its usual one is written with parts of
// the language (Map's getOrInsertComputed) that WebView2 on a Windows not just updated, and an
// iPhone a few years old, don't have, and there it opens nothing.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PixelSize } from "@ribbon/core/comic/size";

/**
 * A PDF in the web view, read with pdf.js (docs/COMICS.md, section 12).
 * The file is asked for in ranges, never whole: counting a 200 MB scan's
 * pages reads its last few kilobytes, and a page is fetched when it is
 * read. A page is drawn into a picture of the size asked for, which the
 * comic reader keeps and frees as it does a comic's.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Where pdf.js finds its decoders, character maps, fonts and colour profiles: beside the app (tools/vite-pdfjs.ts). */
const FILES = new URL("pdfjs/", document.baseURI).href;

/** How much of the file is asked for at once. Tauri's file address gives a megabyte at most to one request. */
const RANGE_BYTES = 512 * 1024;

/** The most pixels a page is drawn with: enough for a scan at twice a large screen, short of what a web view will give a canvas. */
const MOST_PIXELS = 16_000_000;

export interface WebPdf {
  pages: number;
  /** A page's size in points, counted from 0: its shape, before it is drawn. */
  size(page: number): Promise<PixelSize>;
  /** A page drawn so its longer side is `longest` pixels, as a picture to keep and to free. */
  picture(page: number, longest: number): Promise<ImageBitmap>;
  /** A page drawn `width` pixels wide, as a JPEG: a cover. */
  jpeg(page: number, width: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The file itself couldn't be fetched: not that it isn't a PDF, but that nothing came back for it. */
export class NotReached extends Error {
  constructor(readonly status: number) {
    super(`the file could not be read (${status})`);
  }
}

/** Bytes of the file from `begin` up to `end`, however many requests that takes. */
async function range(url: string, begin: number, end: number): Promise<Uint8Array> {
  const out = new Uint8Array(end - begin);
  let have = 0;
  while (have < out.length) {
    const answer = await fetch(url, { headers: { range: `bytes=${begin + have}-${end - 1}` } });
    if (!answer.ok) throw new NotReached(answer.status);
    const chunk = new Uint8Array(await answer.arrayBuffer());
    // A server that ignores the range sends the file from its start: take the part asked for.
    const part = answer.status === 206 ? chunk : chunk.subarray(begin + have, end);
    if (part.length === 0) throw new Error("the file ended early");
    out.set(part.subarray(0, out.length - have), have);
    have += Math.min(part.length, out.length - have);
  }
  return out;
}

/** Open the PDF at `url`, which is `length` bytes. Rejects for a file that isn't a PDF, or is locked with a password. */
export async function openWebPdf(url: string, length: number): Promise<WebPdf> {
  const transport = new pdfjs.PDFDataRangeTransport(length, await range(url, 0, Math.min(length, RANGE_BYTES)));
  transport.requestDataRange = (begin: number, end: number) => {
    void range(url, begin, end).then(
      (chunk) => transport.onDataRange(begin, chunk),
      () => transport.abort(),
    );
  };
  const task = pdfjs.getDocument({
    range: transport,
    rangeChunkSize: RANGE_BYTES,
    disableAutoFetch: true,
    disableStream: true,
    wasmUrl: `${FILES}wasm/`,
    cMapUrl: `${FILES}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${FILES}standard_fonts/`,
    iccUrl: `${FILES}iccs/`,
    verbosity: 0,
  });
  const doc = await task.promise;

  const drawn = async (page: number, scaleFor: (natural: PixelSize) => number): Promise<OffscreenCanvas> => {
    const p = await doc.getPage(page + 1);
    const natural = p.getViewport({ scale: 1 });
    let scale = scaleFor(natural);
    const pixels = natural.width * natural.height * scale * scale;
    if (pixels > MOST_PIXELS) scale *= Math.sqrt(MOST_PIXELS / pixels);
    const viewport = p.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
    // pdf.js draws on any canvas with a 2D context; its types name only the page's own kind.
    await p.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    // The page's own working data is let go once it is drawn; the picture is what is kept.
    p.cleanup();
    return canvas;
  };

  return {
    pages: doc.numPages,
    async size(page) {
      const view = (await doc.getPage(page + 1)).getViewport({ scale: 1 });
      return { width: Math.round(view.width), height: Math.round(view.height) };
    },
    async picture(page, longest) {
      return (await drawn(page, (natural) => longest / Math.max(natural.width, natural.height))).transferToImageBitmap();
    },
    async jpeg(page, width) {
      // A cover is small, and never drawn larger than asked.
      const canvas = await drawn(page, (natural) => width / natural.width);
      return new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer());
    },
    close: () => task.destroy(),
  };
}

/** How many pages the PDF at `url` has. */
export async function webPdfPages(url: string, length: number): Promise<number> {
  const pdf = await openWebPdf(url, length);
  try {
    return pdf.pages;
  } finally {
    await pdf.close();
  }
}

/** The PDF's first page as a JPEG `width` pixels wide. */
export async function webPdfCover(url: string, length: number, width: number): Promise<Uint8Array> {
  const pdf = await openWebPdf(url, length);
  try {
    return await pdf.jpeg(0, width);
  } finally {
    await pdf.close();
  }
}
