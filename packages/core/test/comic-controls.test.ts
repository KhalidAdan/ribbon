import { describe, expect, it } from "vitest";
import { comicKey, keyList } from "@ribbon/core/comic/keys";
import { nextGround, parseComicSettings } from "@ribbon/core/comic/settings";
import { pageBox } from "@ribbon/core/comic/size";
import { keptInPlace, pageTyped, startingCorner, zoomed, zoomFactor, zoomIn, zoomOut, zoomToggled } from "@ribbon/core/comic/zoom";

describe("the zoom", () => {
  it("steps through the whole page, one and a half, two and three times it, and stops at either end", () => {
    const steps = [0];
    for (let i = 0; i < 4; i++) steps.push(zoomIn(steps[steps.length - 1]!));
    expect(steps.map(zoomFactor)).toEqual([1, 1.5, 2, 3, 3]);
    expect(zoomOut(3)).toBe(2);
    expect(zoomOut(0)).toBe(0);
  });

  it("goes from the whole page to twice it with a click in the middle, and back from any zoom", () => {
    expect(zoomFactor(zoomToggled(0))).toBe(2);
    expect(zoomToggled(1)).toBe(0);
    expect(zoomToggled(3)).toBe(0);
  });

  it("draws the page that many times larger, in whole pixels", () => {
    expect(zoomed({ width: 601, height: 900 }, 1)).toEqual({ width: 901, height: 1350 });
    expect(zoomed({ width: 601, height: 900 }, 0)).toEqual({ width: 601, height: 900 });
  });

  it("brings a new page in at its top, at the corner the comic starts from", () => {
    const content = { width: 2400, height: 3600 };
    const view = { width: 1000, height: 800 };
    expect(startingCorner(false, content, view)).toEqual({ left: 0, top: 0 });
    expect(startingCorner(true, content, view)).toEqual({ left: 1400, top: 0 });
    // Narrower than the view: nowhere to go sideways.
    expect(startingCorner(true, { width: 600, height: 3600 }, view)).toEqual({ left: 0, top: 0 });
  });

  it("keeps the point under the pointer over the same part of the page as it grows", () => {
    const view = { width: 1000, height: 800 };
    // The whole page, 500 by 800, centred: 250 to 750 across. A click at its middle, 500 across, 400 down.
    const to = keptInPlace({ x: 500, y: 400 }, { left: 0, top: 0 }, { width: 500, height: 800 }, { width: 1000, height: 1600 }, view);
    // Twice as large, 1000 wide: no room either side, and its middle (500, 800) under the pointer.
    expect(to).toEqual({ left: 0, top: 400 });
    // From its top left quarter: what was under the pointer stays there.
    const corner = keptInPlace({ x: 375, y: 200 }, { left: 0, top: 0 }, { width: 500, height: 800 }, { width: 1500, height: 2400 }, view);
    // The point was a quarter across and down the page; at 1500 by 2400 that is 375 and 600, so 0 and 400 scrolled.
    expect(corner).toEqual({ left: 0, top: 400 });
    // Never past what can be scrolled to: from three times the page, scrolled to its far corner, back to one and a half.
    expect(keptInPlace({ x: 10, y: 10 }, { left: 2000, top: 1600 }, { width: 3000, height: 2400 }, { width: 1500, height: 1200 }, view)).toEqual({ left: 500, top: 400 });
  });
});

describe("going to a page", () => {
  it("takes the number typed, counted from 1, and goes to either end for one past it", () => {
    expect(pageTyped("12", 24)).toBe(11);
    expect(pageTyped(" 1 ", 24)).toBe(0);
    expect(pageTyped("99", 24)).toBe(23);
    expect(pageTyped("0", 24)).toBe(0);
    expect(pageTyped("-4", 24)).toBe(0);
    expect(pageTyped("", 24)).toBeNull();
    expect(pageTyped("twelve", 24)).toBeNull();
    expect(pageTyped("1.5", 24)).toBeNull();
  });
});

describe("fitted to the height", () => {
  it("is as tall as the room, and a page drawn across two runs past the sides", () => {
    const room = { width: 1000, height: 800 };
    expect(pageBox({ width: 1000, height: 1500 }, 1, room, "height")).toEqual({ width: 533, height: 800 });
    expect(pageBox({ width: 3000, height: 2000 }, 1, room, "height")).toEqual({ width: 1200, height: 800 });
    // Two up, each page as tall as the room.
    expect(pageBox({ width: 1000, height: 1500 }, 2, room, "height")).toEqual({ width: 533, height: 800 });
  });
});

describe("the view's keys", () => {
  it("are the letters of section 15, either case, and the zoom with or without Shift", () => {
    expect(["g", "T", "d", "R", "p", "1", "2", "3", "b", "+", "=", "-", "_", "0", "?"].map(comicKey)).toEqual([
      "jump", "strip", "two-up", "direction", "panels", "fit-page", "fit-width", "fit-height", "ground", "zoom-in", "zoom-in", "zoom-out", "zoom-out", "zoom-whole", "keys",
    ]);
    // The reader's own keys, and anything else, aren't the view's.
    for (const key of ["ArrowRight", " ", "Escape", "Home", "x", "Enter"]) expect(comicKey(key)).toBeNull();
  });

  it("are listed with the arrows the way the comic reads", () => {
    expect(keyList(false)[0]!.keys[0]).toBe("→");
    expect(keyList(true)[0]!.keys[0]).toBe("←");
    expect(keyList(true)[1]!.keys[0]).toBe("→");
    // Every one of the view's keys is in the list.
    const listed = keyList(false).flatMap((l) => l.keys);
    for (const key of ["G", "T", "D", "R", "P", "1", "2", "3", "B", "+", "-", "0", "?"]) expect(listed).toContain(key);
  });
});

describe("the ground behind the page", () => {
  it("is Ribbon's own until chosen, and B goes through black, grey and white back to it", () => {
    expect(parseComicSettings(undefined).ground).toBe("ribbon");
    expect(["ribbon", "black", "grey", "white"].map((g) => nextGround(g as never))).toEqual(["black", "grey", "white", "ribbon"]);
    expect(parseComicSettings({ ground: "white", fit: "height" })).toMatchObject({ ground: "white", fit: "height" });
    expect(parseComicSettings({ ground: "purple", fit: "sideways" })).toMatchObject({ ground: "ribbon", fit: "page" });
  });
});
