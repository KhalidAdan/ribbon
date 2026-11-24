import { open, mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { PixelSize } from "@ribbon/core/comic/size";

/**
 * A PDF on Node, read with pdf.js (docs/COMICS.md, section 12): how many
 * pages it has, how large each is, and its first page drawn small for a
 * cover. The file is read in ranges, where it sits: asking how many pages
 * a 200 MB scan has reads its last few kilobytes, not the scan.
 *
 * pdf.js is loaded when first asked for, not with this module: it is
 * large, and most of what runs on Node never opens a PDF.
 */
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let loading: Promise<Pdfjs> | null = null;
const pdfjs = (): Promise<Pdfjs> => (loading ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
/** The canvas pdf.js draws on in Node, loaded as late. */
let drawing: Promise<typeof import("@napi-rs/canvas")> | null = null;
const canvases = () => (drawing ??= import("@napi-rs/canvas"));

/**
 * Load pdf.js now, not at the first PDF. For a program whose way of
 * loading modules ends before its work does: Vite's dev server loads its
 * plugins with a loader it then closes, and a module asked for after that
 * never comes (packages/desktop/tools/vite-dev-library.ts).
 */
export async function loadPdfReader(): Promise<void> {
  await Promise.all([pdfjs(), canvases().catch(() => undefined)]);
}

/** How much of the file is asked for at once. */
const RANGE_BYTES = 256 * 1024;

/** A PDF open to ask about. Close it when done: it holds the file open. */
export interface OpenPdf {
  pages: number;
  /** A page's size in points, counted from 0. */
  size(page: number): Promise<PixelSize>;
  /** A page drawn `width` pixels wide, as a JPEG. Needs a canvas on Node (`@napi-rs/canvas`, which pdf.js brings where it can). */
  jpeg(page: number, width: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Open a PDF where it sits. Rejects for a file that isn't one, or one locked with a password. */
export async function openPdf(file: string): Promise<OpenPdf> {
  const { getDocument, PDFDataRangeTransport } = await pdfjs();
  const handle = await open(file, "r");
  try {
    const { size: length } = await handle.stat();
    const read = async (begin: number, end: number) => {
      const buf = new Uint8Array(end - begin);
      const { bytesRead } = await handle.read(buf, 0, buf.length, begin);
      return buf.subarray(0, bytesRead);
    };
    // pdf.js asks for the ranges it needs; each is read from the file and handed back.
    const transport = new PDFDataRangeTransport(length, await read(0, Math.min(length, RANGE_BYTES)));
    transport.requestDataRange = (begin: number, end: number) => void read(begin, end).then((chunk) => transport.onDataRange(begin, chunk));
    const task = getDocument({ range: transport, rangeChunkSize: RANGE_BYTES, disableAutoFetch: true, disableStream: true, verbosity: 0 });
    const doc = await task.promise;
    return {
      pages: doc.numPages,
      async size(page) {
        const view = (await doc.getPage(page + 1)).getViewport({ scale: 1 });
        return { width: Math.round(view.width), height: Math.round(view.height) };
      },
      async jpeg(page, width) {
        const { createCanvas } = await canvases();
        const p = await doc.getPage(page + 1);
        const natural = p.getViewport({ scale: 1 });
        const viewport = p.getViewport({ scale: width / natural.width });
        const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
        // pdf.js draws on any canvas with a 2D context; Node's is not the page's, and the types name only the page's.
        await p.render({ canvas: canvas as never, viewport }).promise;
        return canvas.toBuffer("image/jpeg", 85);
      },
      async close() {
        await task.destroy();
        await handle.close();
      },
    };
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
}

/** How many pages a PDF has. */
export async function pdfPages(file: string): Promise<number> {
  const pdf = await openPdf(file);
  try {
    return pdf.pages;
  } finally {
    await pdf.close();
  }
}

/** A PDF's cover: its first page, drawn `width` pixels wide, at `target`. False when it can't be drawn here. */
export async function pdfCover(file: string, target: string, width: number): Promise<boolean> {
  const made = `${target}.tmp.jpg`;
  try {
    const pdf = await openPdf(file);
    try {
      // Never drawn wider than a page of this size is worth: a cover is small.
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(made, await pdf.jpeg(0, width));
    } finally {
      await pdf.close();
    }
    await rename(made, target);
    return true;
  } catch {
    await rm(made, { force: true });
    return false;
  }
}
