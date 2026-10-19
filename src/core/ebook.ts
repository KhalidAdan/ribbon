import type { Host } from "../host/host";
import type { Book } from "./types";

/**
 * The book model Rust makes of an EPUB, `ribbon-ebook/1`
 * (docs/READING.md, section 4). Text offsets are UTF-16 code units.
 */
export const EBOOK_FORMAT = "ribbon-ebook/1";

export interface EbookRun {
  t: string;
  i?: boolean;
  b?: boolean;
  sc?: boolean;
  sup?: boolean;
  sub?: boolean;
  /** A path in the book plus `#fragment`, or a web address. */
  href?: string;
}

export interface EbookAnchor {
  id: string;
  at: number;
}

export interface EbookBlock {
  k: "p" | "h" | "img" | "hr" | "pre";
  level?: number;
  runs?: EbookRun[];
  ids?: EbookAnchor[];
  indent?: boolean;
  align?: "center" | "end";
  space?: boolean;
  quote?: boolean;
  list?: boolean;
  table?: boolean;
  src?: string;
  w?: number;
  h?: number;
  alt?: string;
  /**
   * What the image is, for dark mode: "ink" is line art, ornaments,
   * diagrams or text on a light or clear ground; "picture" is anything
   * else. Absent when the host did not look, which reads as a picture.
   */
  tone?: "ink" | "picture";
}

export interface EbookSection {
  href: string;
  linear: boolean;
  overlay: string | null;
  /** What the publisher says the section is (`epub:type` or a `doc-` role), when it says. */
  kind?: string;
  chars: number;
  blocks: EbookBlock[];
}

export interface EbookTocEntry {
  label: string;
  section: number;
  block: number;
  depth: number;
}

export interface Ebook {
  format: typeof EBOOK_FORMAT;
  meta: {
    title: string;
    authors: string[];
    language?: string;
    publisher?: string;
    date?: string;
    description?: string;
    identifiers: { scheme: "isbn" | "uuid" | "other"; value: string }[];
  };
  layout: "reflowable" | "pre-paginated";
  sections: EbookSection[];
  toc: EbookTocEntry[];
  /** Where each image is on this machine, by its path in the book, when the host kept them. */
  files?: Record<string, string>;
}

export type EbookResult = { ok: true; ebook: Ebook } | { ok: false; reason: "drm" | "fixed-layout" | "unreadable" | "unsupported"; message: string };

/** Open a book's EPUB, saying plainly why when it cannot be read. */
export async function openEbook(host: Host, root: string, book: Pick<Book, "ebook">): Promise<EbookResult> {
  if (!book.ebook) return { ok: false, reason: "unreadable", message: "This book has no EPUB beside it." };
  if (!host.openEbook) return { ok: false, reason: "unsupported", message: "Reading needs the Ribbon app." };
  let text: string;
  try {
    text = await host.openEbook(host.join(root, ...book.ebook.split("/")));
  } catch (e) {
    const why = String(e instanceof Error ? e.message : e);
    if (why.startsWith("drm:")) return { ok: false, reason: "drm", message: "This EPUB is locked with DRM, so Ribbon cannot open it." };
    return { ok: false, reason: "unreadable", message: `This EPUB could not be read: ${why.replace(/^unreadable:\s*/, "")}` };
  }
  let ebook: Ebook;
  try {
    ebook = JSON.parse(text) as Ebook;
  } catch {
    return { ok: false, reason: "unreadable", message: "This EPUB could not be read." };
  }
  if (ebook.format !== EBOOK_FORMAT) return { ok: false, reason: "unreadable", message: "This EPUB came back in a form this version of Ribbon does not know." };
  if (ebook.layout === "pre-paginated") return { ok: false, reason: "fixed-layout", message: "This EPUB has fixed pages, like a comic or a picture book, which Ribbon cannot show yet." };
  return { ok: true, ebook };
}

/** A block's text, its runs joined. */
export function blockText(b: EbookBlock): string {
  return (b.runs ?? []).map((r) => r.t).join("");
}
