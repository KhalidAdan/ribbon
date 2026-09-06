import type { BookSettings } from "./types";
import { bytesToRows, rowsToBytes, num } from "./csv";
import { snapSpeed } from "./speed";

export const SETTINGS_HEADERS = ["book_id", "speed"];

export function defaultSettings(bookId: string): BookSettings {
  return { bookId, speed: 1 };
}

export function serializeSettings(s: BookSettings): Promise<Uint8Array> {
  return rowsToBytes([{ book_id: s.bookId, speed: String(snapSpeed(s.speed)) }], SETTINGS_HEADERS);
}

export async function parseSettings(bytes: Uint8Array, bookId: string): Promise<BookSettings> {
  const { rows } = await bytesToRows(bytes);
  const row = rows.find((r) => r.book_id === bookId) ?? rows[0];
  if (!row) return defaultSettings(bookId);
  return { bookId, speed: snapSpeed(num(row.speed, 1)) };
}
