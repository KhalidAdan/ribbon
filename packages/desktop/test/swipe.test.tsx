// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePageSwipe } from "../src/reader/swipe";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 400;

let root: Root | null = null;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/**
 * The swipe on a track of pages, as the reader uses it: a turn commits a
 * moment after it's asked for, and says so; or, as a chapter that never
 * arrives, never commits.
 */
function aTrack({ commits = true } = {}) {
  let swipe!: ReturnType<typeof usePageSwipe>;
  const turns: number[] = [];
  const track = document.createElement("div");
  function Pages() {
    const ref = useRef<HTMLElement | null>(track);
    swipe = usePageSwipe({
      track: ref,
      width: WIDTH,
      has: () => true,
      // The reader commits the page and calls settled() once it's drawn.
      turn: (step) => {
        turns.push(step);
        if (commits) setTimeout(() => swipe.settled(), 16);
      },
    });
    return null;
  }
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(createElement(Pages)));
  let t = 0;
  const event = (x: number) => ({ pointerType: "touch", pointerId: 1, clientX: x, clientY: 300, timeStamp: (t += 16), currentTarget: { setPointerCapture: () => undefined } }) as never;
  /** A finger from the right edge most of the way across, quickly, and off. */
  const swipeLeft = () => {
    swipe.onPointerDown(event(380));
    for (const x of [360, 300, 200, 100, 60]) swipe.onPointerMove(event(x));
    swipe.onPointerUp(event(60));
  };
  return { track, turns, swipeLeft };
}

describe("turning pages by swiping", () => {
  it("slides over, turns, and settles back in the middle", () => {
    const p = aTrack();
    p.swipeLeft();
    expect(p.track.style.transform).toBe(`translate3d(-${WIDTH}px, 0, 0)`);
    act(() => vi.advanceTimersByTime(300));
    expect(p.turns).toEqual([1]);
    expect(p.track.style.transform).toBe("");
  });

  it("a page left off screen comes back when its turn never commits", () => {
    const p = aTrack({ commits: false });
    p.swipeLeft();
    act(() => vi.advanceTimersByTime(300));
    expect(p.turns).toEqual([1]);
    expect(p.track.style.transform).toBe(`translate3d(-${WIDTH}px, 0, 0)`);
    act(() => vi.advanceTimersByTime(1_500));
    expect(p.track.style.transform).toBe("");
  });

  it("an earlier swipe's fallback leaves a later swipe's slide alone", () => {
    const p = aTrack();
    p.swipeLeft();
    // The first slide takes 120 ms and its turn commits; its fallback is still set, for 1.5 s after the turn was asked.
    act(() => vi.advanceTimersByTime(1_550));
    expect(p.turns).toEqual([1]);
    expect(p.track.style.transform).toBe("");
    // A second swipe, let go 70 ms before the first one's fallback is due: still sliding when it comes.
    p.swipeLeft();
    expect(p.track.style.transform).toBe(`translate3d(-${WIDTH}px, 0, 0)`);
    act(() => vi.advanceTimersByTime(80));
    // The first fallback has fired: the second slide is still on its way over, not snapped back mid-slide.
    expect(p.track.style.transform).toBe(`translate3d(-${WIDTH}px, 0, 0)`);
    act(() => vi.advanceTimersByTime(300));
    expect(p.turns).toEqual([1, 1]);
    expect(p.track.style.transform).toBe("");
  });
});
