import type { PixelSize } from "./size";

/**
 * A comic page's panels (docs/COMICS.md, section 14): the rectangles a
 * reader is shown one at a time, in the order they are read.
 *
 * A panel is a rectangle on its page, measured in fractions of the page:
 * `x` and `y` are its top left corner, 0 at the page's left and top, and
 * `w` and `h` its size, 1 being the whole page. Fractions, not pixels,
 * because a page is drawn at many sizes (a device's screen, a PDF's page
 * at two widths) and its panels are the same on every one.
 *
 * The order of the list is the order of reading. Nothing here works that
 * order out: a person says it, or an assistant looking at the page does,
 * and either can change it. Everything that lists, checks or edits a
 * page's panels calls these functions, whether it is the server's MCP
 * (packages/server/src/mcp.ts) or an editor on a screen, so the two can't
 * disagree about what a page's panels may be.
 */
export interface Panel {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a page's panels may be. A page has a handful; one with a hundred is a mistake. */
export const PANEL_LIMITS = {
  /** The most panels on one page. */
  most: 60,
  /** The least a panel may measure, either way, as a fraction of the page: smaller is a slip of the hand. */
  smallest: 0.02,
};

/** The whole page as one panel: a splash page, or a page nobody has divided. */
export const WHOLE_PAGE: Panel = { x: 0, y: 0, w: 1, h: 1 };

/** A fraction kept to four places, which is finer than a pixel of any page. */
function rounded(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * A panel as it is kept: inside its page, its numbers rounded. A box drawn
 * a little past the page's edge, as a hand or an estimate does, is cut
 * back to the edge.
 */
export function tidied(panel: Panel): Panel {
  const left = Math.max(0, Math.min(1, panel.x));
  const top = Math.max(0, Math.min(1, panel.y));
  const right = Math.max(left, Math.min(1, panel.x + panel.w));
  const bottom = Math.max(top, Math.min(1, panel.y + panel.h));
  return { x: rounded(left), y: rounded(top), w: rounded(right - left), h: rounded(bottom - top) };
}

/** Why a page's panels can't be kept, in a sentence, or null when they can. Panels may overlap: an inset sits inside another. */
export function panelsProblem(panels: readonly Panel[]): string | null {
  if (panels.length > PANEL_LIMITS.most) return `A page has at most ${PANEL_LIMITS.most} panels, and this has ${panels.length}.`;
  for (const [at, panel] of panels.entries()) {
    if (![panel.x, panel.y, panel.w, panel.h].every(Number.isFinite)) return `Panel ${at + 1} isn't four numbers.`;
    const kept = tidied(panel);
    if (kept.w < PANEL_LIMITS.smallest || kept.h < PANEL_LIMITS.smallest) return `Panel ${at + 1} is too small to be one, or lies outside the page. Each is measured in fractions of the page, from 0 to 1.`;
  }
  return null;
}

/**
 * A page's panels read from something that came from outside (a request,
 * a stored record): a list of `{x, y, w, h}`, or of `[x, y, w, h]`. Null
 * when it isn't one. What comes back is tidied, and still to be checked
 * with `panelsProblem`.
 */
export function panelsFrom(value: unknown): Panel[] | null {
  if (!Array.isArray(value)) return null;
  const out: Panel[] = [];
  for (const one of value) {
    const four = Array.isArray(one) ? one : one && typeof one === "object" ? [(one as Panel).x, (one as Panel).y, (one as Panel).w, (one as Panel).h] : null;
    if (!four || four.length !== 4 || !four.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    const [x, y, w, h] = four as [number, number, number, number];
    out.push(tidied({ x, y, w, h }));
  }
  return out;
}

// Editing a page's panels. Each gives a new list and leaves the one it was given alone. -------

/** With a panel put in at a place in the order, counted from 0; at the end when no place is said. */
export function added(panels: readonly Panel[], panel: Panel, at = panels.length): Panel[] {
  const place = Math.max(0, Math.min(panels.length, Math.round(at)));
  return [...panels.slice(0, place), tidied(panel), ...panels.slice(place)];
}

/** Without the panel at a place. */
export function removed(panels: readonly Panel[], at: number): Panel[] {
  return panels.filter((_, i) => i !== at);
}

/** With the panel at a place drawn again. */
export function redrawn(panels: readonly Panel[], at: number, panel: Panel): Panel[] {
  return panels.map((was, i) => (i === at ? tidied(panel) : was));
}

/** With one panel moved to another place in the order: read third, say, instead of fifth. */
export function moved(panels: readonly Panel[], from: number, to: number): Panel[] {
  if (from < 0 || from >= panels.length) return [...panels];
  const out = panels.filter((_, i) => i !== from);
  out.splice(Math.max(0, Math.min(out.length, Math.round(to))), 0, panels[from]!);
  return out;
}

/**
 * With one panel cut in two, read one after the other. Cut `across`, it
 * becomes a left and a right; cut `down`, an upper and a lower. `where` is
 * how far through the panel the cut falls. In a comic read right to left
 * the right half of a panel cut across is read first.
 */
export function split(panels: readonly Panel[], at: number, cut: "across" | "down", where = 0.5, rightToLeft = false): Panel[] {
  const panel = panels[at];
  if (!panel) return [...panels];
  const part = Math.max(0, Math.min(1, where));
  const halves: [Panel, Panel] =
    cut === "across"
      ? [
          { ...panel, w: panel.w * part },
          { ...panel, x: panel.x + panel.w * part, w: panel.w * (1 - part) },
        ]
      : [
          { ...panel, h: panel.h * part },
          { ...panel, y: panel.y + panel.h * part, h: panel.h * (1 - part) },
        ];
  if (cut === "across" && rightToLeft) halves.reverse();
  return [...panels.slice(0, at), ...halves.map(tidied), ...panels.slice(at + 1)];
}

/** With two panels made one, large enough to hold both, read where the earlier of the two was. */
export function merged(panels: readonly Panel[], one: number, other: number): Panel[] {
  const [a, b] = [panels[one], panels[other]];
  if (!a || !b || one === other) return [...panels];
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const both = tidied({ x: left, y: top, w: Math.max(a.x + a.w, b.x + b.w) - left, h: Math.max(a.y + a.h, b.y + b.h) - top });
  const first = Math.min(one, other);
  return panels.flatMap((panel, i) => (i === first ? [both] : i === one || i === other ? [] : [panel]));
}

// Reading by them. ------------------------------------------------------------------------------

/** What a reader stops at on a page, in order: its panels, or the page whole when it has none. */
export function stops(panels: readonly Panel[] | undefined): Panel[] {
  return panels && panels.length > 0 ? [...panels] : [WHOLE_PAGE];
}

/** A rectangle in a picture's own pixels. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A panel as pixels of its page drawn at a size. */
export function inPixels(panel: Panel, page: PixelSize): PixelBox {
  return { x: Math.round(panel.x * page.width), y: Math.round(panel.y * page.height), width: Math.round(panel.w * page.width), height: Math.round(panel.h * page.height) };
}

/** A box measured in pixels of a page drawn at a size, as the panel it is on any drawing of that page. */
export function fromPixels(box: PixelBox, page: PixelSize): Panel {
  if (page.width <= 0 || page.height <= 0) return WHOLE_PAGE;
  return tidied({ x: box.x / page.width, y: box.y / page.height, w: box.width / page.width, h: box.height / page.height });
}
