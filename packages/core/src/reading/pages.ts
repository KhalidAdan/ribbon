/**
 * Laid-out text into pages, or into one long column for scrolling
 * (docs/READING.md, section 1). Pure: the typesetter (src/reader) has
 * already broken every block into lines of known height; this decides
 * where each line goes. Pages and scrolling share everything but the cut.
 */

/** A run of one style within a line. Offsets are UTF-16 within the block. */
export interface LineFrag {
  text: string;
  /** A collapsed space comes before it, drawn in this fragment's style. */
  gap: boolean;
  start: number;
  end: number;
  i?: boolean;
  b?: boolean;
  sc?: boolean;
  sup?: boolean;
  sub?: boolean;
  href?: string;
}

export interface Line {
  frags: LineFrag[];
  start: number;
  end: number;
  /** Measured width in px, before justification. */
  width: number;
}

export interface LaidBlock {
  section: number;
  block: number;
  kind: "p" | "h" | "img" | "hr" | "pre";
  lines: Line[];
  /** px per line; for an image or a break, its whole height. */
  lineHeight: number;
  /** CSS font size in px. */
  size: number;
  level?: number;
  /** Room before the block when it is not at the top of a page. */
  before: number;
  /** First line's indent, px. */
  indent: number;
  /** Inset on each side, px. */
  inset: number;
  align: "start" | "center" | "end" | "justify";
  /** `tone` says how the image is drawn in dark mode (EbookBlock.tone). */
  image?: { src: string; width: number; height: number; alt: string; tone: "ink" | "picture" };
}

/** One line, image or break, where it goes. */
export interface Placed {
  /** Index into the section's laid blocks. */
  at: number;
  /** Line index within the block; -1 for an image or a break. */
  line: number;
  y: number;
}

export interface Page {
  section: number;
  items: Placed[];
  /** Where the page starts and ends: block and offset. */
  start: { block: number; offset: number };
  end: { block: number; offset: number };
}

export interface Flow {
  section: number;
  items: Placed[];
  height: number;
}

const ORPHAN = 2;

/** Where a placed item starts, as a place in the text. */
function placeOf(blocks: readonly LaidBlock[], p: Placed): { block: number; offset: number } {
  const b = blocks[p.at]!;
  return { block: b.block, offset: p.line >= 0 ? b.lines[p.line]!.start : 0 };
}

function endOf(blocks: readonly LaidBlock[], p: Placed): { block: number; offset: number } {
  const b = blocks[p.at]!;
  return { block: b.block, offset: p.line >= 0 ? b.lines[p.line]!.end : 0 };
}

function heightOf(b: LaidBlock): number {
  return b.kind === "img" || b.kind === "hr" ? b.lineHeight : b.lines.length * b.lineHeight;
}

/**
 * Cut one section's blocks into pages `height` tall. A section always
 * starts a page, `sink` px down when it opens with a heading or an image.
 * A paragraph never leaves one line at a page's foot or carries one line
 * to the next, when it has the lines to avoid it; a heading never ends a
 * page; an image too tall for the rest of a page starts the next.
 */
export function paginate(section: number, blocks: readonly LaidBlock[], height: number, sink = 0): Page[] {
  const pages: Page[] = [];
  let items: Placed[] = [];
  let y = 0;
  const opens = blocks[0] && (blocks[0].kind === "h" || blocks[0].kind === "img");
  if (opens) y = Math.min(sink, height / 3);
  const turn = () => {
    if (items.length === 0) return;
    pages.push({ section, items, start: placeOf(blocks, items[0]!), end: endOf(blocks, items[items.length - 1]!) });
    items = [];
    y = 0;
  };
  const room = () => height - y;

  for (let at = 0; at < blocks.length; at++) {
    const b = blocks[at]!;
    const gap = items.length > 0 ? b.before : 0;
    if (b.kind === "img" || b.kind === "hr") {
      if (items.length > 0 && gap + b.lineHeight > room()) turn();
      y += items.length > 0 ? b.before : 0;
      items.push({ at, line: -1, y });
      y += b.lineHeight;
      continue;
    }
    if (b.lines.length === 0) continue;
    // A heading goes with the first lines of what follows.
    if (b.kind === "h" && items.length > 0) {
      const next = blocks[at + 1];
      const follow = next ? (next.kind === "img" || next.kind === "hr" ? 0 : next.before + Math.min(ORPHAN, next.lines.length) * next.lineHeight) : 0;
      if (gap + heightOf(b) + follow > room()) turn();
    }
    let line = 0;
    let first = true;
    while (line < b.lines.length) {
      const before = first && items.length > 0 ? b.before : 0;
      const fits = Math.max(0, Math.floor((room() - before + 0.01) / b.lineHeight));
      const left = b.lines.length - line;
      let take = Math.min(fits, left);
      if (take < left) {
        // Not the first line alone at the foot of a page.
        if (first && take < ORPHAN && left >= ORPHAN && items.length > 0) take = 0;
        // Not the last line alone at the head of the next.
        else if (left - take === 1 && take > ORPHAN) take -= 1;
      }
      if (take === 0) {
        if (items.length === 0) take = 1; // A line taller than the page still goes somewhere.
        else {
          turn();
          first = false;
          continue;
        }
      }
      y += before;
      for (let k = 0; k < take; k++) {
        items.push({ at, line: line + k, y });
        y += b.lineHeight;
      }
      line += take;
      first = false;
      if (line < b.lines.length) turn();
    }
  }
  turn();
  if (pages.length === 0) pages.push({ section, items: [], start: { block: 0, offset: 0 }, end: { block: 0, offset: 0 } });
  return pages;
}

/** One section as a single column, for scrolling. */
export function flow(section: number, blocks: readonly LaidBlock[], top = 0): Flow {
  const items: Placed[] = [];
  let y = top;
  blocks.forEach((b, at) => {
    if (items.length > 0) y += b.before;
    if (b.kind === "img" || b.kind === "hr") {
      items.push({ at, line: -1, y });
      y += b.lineHeight;
      return;
    }
    b.lines.forEach((_, line) => {
      items.push({ at, line, y });
      y += b.lineHeight;
    });
  });
  return { section, items, height: y };
}

/** Compare two places in one section. */
export function compare(a: { block: number; offset: number }, b: { block: number; offset: number }): number {
  return a.block !== b.block ? a.block - b.block : a.offset - b.offset;
}

/** The page a place is on: the last page that starts at or before it. */
export function pageOf(pages: readonly Page[], place: { block: number; offset: number }): number {
  let found = 0;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i]!.items.length > 0 && compare(pages[i]!.start, place) <= 0) found = i;
  }
  return found;
}

/**
 * The page a reader is on, counted through the whole book, and how many
 * pages the book has: from each chapter's page count, in reading order.
 * Nothing until every chapter is laid out, so the count never changes
 * under the reader as the rest of the book arrives.
 */
export function bookPage(counts: readonly (number | undefined)[], chapter: number, page: number): { page: number; of: number } | null {
  if (chapter < 0 || chapter >= counts.length || counts.some((n) => n === undefined)) return null;
  let before = 0;
  for (let i = 0; i < chapter; i++) before += counts[i]!;
  return { page: before + page + 1, of: counts.reduce<number>((all, n) => all + n!, 0) };
}

/** In a flow, the first item at or below `y`, as a place. */
export function placeAtY(blocks: readonly LaidBlock[], f: Flow, y: number): { block: number; offset: number } {
  // The first item whose bottom is below y: items run down the flow, so their bottoms only grow.
  let lo = 0;
  let hi = f.items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = f.items[mid]!;
    if (p.y + blocks[p.at]!.lineHeight > y + 1) hi = mid;
    else lo = mid + 1;
  }
  const found = f.items[Math.min(lo, f.items.length - 1)];
  return found ? placeOf(blocks, found) : { block: 0, offset: 0 };
}

/** The items of a flow that show between two heights: what to draw of a long column. */
export function itemsIn(blocks: readonly LaidBlock[], f: Flow, top: number, bottom: number): Placed[] {
  let lo = 0;
  let hi = f.items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = f.items[mid]!;
    if (p.y + blocks[p.at]!.lineHeight > top) hi = mid;
    else lo = mid + 1;
  }
  let end = lo;
  while (end < f.items.length && f.items[end]!.y < bottom) end++;
  return f.items.slice(lo, end);
}

/** In a flow, the y of the line that holds a place. */
export function yOfPlace(blocks: readonly LaidBlock[], f: Flow, place: { block: number; offset: number }): number {
  // The last item that starts at or before the place: items run through the text in order.
  let lo = 0;
  let hi = f.items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(placeOf(blocks, f.items[mid]!), place) > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo > 0 ? f.items[lo - 1]!.y : 0;
}
