/**
 * Whether a book is playing, as a state machine (docs/STATE-MACHINES.md):
 * what the player bar, the play button, the system's media controls and
 * the listening history all read, from one status rather than from flags.
 *
 * The player (desktop's player/engine.ts) says what happened, an event,
 * and `nextStatus` says what it means; nothing else changes the status.
 * `NEXT` below is the whole of it, every status by every event, so the
 * compiler holds it to an answer for each.
 *
 * ```
 *  paused ── play ──▶ starting ── sounding ──────────────▶ playing
 *                        │                                │  ▲
 *                     waiting                       waiting  sounding
 *                        ▼                                ▼  │
 *                     loading ── sounding ──▶ playing   buffering
 *
 *  starting, loading, playing, buffering ── retry ──▶ reconnecting ── sounding ──▶ playing
 *  any ── pause, load, paused outside, refused, failed, ended ──▶ paused
 * ```
 */

export type PlaybackStatus =
  /** Nothing plays, and the listener hasn't asked it to. */
  | "paused"
  /** Play was pressed; the audio hasn't answered yet (a moment, when the file is ready). */
  | "starting"
  /** Play was pressed, and the file is still arriving: nothing has been heard yet. */
  | "loading"
  /** The book is being heard. */
  | "playing"
  /** It was being heard, and stopped to wait for more of the file. */
  | "buffering"
  /** A file failed or stalled, and is being opened again at the last good place, again and again until it plays. */
  | "reconnecting";

export type PlaybackEvent =
  /** The listener asked to play. */
  | "play"
  /** The listener asked to pause. */
  | "pause"
  /** A book was loaded, or loaded again: it rests at its place. */
  | "load"
  /** The audio says it's sounding. */
  | "sounding"
  /** The audio says it's waiting for more of the file. */
  | "waiting"
  /** Something outside Ribbon paused the audio: the system, another app, a device going. */
  | "paused-outside"
  /** The system won't play without a press first. */
  | "refused"
  /** A file failed or stalled while the listener wants to hear it: it will be opened again. */
  | "retry"
  /** A file failed while nothing was playing: the next play opens it again. */
  | "failed"
  /** The book played to its end. */
  | "ended";

/** Every status the listener ends up in, for every event, from every status. */
const NEXT: Record<PlaybackStatus, Record<PlaybackEvent, PlaybackStatus>> = {
  // Waiting for the file matters only while the listener wants to hear it: a late word from the audio after a pause is not "Loading…".
  paused:       { play: "starting",     waiting: "paused",       sounding: "playing", retry: "reconnecting", pause: "paused", load: "paused", "paused-outside": "paused", refused: "paused", failed: "paused", ended: "paused" },
  starting:     { play: "starting",     waiting: "loading",      sounding: "playing", retry: "reconnecting", pause: "paused", load: "paused", "paused-outside": "paused", refused: "paused", failed: "paused", ended: "paused" },
  loading:      { play: "loading",      waiting: "loading",      sounding: "playing", retry: "reconnecting", pause: "paused", load: "paused", "paused-outside": "paused", refused: "paused", failed: "paused", ended: "paused" },
  playing:      { play: "playing",      waiting: "buffering",    sounding: "playing", retry: "reconnecting", pause: "paused", load: "paused", "paused-outside": "paused", refused: "paused", failed: "paused", ended: "paused" },
  buffering:    { play: "buffering",    waiting: "buffering",    sounding: "playing", retry: "reconnecting", pause: "paused", load: "paused", "paused-outside": "paused", refused: "paused", failed: "paused", ended: "paused" },
  // Reconnecting goes on until the audio sounds or something stops it: a pause from outside, or a refusal, ends it, rather than leaving "Reconnecting…" up with nothing trying.
  reconnecting: { play: "reconnecting", waiting: "reconnecting", sounding: "playing", retry: "reconnecting", pause: "paused", load: "paused", "paused-outside": "paused", refused: "paused", failed: "paused", ended: "paused" },
};

export function nextStatus(from: PlaybackStatus, event: PlaybackEvent): PlaybackStatus {
  return NEXT[from][event];
}

/** Every status, in the order above: for tests and for anything that lists them. */
export const PLAYBACK_STATUSES = Object.keys(NEXT) as PlaybackStatus[];

/**
 * The book is being heard, or was a moment ago and is waiting for more of
 * the file: the listening history counts it, places are kept as it moves,
 * and nothing that would cut it short is offered.
 */
export function isPlaying(status: PlaybackStatus): boolean {
  return status === "playing" || status === "buffering";
}

/** The listener wants to hear it, whether or not it's heard yet: the button pauses, and the system's controls say it plays. */
export function wantsToPlay(status: PlaybackStatus): boolean {
  return status !== "paused";
}

/** The audio is waiting for the file, before the first sound or after: "Loading…". */
export function isLoading(status: PlaybackStatus): boolean {
  return status === "loading" || status === "buffering";
}
