import { describe, expect, it } from "vitest";
import { PANEL_LIMITS, WHOLE_PAGE, added, closeOn, fromPixels, inPixels, merged, moved, panelsFrom, panelsProblem, redrawn, removed, split, stepped, stops, tidied, wholeOn, type Panel } from "../src/comic/panels";

/** A page of three rows: one wide panel, then two side by side, then one wide. */
const top: Panel = { x: 0.05, y: 0.05, w: 0.9, h: 0.25 };
const left: Panel = { x: 0.05, y: 0.35, w: 0.42, h: 0.3 };
const right: Panel = { x: 0.53, y: 0.35, w: 0.42, h: 0.3 };
const foot: Panel = { x: 0.05, y: 0.7, w: 0.9, h: 0.25 };
const page = [top, left, right, foot];

describe("a page's panels", () => {
  it("keeps a panel inside its page, to four places", () => {
    expect(tidied({ x: -0.02, y: 0.1, w: 0.5, h: 0.95 })).toEqual({ x: 0, y: 0.1, w: 0.48, h: 0.9 });
    expect(tidied({ x: 0.123456, y: 0.2, w: 0.333333, h: 0.1 })).toEqual({ x: 0.1235, y: 0.2, w: 0.3333, h: 0.1 });
  });

  it("says, in a sentence, why panels can't be kept", () => {
    expect(panelsProblem(page)).toBeNull();
    // An inset inside another panel is a panel too.
    expect(panelsProblem([top, { x: 0.6, y: 0.08, w: 0.2, h: 0.1 }])).toBeNull();
    expect(panelsProblem([top, { x: 0.5, y: 0.5, w: 0.001, h: 0.3 }])).toMatch(/Panel 2 is too small/);
    expect(panelsProblem([{ x: 1.4, y: 0.2, w: 0.3, h: 0.3 }])).toMatch(/outside the page/);
    expect(panelsProblem([{ x: Number.NaN, y: 0, w: 1, h: 1 }])).toMatch(/isn't four numbers/);
    expect(panelsProblem(Array.from({ length: PANEL_LIMITS.most + 1 }, () => top))).toMatch(/at most 60/);
  });

  it("reads panels from outside as objects or as fours, and refuses anything else", () => {
    expect(panelsFrom([{ x: 0, y: 0, w: 0.5, h: 1 }, [0.5, 0, 0.5, 1]])).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
    expect(panelsFrom([])).toEqual([]);
    expect(panelsFrom("panels")).toBeNull();
    expect(panelsFrom([{ x: 0, y: 0, w: "half", h: 1 }])).toBeNull();
    expect(panelsFrom([[0, 0, 1]])).toBeNull();
  });
});

describe("editing a page's panels", () => {
  it("adds a panel at the end, or where it is read", () => {
    const inset: Panel = { x: 0.6, y: 0.08, w: 0.2, h: 0.1 };
    expect(added(page, inset)).toEqual([...page, inset]);
    expect(added(page, inset, 1)).toEqual([top, inset, left, right, foot]);
    // The list it was given is left alone.
    expect(page).toHaveLength(4);
  });

  it("removes one and draws one again", () => {
    expect(removed(page, 1)).toEqual([top, right, foot]);
    expect(redrawn(page, 3, { x: 0.05, y: 0.7, w: 0.9, h: 0.2 })[3]).toEqual({ x: 0.05, y: 0.7, w: 0.9, h: 0.2 });
  });

  it("moves a panel to another place in the order", () => {
    expect(moved(page, 3, 0)).toEqual([foot, top, left, right]);
    expect(moved(page, 0, 2)).toEqual([left, right, top, foot]);
    expect(moved(page, 9, 0)).toEqual(page);
  });

  it("cuts a wide panel in two, read left then right, or right then left in a comic that goes that way", () => {
    expect(split([top], 0, "across", 0.6)).toEqual([
      { x: 0.05, y: 0.05, w: 0.54, h: 0.25 },
      { x: 0.59, y: 0.05, w: 0.36, h: 0.25 },
    ]);
    expect(split([top], 0, "across", 0.6, true).map((p) => p.x)).toEqual([0.59, 0.05]);
    expect(split([left], 0, "down").map((p) => [p.y, p.h])).toEqual([
      [0.35, 0.15],
      [0.5, 0.15],
    ]);
  });

  it("makes two panels one, large enough for both, where the earlier was read", () => {
    expect(merged(page, 2, 1)).toEqual([top, { x: 0.05, y: 0.35, w: 0.9, h: 0.3 }, foot]);
    expect(merged(page, 1, 1)).toEqual(page);
  });
});

describe("reading by panels", () => {
  it("stops at each panel in order, or at the whole page when it has none", () => {
    expect(stops(page)).toEqual(page);
    expect(stops([])).toEqual([WHOLE_PAGE]);
    expect(stops(undefined)).toEqual([WHOLE_PAGE]);
  });

  it("fills the screen with one panel, from its middle, as the Apple apps do", () => {
    // A scanned page, 2000 by 3000, on a screen 1920 by 1080: the numbers the Apple app's test holds (ComicTests.swift).
    const [sheet, screen] = [{ width: 2000, height: 3000 }, { width: 1920, height: 1080 }];
    const whole = wholeOn(sheet, screen);
    expect(whole.scale).toBeCloseTo(0.36, 4);
    expect(whole.width).toBeCloseTo(720, 3);
    const close = closeOn(top, sheet, screen);
    expect(close.scale).toBeCloseTo((1920 * 0.94) / 1800, 4);
    expect(close.width).toBeCloseTo(1920 * 0.94, 3);
    expect(close.x).toBeCloseTo(0, 3);
    expect(close.y).toBeCloseTo(3000 * close.scale * (0.5 - 0.175), 3);
    // A small inset is not blown up past four times the whole page's size.
    expect(closeOn({ x: 0.6, y: 0.1, w: 0.05, h: 0.05 }, sheet, screen).scale).toBeCloseTo(whole.scale * 4, 4);
  });

  it("steps from panel to panel, and past a page's last to another page", () => {
    expect(stepped(0, 1, 5)).toBe(1);
    expect(stepped(3, -1, 5)).toBe(2);
    expect(stepped(4, 1, 5)).toBeNull();
    expect(stepped(0, -1, 5)).toBeNull();
  });

  it("is the same panel on a page drawn at any size", () => {
    expect(inPixels(left, { width: 2000, height: 3000 })).toEqual({ x: 100, y: 1050, width: 840, height: 900 });
    expect(fromPixels({ x: 50, y: 525, width: 420, height: 450 }, { width: 1000, height: 1500 })).toEqual(left);
    expect(fromPixels({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual(WHOLE_PAGE);
  });
});
