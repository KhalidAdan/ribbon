import { useRef, type PointerEvent as ReactPointerEvent, type RefObject, type WheelEvent as ReactWheelEvent } from "react";

/**
 * Turning pages by swiping, as Apple Books does: the page follows your
 * finger, with the next (or previous) page already drawn beside it, and
 * on release it either carries on over or springs back. A quick flick
 * turns however short it was. A trackpad's two-finger swipe does the same.
 *
 * The finger moves the track (the current page between its neighbours) by
 * setting its transform directly: nothing is drawn again while you drag.
 * Only the turn itself, once the slide has finished, goes through React,
 * and the reader calls `settled()` when the new page is committed, which
 * puts the track back in the middle in the same frame.
 *
 * Touch and pen swipe; a mouse selects text, and turns with the page's
 * edges or the keys instead.
 */
export function usePageSwipe({ track, width, has, turn }: { track: RefObject<HTMLElement | null>; width: number; has: (step: 1 | -1) => boolean; turn: (step: 1 | -1) => void }) {
  // The latest of what the reader passes, for handlers that outlive a render.
  const latest = useRef({ width, has, turn });
  latest.current = { width, has, turn };
  const drag = useRef<{ id: number; x0: number; y0: number; dx: number; moving: boolean; samples: { t: number; x: number }[] } | null>(null);
  const wheel = useRef<{ dx: number; samples: { t: number; x: number }[]; idle: ReturnType<typeof setTimeout> | null } | null>(null);
  /** A slide is finishing: input waits for the turn to commit. */
  const sliding = useRef(false);
  /** When the last swipe ended, so the click that follows a touch is not taken as a tap. */
  const ended = useRef(0);

  const place = (dx: number, ms = 0) => {
    const el = track.current;
    if (!el) return;
    el.style.transition = ms > 0 ? `transform ${ms}ms cubic-bezier(0.25, 0.8, 0.25, 1)` : "none";
    el.style.transform = dx === 0 ? "" : `translate3d(${dx}px, 0, 0)`;
  };

  /** How far the track goes for a finger's travel: all of it toward a page there is, a little toward the end of the book. */
  const follow = (dx: number) => (latest.current.has(dx < 0 ? 1 : -1) ? dx : dx * 0.25);

  /** Speed in px per ms over the last 100 ms, positive to the right. */
  const speed = (samples: { t: number; x: number }[]) => {
    const now = samples[samples.length - 1];
    const then = samples.find((s) => now && now.t - s.t <= 100);
    return now && then && now.t > then.t ? (now.x - then.x) / (now.t - then.t) : 0;
  };

  const release = (dx: number, v: number) => {
    ended.current = performance.now();
    const { width: w, has: can, turn: go } = latest.current;
    const step: 1 | -1 = dx < 0 ? 1 : -1;
    // Half a pixel a millisecond: a flick, not a drag let go.
    const flick = Math.abs(v) > 0.5 && Math.sign(v) === Math.sign(dx);
    if (dx === 0 || !can(step) || !(Math.abs(dx) > w * 0.25 || flick)) {
      place(0, 200);
      return;
    }
    sliding.current = true;
    // The rest of the way at the finger's speed or faster, never slower than a quick turn.
    const ms = Math.round(Math.min(280, Math.max(120, (w - Math.abs(dx)) / Math.max(Math.abs(v), 1.6))));
    place(-step * w, ms);
    setTimeout(() => {
      go(step);
      // Should the turn not come (a chapter that never arrives), the page comes back rather than staying off screen.
      setTimeout(() => sliding.current && settle(), 1500);
    }, ms);
  };

  const settle = () => {
    sliding.current = false;
    place(0);
  };

  return {
    /** The reader committed the page a turn asked for: back to the middle, at once. */
    settled: settle,
    /** Whether a swipe just ended: the click it leaves behind is not a tap. */
    justSwiped() {
      return performance.now() - ended.current < 300;
    },
    onPointerDown(e: ReactPointerEvent) {
      if (e.pointerType === "mouse" || sliding.current || drag.current) return;
      drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, moving: false, samples: [{ t: e.timeStamp, x: e.clientX }] };
    },
    onPointerMove(e: ReactPointerEvent) {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (!d.moving) {
        // Sideways more than down, and far enough not to be a tap: a swipe.
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
        d.moving = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        window.getSelection()?.removeAllRanges();
      }
      d.dx = dx;
      d.samples.push({ t: e.timeStamp, x: e.clientX });
      if (d.samples.length > 8) d.samples.shift();
      place(follow(dx));
    },
    onPointerUp(e: ReactPointerEvent) {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      // The lift counts: a finger held still before it lifts is not flicking.
      d.samples.push({ t: e.timeStamp, x: e.clientX });
      if (d.moving) release(follow(d.dx), speed(d.samples));
    },
    onPointerCancel(e: ReactPointerEvent) {
      if (drag.current?.id !== e.pointerId) return;
      const moving = drag.current.moving;
      drag.current = null;
      if (moving) place(0, 200);
    },
    onWheel(e: ReactWheelEvent) {
      // A trackpad's sideways swipe; a wheel's up and down is not a turn.
      if (sliding.current || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      const w = (wheel.current ??= { dx: 0, samples: [], idle: null });
      w.dx -= e.deltaX;
      w.samples.push({ t: e.timeStamp, x: w.dx });
      if (w.samples.length > 8) w.samples.shift();
      place(follow(w.dx));
      if (w.idle) clearTimeout(w.idle);
      // The fingers have lifted when the events stop.
      w.idle = setTimeout(() => {
        wheel.current = null;
        release(follow(w.dx), speed(w.samples));
      }, 90);
    },
  };
}
