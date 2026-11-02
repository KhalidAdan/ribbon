/**
 * Sleep timer as a pure state machine. The player feeds it ticks with
 * the wall clock and the playback position; it answers with a gain and
 * whether to stop. Fades over the last FADE_MS instead of cutting.
 */

export const FADE_MS = 15_000;

export type SleepMode = { kind: "duration"; ms: number } | { kind: "chapter" };

export interface SleepState {
  mode: SleepMode | null;
  /** Wall-clock ms at which a duration timer fires. */
  fireAt: number | null;
  /** Wall-clock ms at which the clock was paused, or null while running. */
  pausedAt: number | null;
  fired: boolean;
}

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

export const IDLE: SleepState = { mode: null, fireAt: null, pausedAt: null, fired: false };

export function start(mode: SleepMode, nowMs: number): SleepState {
  return {
    mode,
    fireAt: mode.kind === "duration" ? nowMs + mode.ms : null,
    pausedAt: null,
    fired: false,
  };
}

export function cancel(): SleepState {
  return IDLE;
}

/** Add time. In chapter mode this converts to a duration timer. */
export function extend(state: SleepState, byMs: number, nowMs: number): SleepState {
  if (!state.mode) return state;
  const base = state.mode.kind === "duration" && state.fireAt !== null ? Math.max(nowMs, state.fireAt) : nowMs;
  return { mode: { kind: "duration", ms: byMs }, fireAt: base + byMs, pausedAt: null, fired: false };
}

export function pause(state: SleepState, nowMs: number): SleepState {
  if (!state.mode || state.pausedAt !== null) return state;
  return { ...state, pausedAt: nowMs };
}

export function resume(state: SleepState, nowMs: number): SleepState {
  if (!state.mode || state.pausedAt === null) return state;
  const fireAt = state.fireAt === null ? null : state.fireAt + (nowMs - state.pausedAt);
  return { ...state, fireAt, pausedAt: null };
}

export function tick(state: SleepState, t: SleepTick): [SleepState, SleepOutput] {
  if (!state.mode || state.fired) return [state, { gain: 1, fire: false, remainingMs: null }];

  let remaining: number | null;
  if (state.mode.kind === "duration") {
    const fireAt = state.fireAt ?? t.nowMs;
    const clock = state.pausedAt ?? t.nowMs;
    remaining = fireAt - clock;
  } else {
    if (t.chapterEndMs === null) return [state, { gain: 1, fire: false, remainingMs: null }];
    const audioLeft = Math.max(0, t.chapterEndMs - t.positionMs);
    remaining = Math.round(audioLeft / Math.max(0.01, t.speed));
  }

  if (remaining <= 0) {
    return [{ ...state, fired: true }, { gain: 0, fire: true, remainingMs: 0 }];
  }
  const gain = remaining >= FADE_MS ? 1 : remaining / FADE_MS;
  return [state, { gain, fire: false, remainingMs: remaining }];
}
