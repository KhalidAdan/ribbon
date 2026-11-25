import { PANEL_LIMITS, tidied, type Panel } from "@ribbon/core/comic/panels";

/**
 * What a pointer does to a page's panels in the editor (PanelEditor.tsx),
 * worked out with no screen: which panel a point is on and by what part
 * it is held, and what the panel is after it is pulled. Everything is in
 * fractions of the page, as panels are (core/comic/panels.ts).
 */

/** A point on the page, or a distance across it. */
export interface Point {
  x: number;
  y: number;
}

/** What a panel is held by: its middle, to move it, or an edge or a corner, to draw it larger or smaller. */
export type Grip = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * The part of a panel a point holds it by, or null when the point is off
 * it. `reach` is how near an edge counts as on it, across and down (a few
 * pixels of the screen, as fractions of the page).
 */
export function gripAt(panel: Panel, at: Point, reach: Point): Grip | null {
  const [left, top, right, bottom] = [panel.x, panel.y, panel.x + panel.w, panel.y + panel.h];
  if (at.x < left - reach.x || at.x > right + reach.x || at.y < top - reach.y || at.y > bottom + reach.y) return null;
  // No further in than a third of the panel, so a small one still has a middle to move it by.
  const [nearX, nearY] = [Math.min(reach.x, panel.w / 3), Math.min(reach.y, panel.h / 3)];
  const across = at.x <= left + nearX ? "w" : at.x >= right - nearX ? "e" : "";
  const down = at.y <= top + nearY ? "n" : at.y >= bottom - nearY ? "s" : "";
  return (down + across || "move") as Grip;
}

/**
 * The panel a point is on, and the part it holds it by. The one already
 * chosen is asked first, so its edges can be taken hold of where another
 * panel lies over them; then the smallest panel the point is on, which is
 * the inset and not the panel it sits in.
 */
export function panelAt(panels: readonly Panel[], at: Point, reach: Point, chosen: number | null): { at: number; grip: Grip } | null {
  if (chosen !== null && panels[chosen]) {
    const grip = gripAt(panels[chosen], at, reach);
    if (grip) return { at: chosen, grip };
  }
  let found: { at: number; grip: Grip; area: number } | null = null;
  for (const [i, panel] of panels.entries()) {
    const grip = gripAt(panel, at, reach);
    if (grip && (!found || panel.w * panel.h < found.area)) found = { at: i, grip, area: panel.w * panel.h };
  }
  return found && { at: found.at, grip: found.grip };
}

/**
 * A panel after it is pulled `by` a distance from where it was held.
 * Moved, it keeps its size and stays on the page. Pulled by an edge or a
 * corner, that edge follows and the others stay, and it is never made
 * smaller than a panel may be, nor pulled past its own far edge.
 */
export function pulled(panel: Panel, grip: Grip, by: Point): Panel {
  if (grip === "move") {
    return tidied({ ...panel, x: Math.max(0, Math.min(1 - panel.w, panel.x + by.x)), y: Math.max(0, Math.min(1 - panel.h, panel.y + by.y)) });
  }
  const least = PANEL_LIMITS.smallest;
  let [left, top, right, bottom] = [panel.x, panel.y, panel.x + panel.w, panel.y + panel.h];
  if (grip.includes("w")) left = Math.max(0, Math.min(right - least, left + by.x));
  if (grip.includes("e")) right = Math.min(1, Math.max(left + least, right + by.x));
  if (grip.includes("n")) top = Math.max(0, Math.min(bottom - least, top + by.y));
  if (grip.includes("s")) bottom = Math.min(1, Math.max(top + least, bottom + by.y));
  return tidied({ x: left, y: top, w: right - left, h: bottom - top });
}

/** The panel drawn by a drag from one point to another, whichever way it went. Null when it is too small to be one: a click, not a drag. */
export function between(from: Point, to: Point): Panel | null {
  const panel = tidied({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) });
  return panel.w >= PANEL_LIMITS.smallest && panel.h >= PANEL_LIMITS.smallest ? panel : null;
}

/** The pointer a grip shows, so a hand knows what a press will do before it presses. */
export function cursorOf(grip: Grip | null): string {
  if (!grip) return "crosshair";
  if (grip === "move") return "move";
  if (grip === "n" || grip === "s") return "ns-resize";
  if (grip === "e" || grip === "w") return "ew-resize";
  return grip === "nw" || grip === "se" ? "nwse-resize" : "nesw-resize";
}
