/**
 * The sleep timer, as a state machine (docs/STATE-MACHINES.md). The player
 * feeds it ticks with the wall clock and the playback position; it answers
 * with a gain and whether to stop. It fades over the last FADE_MS instead
 * of cutting.
 *
 * ```
 *   off       ── start ──▶ counting (minutes) or chapter
 *   counting  ── pause ──▶ held     ── extend ──▶ counting, later   ── its end ──▶ done
 *   held      ── resume ─▶ counting ── extend ──▶ held, more left   ── nothing left ──▶ done
 *   chapter   ── extend ─▶ counting, from now                       ── the chapter's end ──▶ done
 *   done      ── extend ─▶ counting, from now
 *   any       ── start ──▶ counting or chapter;  ── cancel ──▶ off
 * ```
 *
 * Each state carries only what it needs: a running clock knows when it
 * ends, a held one how much it has left, so time spent paused is never
 * counted, whatever happens while it's held.
 */

export const FADE_MS = 15_000;

/** What the listener chose: so many minutes, or the end of the chapter playing. */
export type SleepMode = { kind: "duration"; ms: number } | { kind: "chapter" };

export type SleepState =
  /** No timer. */
  | { status: "off" }
  /** Minutes, the clock running: it ends at `endsAt` on the wall clock. */
  | { status: "counting"; endsAt: number }
  /** Minutes, the clock stopped while nothing plays: `leftMs` to go once it plays again. */
  | { status: "held"; leftMs: number }
  /** Until the chapter playing ends, however long that takes at the speed it plays. */
  | { status: "chapter" }
  /** It has fired: it says nothing more until it's started, extended or cancelled. */
  | { status: "done" };

export interface SleepTick {
  nowMs: number;
  positionMs: number;
  /** End of the current chapter in the book timeline, or null if unknown. */
  chapterEndMs: number | null;
  speed: number;
  playing: boolean;
}

export interface SleepOutput {
  /** 0..1. Multiply into the output gain. */
  gain: number;
  /** True exactly once, on the tick that crosses the deadline. */
  fire: boolean;
  /** Wall-clock ms until the timer fires, or null when idle. */
  remainingMs: number | null;
}

export const OFF: SleepState = { status: "off" };

/** Whether a timer is set: anything but off. */
export function isSet(state: SleepState): boolean {
  return state.status !== "off";
}

export function start(mode: SleepMode, nowMs: number): SleepState {
  return mode.kind === "duration" ? { status: "counting", endsAt: nowMs + mode.ms } : { status: "chapter" };
}

export function cancel(): SleepState {
  return OFF;
}

/**
 * Add time. Minutes that are counting or held get `byMs` more; a chapter
 * timer, or one that has fired, becomes `byMs` from now. Off stays off.
 */
export function extend(state: SleepState, byMs: number, nowMs: number): SleepState {
  switch (state.status) {
    case "off":
      return state;
    case "counting":
      return { status: "counting", endsAt: Math.max(nowMs, state.endsAt) + byMs };
    case "held":
      return { status: "held", leftMs: Math.max(0, state.leftMs) + byMs };
    case "chapter":
    case "done":
      return { status: "counting", endsAt: nowMs + byMs };
  }
}

/** Nothing plays: minutes stop counting. A chapter timer waits on the narration anyway. */
export function pause(state: SleepState, nowMs: number): SleepState {
  return state.status === "counting" ? { status: "held", leftMs: state.endsAt - nowMs } : state;
}

/** Playing again: held minutes count down from where they stopped. */
export function resume(state: SleepState, nowMs: number): SleepState {
  return state.status === "held" ? { status: "counting", endsAt: nowMs + state.leftMs } : state;
}

export function tick(state: SleepState, t: SleepTick): [SleepState, SleepOutput] {
  let remaining: number;
  switch (state.status) {
    case "off":
    case "done":
      return [state, { gain: 1, fire: false, remainingMs: null }];
    case "counting":
      remaining = state.endsAt - t.nowMs;
      break;
    case "held":
      remaining = state.leftMs;
      break;
    case "chapter": {
      if (t.chapterEndMs === null) return [state, { gain: 1, fire: false, remainingMs: null }];
      const audioLeft = Math.max(0, t.chapterEndMs - t.positionMs);
      remaining = Math.round(audioLeft / Math.max(0.01, t.speed));
      break;
    }
  }
  if (remaining <= 0) return [{ status: "done" }, { gain: 0, fire: true, remainingMs: 0 }];
  const gain = remaining >= FADE_MS ? 1 : remaining / FADE_MS;
  return [state, { gain, fire: false, remainingMs: remaining }];
}
