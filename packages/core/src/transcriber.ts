/**
 * Transcribing on this machine, as a state machine (docs/STATE-MACHINES.md):
 * the open book's narration, heard while it's open to read, and a server's
 * books, transcribed in the background for every device (#152). The open
 * book comes first: the server's worker stops for it, and starts again
 * after.
 *
 * ```
 *   the open book:   idle    ── began ──▶ hearing
 *                    hearing ── asked again ──▶ hearing, once more after
 *                    hearing ── ended ──▶ idle (and heard again, if it was asked meanwhile)
 *
 *   a server's:      idle    ── began ──▶ working
 *                    working ── ended (nothing left, or the open book is heard) ──▶ idle
 *                    working ── wait (out of reach, or the model stalled) ──▶ waiting a while
 *                    waiting ── the while is up ──▶ idle, and asked to begin
 *                    waiting ── began (asked meanwhile) ──▶ working
 *                    working ── a book whole ──▶ working, and the next wait back to a minute
 *
 *   both:            any ── reset (Ribbon's own folder reset) ──▶ idle, idle
 * ```
 *
 * Whether the computer stays awake (#158) is worked out from the two,
 * hearing or working, and never kept beside them; a wait isn't work.
 */
export interface Transcribing {
  reader: { status: "idle" } | { status: "hearing"; again: boolean };
  server: { status: "idle" } | { status: "working" } | { status: "waiting"; ms: number };
  /** The last wait, so the next is twice it: from a minute to half an hour, and none again once a book is whole. */
  waitedMs: number;
}

export type TranscribingEvent =
  | { type: "hearing began" }
  /** The open book's hearing was asked for while it's hearing: once more after. */
  | { type: "asked again" }
  | { type: "hearing ended" }
  | { type: "work began" }
  | { type: "work ended" }
  | { type: "wait" }
  | { type: "wait over" }
  /** A server's book transcribed whole: the next wait starts from a minute again. */
  | { type: "whole" }
  | { type: "reset" };

export const MIN_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 30 * 60_000;

export const IDLE: Transcribing = { reader: { status: "idle" }, server: { status: "idle" }, waitedMs: 0 };

/** Transcribing after an event: the one place it changes. Returns the same object when nothing does. */
export function transcribingAfter(t: Transcribing, event: TranscribingEvent): Transcribing {
  switch (event.type) {
    case "hearing began":
      return { ...t, reader: { status: "hearing", again: false } };
    case "asked again":
      return t.reader.status === "hearing" && !t.reader.again ? { ...t, reader: { status: "hearing", again: true } } : t;
    case "hearing ended":
      return t.reader.status === "idle" ? t : { ...t, reader: { status: "idle" } };
    case "work began":
      return t.server.status === "working" ? t : { ...t, server: { status: "working" } };
    case "work ended":
      // A wait asked for while it worked outlasts the work.
      return t.server.status === "working" ? { ...t, server: { status: "idle" } } : t;
    case "wait": {
      // Once, however many reasons there are.
      if (t.server.status === "waiting") return t;
      const ms = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, t.waitedMs * 2));
      return { ...t, server: { status: "waiting", ms }, waitedMs: ms };
    }
    case "wait over":
      return t.server.status === "waiting" ? { ...t, server: { status: "idle" } } : t;
    case "whole":
      return t.waitedMs === 0 ? t : { ...t, waitedMs: 0 };
    case "reset":
      return IDLE;
  }
}

/** Whether the computer is kept awake: while the open book is heard, or a server's books are worked on. */
export function keepsAwake(t: Transcribing): boolean {
  return t.reader.status === "hearing" || t.server.status === "working";
}

/** The open book is being heard: the server's worker gives way to it. */
export function hearing(t: Transcribing): boolean {
  return t.reader.status === "hearing";
}
