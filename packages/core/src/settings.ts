import type { BookSettings } from "./types";
import { bytesToRows, rowsToBytes, num, bool } from "./csv";
import type { SessionRecord } from "./poslog";
import { snapSpeed } from "./speed";
import { bookIdOf } from "./stats";

export const SETTINGS_HEADERS = ["book_id", "speed", "trim_silence", "speed_at"];

export function defaultSettings(bookId: string): BookSettings {
  return { bookId, speed: 1, trimSilence: false };
}

export function serializeSettings(s: BookSettings): Promise<Uint8Array> {
  return rowsToBytes([{ book_id: s.bookId, speed: String(snapSpeed(s.speed)), trim_silence: s.trimSilence ? "1" : "0", speed_at: s.speedAt ?? "" }], SETTINGS_HEADERS);
}

export async function parseSettings(bytes: Uint8Array, bookId: string): Promise<BookSettings> {
  const { rows } = await bytesToRows(bytes);
  const row = rows.find((r) => r.book_id === bookId) ?? rows[0];
  if (!row) return defaultSettings(bookId);
  return { bookId, speed: snapSpeed(num(row.speed, 1)), trimSilence: bool(row.trim_silence), ...(row.speed_at ? { speedAt: row.speed_at } : {}) };
}

/** The speed a book was last listened at, on any device, and when that listening ended: its newest session's. */
export function lastSpeed(sessions: readonly SessionRecord[], bookId: string): { speed: number; at: string } | null {
  let last: SessionRecord | null = null;
  for (const s of sessions) {
    if (typeof s.speed !== "number" || bookIdOf(s) !== bookId) continue;
    if (!last || Date.parse(s.end) > Date.parse(last.end)) last = s;
  }
  return last ? { speed: snapSpeed(last.speed!), at: last.end } : null;
}

/**
 * The speed a book plays at: the one it was last listened at, on any
 * device, unless this device chose one for it since. So the narrator sounds
 * the same in the car as in the kitchen (docs/NORTHSTAR.md, "What success
 * looks like"), and a choice made here holds until the book is heard faster
 * or slower somewhere else.
 */
export function speedToPlay(settings: BookSettings, last: { speed: number; at: string } | null): number {
  if (!last) return settings.speed;
  const chosen = settings.speedAt ? Date.parse(settings.speedAt) : -Infinity;
  return Date.parse(last.at) > chosen ? last.speed : settings.speed;
}
