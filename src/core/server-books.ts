import { bookId } from "./bookid";
import type { ScannedBook } from "./scan/scan";
import type { LoudnessMeasurement, SilenceRange } from "./types";

/**
 * A book on a Ribbon server, as its library answer lists it
 * (server/src/library/books.ts, `ListedBook`).
 */
export interface ServerBook {
  id: string;
  title: string;
  author: string;
  narrator: string;
  series: string;
  seriesIndex: number | null;
  durationMs: number;
  /** The audio's bytes, all files together. */
  sizeBytes: number;
  audio: boolean;
  ebook: boolean;
  /** The EPUB's bytes, when there is one. */
  ebookBytes: number | null;
  cover: { hash: string; aspect: number; colour: string } | null;
  addedAt: string;
}

/** A book in full, as the server sends it for a download (server/src/library/books.ts, `StoredBook`). */
export interface ServerBookDetail {
  book: { id: string; title: string; author: string; narrator: string; series: string; seriesIndex: number | null; description?: string; isbn?: string; asin?: string; language?: string; publisher?: string; ebook?: string };
  files: { path: string; sizeBytes: number }[];
  cover: { hash: string; aspect: number; colour: string } | null;
  ebookBytes?: number;
  /** Its loudness and silences, measured once on the server: a device that downloads it never measures it itself. */
  analysis?: { loudness: LoudnessMeasurement | null; silence: { file: number; ranges: SilenceRange[] }[] };
}

/** The width of cover kept on this device for the shelf: 2x of the 200 points it's drawn at. */
export const SHELF_COVER_WIDTH = 400;

/** Where a server's covers are kept in its folder on this device, by picture hash. */
export function serverCoverPath(hash: string): string {
  return `.ribbon/server-covers/${hash}-${SHELF_COVER_WIDTH}.jpg`;
}

/**
 * The id a server's book has on this device. A downloaded book lives in a
 * folder named by its server id, so the scanner gives it
 * `bookId(serverId, audio bytes)` on every device alike, and its place,
 * synced from another device, finds it here before it's downloaded. A book
 * to read only is named by its EPUB, `<serverId>/book.epub`, and that
 * file's bytes (scan.ts, `buildReaderOnly`).
 */
export function localIdOf(b: Pick<ServerBook, "id" | "audio" | "sizeBytes" | "ebookBytes">): string {
  return b.audio ? bookId(b.id, b.sizeBytes) : bookId(`${b.id}/book.epub`, b.ebookBytes ?? 0);
}

/** A server's book that isn't on this device yet, as the shelf shows it. */
export function remoteBook(b: ServerBook): ScannedBook {
  return {
    book: {
      id: localIdOf(b),
      path: b.id,
      title: b.title,
      rawTitle: b.title,
      author: b.author,
      narrator: b.narrator,
      series: b.series,
      seriesIndex: b.seriesIndex,
      year: null,
      cover: b.cover ? serverCoverPath(b.cover.hash) : "",
      ...(b.ebook ? { ebook: `${b.id}/book.epub` } : {}),
      durationMs: b.durationMs,
      sizeBytes: b.sizeBytes,
      fileCount: b.audio ? 1 : 0,
    },
    files: [],
    chapters: [],
    parts: [],
    remote: { serverId: b.id, audio: b.audio, ebook: b.ebook, cover: b.cover },
  };
}

/**
 * The `metadata.opf` written beside a downloaded book, so the scanner,
 * which reads that file (scan/sidefiles.ts), names it as the server does
 * rather than by its folder, which is a server id.
 */
export function opfFor(b: ServerBookDetail["book"]): string {
  const lines: string[] = [];
  const el = (name: string, text: string | undefined, attrs = "") => {
    if (text) lines.push(`    <${name}${attrs}>${escapeXml(text)}</${name}>`);
  };
  el("dc:title", b.title);
  split(b.author).forEach((a, i) => {
    el("dc:creator", a, ` id="author${i}"`);
    lines.push(`    <meta refines="#author${i}" property="role">aut</meta>`);
  });
  split(b.narrator).forEach((n, i) => {
    el("dc:contributor", n, ` id="narrator${i}"`);
    lines.push(`    <meta refines="#narrator${i}" property="role">nrt</meta>`);
  });
  if (b.series) {
    lines.push(`    <meta name="calibre:series" content="${escapeXml(b.series)}"/>`);
    if (b.seriesIndex !== null) lines.push(`    <meta name="calibre:series_index" content="${b.seriesIndex}"/>`);
  }
  el("dc:identifier", b.isbn ? `urn:isbn:${b.isbn}` : undefined);
  el("dc:identifier", b.asin ? `urn:asin:${b.asin}` : undefined);
  el("dc:description", b.description);
  el("dc:publisher", b.publisher);
  el("dc:language", b.language);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<package version="3.0" xmlns="http://www.idpf.org/2007/opf">`,
    `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    ...lines,
    `  </metadata>`,
    `</package>`,
    "",
  ].join("\n");
}

/** "A, B & C" as the shelf shows several names, back into each name. */
function split(names: string): string[] {
  return names
    .split(/\s*(?:,|&|\band\b)\s*/)
    .map((n) => n.trim())
    .filter(Boolean);
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}
