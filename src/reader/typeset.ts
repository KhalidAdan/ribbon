import { layoutNextRichInlineLineRange, materializeRichInlineLineRange, prepareRichInline, type PreparedRichInline, type RichInlineCursor } from "@chenglou/pretext/rich-inline";
import { clearCache, setLocale } from "@chenglou/pretext";
import type { Ebook, EbookBlock, EbookRun } from "../core/ebook";
import type { LaidBlock, Line, LineFrag } from "../core/reading/pages";
import type { Metrics } from "../core/reading/typography";
import { hyphenateRuns, insertHyphens, toModel, type WordBreaks } from "../core/reading/hyphens";
import { hyphenatorFor } from "./hyphenate";
import { addFaces } from "./faces";

/**
 * The text set in lines with pretext (docs/READING.md, section 1): every
 * line's break comes from the browser's own font measurements, without the
 * browser laying anything out. Width-independent preparation is kept per
 * block and size, so a new window width only re-breaks lines.
 */

/** Newsreader without its optical-size axis, so the canvas pretext measures with and the page draw it the same. */
export const FAMILY = '"Ribbon Text"';

const HEADING_SCALE = [1, 1.55, 1.35, 1.2, 1.1, 1.05, 1];
const SMALL = 0.7;

export function fontFor(r: Pick<EbookRun, "i" | "b" | "sc" | "sup" | "sub">, size: number, weight = 400): string {
  const px = r.sup || r.sub ? size * SMALL : size;
  return `${r.i ? "italic " : ""}${r.sc ? "small-caps " : ""}${r.b ? 650 : weight} ${px}px ${FAMILY}`;
}

// The hyphenation patterns the latest typesetter is loading, which the first layout waits for.
let patterns: Promise<unknown> = Promise.resolve();

/**
 * Wait until the faces the reader uses are loaded, so the first
 * measurements are of the real font, and the open book's hyphenation
 * patterns, so its first lines break as all the later ones do.
 */
let added: Promise<void> | null = null;

/** Add the reader's faces to the page, once: called at start, so the first book opened does not wait for them. */
export function preloadFaces(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  return (added ??= addFaces(document.fonts));
}

export async function loadFaces(size: number): Promise<void> {
  const waiting = patterns;
  if (typeof document === "undefined" || !document.fonts) return void (await waiting);
  await preloadFaces();
  await Promise.all([waiting, ...[fontFor({}, size), fontFor({ i: true }, size), fontFor({ b: true }, size), fontFor({}, size, 500)].map((f) => document.fonts.load(f).catch(() => []))]);
  // Anything measured before the faces arrived was measured in a fallback.
  clearCache();
}

export class Typesetter {
  /** Each paragraph prepared, with the soft hyphens added to each of its runs (core/reading/hyphens.ts). */
  private prepared = new Map<string, { prepared: PreparedRichInline; added: number[][] }>();
  /** Where words break in the book's language, once loaded; null without patterns for it. */
  private hyphens: WordBreaks | null = null;
  /** Settles when the book's hyphenation patterns are loaded, or known to be missing. */
  readonly ready: Promise<void>;

  constructor(
    private readonly ebook: Ebook,
    /** Whether an image path in the book can be shown (kept on this machine). The page turns the path into a URL. */
    private readonly hasImage: (src: string) => boolean,
  ) {
    setLocale(ebook.meta.language || undefined);
    this.ready = hyphenatorFor(ebook.meta.language).then((h) => {
      this.hyphens = h;
    });
    patterns = this.ready;
  }

  /** Whether justified paragraphs are hyphenated: the book's language has patterns, and they are loaded. */
  get hyphenates(): boolean {
    return this.hyphens !== null;
  }

  /** Lay out one section in a column of `m.column` px. */
  section(index: number, m: Metrics, justify: boolean): LaidBlock[] {
    const blocks = this.ebook.sections[index]?.blocks ?? [];
    const out: LaidBlock[] = [];
    let afterHeading = false;
    blocks.forEach((b, i) => {
      const laid = this.block(index, i, b, m, justify);
      if (!laid) return;
      // Room after a heading, carried by whatever follows it.
      if (afterHeading) laid.before = Math.max(laid.before, m.lineHeight);
      afterHeading = laid.kind === "h";
      out.push(laid);
    });
    return out;
  }

  private block(section: number, index: number, b: EbookBlock, m: Metrics, justify: boolean): LaidBlock | null {
    const base = { section, block: index, indent: 0, inset: 0, size: m.size, lines: [] as Line[] };
    if (b.k === "hr") return { ...base, kind: "hr", lineHeight: Math.round(m.lineHeight * 1.5), before: Math.round(m.lineHeight * 0.25), align: "center" };
    if (b.k === "img") {
      if (!b.src || !this.hasImage(b.src)) return null;
      const naturalW = b.w && b.w > 0 ? b.w : m.column;
      const naturalH = b.h && b.h > 0 ? b.h : Math.round(m.column * 0.66);
      let width = Math.min(naturalW, m.column);
      let height = (naturalH * width) / naturalW;
      const most = m.pageHeight * 0.85;
      if (height > most) {
        width = (width * most) / height;
        height = most;
      }
      return { ...base, kind: "img", lineHeight: Math.round(height), before: Math.round(m.lineHeight * (b.space ? 1 : 0.5)), align: "center", image: { src: b.src, width: Math.round(width), height: Math.round(height), alt: b.alt ?? "", tone: b.tone ?? "picture" } };
    }
    const runs = (b.runs ?? []).filter((r) => r.t.length > 0);
    if (runs.length === 0) return null;
    const heading = b.k === "h";
    const size = heading ? Math.round(m.size * HEADING_SCALE[Math.min(6, b.level ?? 2)]!) : m.size;
    const lineHeight = heading ? Math.round(size * 1.3) : m.lineHeight;
    const weight = heading ? 500 : 400;
    const inset = b.quote ? Math.round(m.size * 1.5) : b.list ? Math.round(m.size) : 0;
    const indent = b.indent && !heading ? Math.round(m.size * 1.5) : 0;
    const pre = b.k === "pre" || b.table === true || runs.some((r) => r.t.includes("\n"));
    // Justified paragraphs are hyphenated: pretext breaks at the soft hyphens added, and each
    // run's list of them maps its offsets back to the model's (core/reading/hyphens.ts).
    const hyphenate = justify && this.hyphens !== null && b.k === "p" && !pre && !b.align;
    const key = `${section}:${index}:${size}:${hyphenate ? "h" : ""}`;
    let kept = this.prepared.get(key);
    if (!kept) {
      const added = hyphenate ? hyphenateRuns(runs.map((r) => r.t), this.hyphens!) : runs.map(() => []);
      const prepared = prepareRichInline(
        runs.map((r, k) => ({ text: insertHyphens(r.t, added[k]!), font: fontFor(r, size, weight) })),
        pre ? { whiteSpace: "pre-wrap" } : undefined,
      );
      kept = { prepared, added };
      this.prepared.set(key, kept);
    }
    const { prepared, added } = kept;
    const starts: number[] = [];
    let at = 0;
    for (const r of runs) {
      starts.push(at);
      at += r.t.length;
    }
    const width = Math.max(40, m.column - 2 * inset);
    const lines: Line[] = [];
    let cursor: RichInlineCursor | undefined;
    for (;;) {
      const range = layoutNextRichInlineLineRange(prepared, lines.length === 0 ? width - indent : width, cursor);
      if (!range) break;
      const line = materializeRichInlineLineRange(prepared, range);
      const frags: LineFrag[] = line.fragments.map((f) => {
        const r = runs[f.itemIndex]!;
        const shy = added[f.itemIndex]!;
        // pretext leaves soft hyphens out of a fragment's text, and draws the one a line ends at as "-".
        const frag: LineFrag = { text: f.text, gap: f.gapBefore > 0, start: starts[f.itemIndex]! + toModel(shy, f.sourceStart), end: starts[f.itemIndex]! + toModel(shy, f.sourceEnd) };
        if (r.i) frag.i = true;
        if (r.b) frag.b = true;
        if (r.sc) frag.sc = true;
        if (r.sup) frag.sup = true;
        if (r.sub) frag.sub = true;
        if (r.href) frag.href = r.href;
        return frag;
      });
      // A line broken at a soft hyphen shows the hyphen; one that is not, never does.
      const tail = frags[frags.length - 1];
      if (tail?.text.endsWith("­")) tail.text = `${tail.text.slice(0, -1)}-`;
      if (frags.length > 0) lines.push({ frags, start: frags[0]!.start, end: frags[frags.length - 1]!.end, width: line.width });
      cursor = range.end;
    }
    const align = b.align === "center" ? "center" : b.align === "end" ? "end" : heading || pre || !justify ? "start" : "justify";
    const before = heading ? Math.round(m.lineHeight * ((b.level ?? 2) <= 2 ? 2 : 1.25)) : b.space ? Math.round(m.lineHeight * 0.75) : 0;
    return { ...base, kind: heading ? "h" : b.k === "pre" ? "pre" : "p", ...(b.level ? { level: b.level } : {}), size, lineHeight, lines, before, indent, inset, align };
  }
}
