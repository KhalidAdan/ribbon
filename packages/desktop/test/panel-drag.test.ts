import { describe, expect, it } from "vitest";
import type { Panel } from "@ribbon/core/comic/panels";
import { between, cursorOf, gripAt, panelAt, pulled } from "../src/comic/panel-drag";

/** A panel in the middle of the page, an inset inside it, and how near an edge counts as on it. */
const panel: Panel = { x: 0.2, y: 0.2, w: 0.6, h: 0.4 };
const inset: Panel = { x: 0.5, y: 0.25, w: 0.2, h: 0.1 };
const reach = { x: 0.01, y: 0.01 };

describe("what a pointer does to a page's panels", () => {
  it("holds a panel by its middle, an edge or a corner, and not at all from off it", () => {
    expect(gripAt(panel, { x: 0.5, y: 0.4 }, reach)).toBe("move");
    expect(gripAt(panel, { x: 0.2, y: 0.4 }, reach)).toBe("w");
    expect(gripAt(panel, { x: 0.805, y: 0.4 }, reach)).toBe("e");
    expect(gripAt(panel, { x: 0.5, y: 0.2 }, reach)).toBe("n");
    expect(gripAt(panel, { x: 0.8, y: 0.6 }, reach)).toBe("se");
    expect(gripAt(panel, { x: 0.2, y: 0.2 }, reach)).toBe("nw");
    expect(gripAt(panel, { x: 0.1, y: 0.4 }, reach)).toBeNull();
    // A small panel still has a middle: its edges take no more than a third of it each.
    expect(gripAt({ x: 0.5, y: 0.5, w: 0.03, h: 0.03 }, { x: 0.515, y: 0.515 }, { x: 0.05, y: 0.05 })).toBe("move");
  });

  it("finds the inset, not the panel it sits in, unless that one is already chosen", () => {
    const at = { x: 0.6, y: 0.3 };
    expect(panelAt([panel, inset], at, reach, null)).toEqual({ at: 1, grip: "move" });
    expect(panelAt([panel, inset], at, reach, 0)).toEqual({ at: 0, grip: "move" });
    expect(panelAt([panel, inset], { x: 0.05, y: 0.05 }, reach, null)).toBeNull();
  });

  it("moves a panel whole, and never off the page", () => {
    expect(pulled(panel, "move", { x: 0.1, y: -0.1 })).toEqual({ x: 0.3, y: 0.1, w: 0.6, h: 0.4 });
    expect(pulled(panel, "move", { x: 0.9, y: 0.9 })).toEqual({ x: 0.4, y: 0.6, w: 0.6, h: 0.4 });
    expect(pulled(panel, "move", { x: -0.9, y: -0.9 })).toEqual({ x: 0, y: 0, w: 0.6, h: 0.4 });
  });

  it("draws a panel larger or smaller by the edge it is held by, the others staying", () => {
    expect(pulled(panel, "e", { x: 0.1, y: 0.3 })).toEqual({ x: 0.2, y: 0.2, w: 0.7, h: 0.4 });
    expect(pulled(panel, "nw", { x: -0.1, y: 0.1 })).toEqual({ x: 0.1, y: 0.3, w: 0.7, h: 0.3 });
    // Never past the page's edge, and never past its own far edge: it stops at the least a panel may be.
    expect(pulled(panel, "s", { x: 0, y: 0.9 })).toEqual({ x: 0.2, y: 0.2, w: 0.6, h: 0.8 });
    expect(pulled(panel, "w", { x: 0.9, y: 0 })).toEqual({ x: 0.78, y: 0.2, w: 0.02, h: 0.4 });
  });

  it("draws a new panel from a drag either way, and takes a click for no panel", () => {
    expect(between({ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.4 })).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
    expect(between({ x: 0.5, y: 0.4 }, { x: 0.1, y: 0.1 })).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
    expect(between({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.9 })).toBeNull();
    // Dragged past the page's edge, it ends at the edge.
    expect(between({ x: 0.8, y: 0.8 }, { x: 1.4, y: 1.2 })).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
  });

  it("shows by the pointer what a press will do", () => {
    expect(cursorOf(null)).toBe("crosshair");
    expect(cursorOf("move")).toBe("move");
    expect(cursorOf("n")).toBe("ns-resize");
    expect(cursorOf("se")).toBe("nwse-resize");
    expect(cursorOf("ne")).toBe("nesw-resize");
  });
});
