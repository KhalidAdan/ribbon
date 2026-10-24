import type { ReadRecord, SessionRecord, LogRecord } from "./poslog";

/**
 * Listening history from the position log: listen-throughs (reads) and
 * sessions, turned into what a person wants to know. Pure; days are
 * local days, given by the caller's time zone offset.
 */

const DAY = 86_400_000;

/** The Ribbon book id a record is about, if it names one. */
export function bookIdOf(r: LogRecord): string | null {
  const claim = r.book.ids.find((id) => id.startsWith("urn:ribbon:"));
  return claim ? claim.slice(11) : null;
}

const indexes = new WeakMap<readonly ReadRecord[], Map<string, ReadRecord[]>>();

/** A book's listen-throughs, oldest first. Indexed once per list of reads, so a shelf of a thousand books asks cheaply. */
export function readsOf(reads: readonly ReadRecord[], bookId: string): ReadRecord[] {
  let index = indexes.get(reads);
  if (!index) {
    index = new Map();
    for (const r of reads) {
      const id = bookIdOf(r);
      if (!id) continue;
      const list = index.get(id) ?? [];
      list.push(r);
      index.set(id, list);
    }
    for (const list of index.values()) list.sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
    indexes.set(reads, index);
  }
  return index.get(bookId) ?? [];
}

/** The listen-through in progress, if any: the latest one with no finish. */
export function openRead(reads: readonly ReadRecord[], bookId: string): ReadRecord | null {
  const list = readsOf(reads, bookId);
  const last = list[list.length - 1];
  return last && !last.finished ? last : null;
}

/** True when the latest listen-through was finished. */
export function finishedByRead(reads: readonly ReadRecord[], bookId: string): boolean {
  const list = readsOf(reads, bookId);
  const last = list[list.length - 1];
  return !!last?.finished;
}

/** How one listen-through of a book went, as the end of the book tells it. */
export interface ListenThrough {
  started: string;
  /** Null while it's still going. */
  finished: string | null;
  /** Wall-clock time spent listening in it, on every device, at whatever speed (`listened_ms`). */
  listenedMs: number;
}

/**
 * A listen-through, and the time spent in it: the book's sessions that ran
 * while it was open. A session that began a moment before the listen-through
 * did still counts, since an app opens the listen-through as playing starts.
 */
export function listenThrough(read: Pick<ReadRecord, "started" | "finished">, sessions: readonly SessionRecord[], bookId: string): ListenThrough {
  const from = Date.parse(read.started);
  const to = read.finished ? Date.parse(read.finished) : Infinity;
  let listenedMs = 0;
  for (const s of sessions) {
    if (bookIdOf(s) !== bookId) continue;
    if (Date.parse(s.end) > from && Date.parse(s.start) <= to) listenedMs += Math.max(0, s.listened_ms);
  }
  return { started: read.started, finished: read.finished ?? null, listenedMs };
}

/** The local day a moment falls on, as a number of days since the epoch. */
export function dayOf(ms: number, tzOffsetMin: number): number {
  return Math.floor((ms - tzOffsetMin * 60_000) / DAY);
}

export interface Totals {
  todayMs: number;
  weekMs: number;
  /** Over the last 30 days, per day. */
  dailyAverageMs: number;
  /** Consecutive days with any listening, ending today or yesterday. */
  streakDays: number;
  longestStreakDays: number;
  finishedThisYear: number;
  totalMs: number;
  sessions: number;
}

/** Listening time per local day. */
export function minutesByDay(sessions: readonly SessionRecord[], tzOffsetMin: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of sessions) {
    const d = dayOf(Date.parse(s.start), tzOffsetMin);
    out.set(d, (out.get(d) ?? 0) + Math.max(0, s.listened_ms));
  }
  return out;
}

export function totals(sessions: readonly SessionRecord[], reads: readonly ReadRecord[], nowMs: number, tzOffsetMin: number): Totals {
  const byDay = minutesByDay(sessions, tzOffsetMin);
  const today = dayOf(nowMs, tzOffsetMin);
  const sumDays = (from: number, to: number) => {
    let s = 0;
    for (let d = from; d <= to; d++) s += byDay.get(d) ?? 0;
    return s;
  };
  // A streak may end yesterday: today is not over yet.
  let streak = 0;
  for (let d = byDay.has(today) ? today : today - 1; byDay.has(d); d--) streak++;
  let longest = 0;
  let run = 0;
  const days = [...byDay.keys()].sort((a, b) => a - b);
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1]! + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const year = new Date(nowMs - tzOffsetMin * 60_000).getUTCFullYear();
  const finishedThisYear = reads.filter((r) => r.finished && new Date(Date.parse(r.finished) - tzOffsetMin * 60_000).getUTCFullYear() === year).length;
  return {
    todayMs: byDay.get(today) ?? 0,
    weekMs: sumDays(today - 6, today),
    dailyAverageMs: sumDays(today - 29, today) / 30,
    streakDays: streak,
    longestStreakDays: longest,
    finishedThisYear,
    totalMs: sessions.reduce((s, x) => s + Math.max(0, x.listened_ms), 0),
    sessions: sessions.length,
  };
}

/** Time listened per key (a book, an author, a narrator), most first. */
export function timeBy(sessions: readonly SessionRecord[], keyOf: (bookId: string) => string[]): { key: string; ms: number }[] {
  const out = new Map<string, number>();
  for (const s of sessions) {
    const id = bookIdOf(s);
    if (!id) continue;
    for (const k of keyOf(id)) if (k) out.set(k, (out.get(k) ?? 0) + Math.max(0, s.listened_ms));
  }
  return [...out.entries()].map(([key, ms]) => ({ key, ms })).sort((a, b) => b.ms - a.ms);
}

export interface HeatDay {
  day: number;
  ms: number;
  /** 0 to 4. */
  level: number;
}

/**
 * The last year as weeks of days, Monday first, ending this week, with a
 * level from 0 (nothing) to 4 (a long day) relative to the busiest days.
 */
export function heatmap(sessions: readonly SessionRecord[], nowMs: number, tzOffsetMin: number, weeks = 53): HeatDay[][] {
  const byDay = minutesByDay(sessions, tzOffsetMin);
  const today = dayOf(nowMs, tzOffsetMin);
  // 1970-01-01 was a Thursday: day 0 is weekday 3 counting Monday as 0.
  const weekday = (d: number) => (((d + 3) % 7) + 7) % 7;
  const lastMonday = today - weekday(today);
  const first = lastMonday - (weeks - 1) * 7;
  const values = [...byDay.entries()].filter(([d]) => d >= first && d <= today).map(([, v]) => v).sort((a, b) => a - b);
  const p90 = values.length > 0 ? values[Math.floor(values.length * 0.9)] ?? values[values.length - 1]! : 0;
  const level = (ms: number) => (ms <= 0 ? 0 : p90 <= 0 ? 4 : Math.max(1, Math.min(4, Math.ceil((ms / p90) * 4))));
  const out: HeatDay[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatDay[] = [];
    for (let i = 0; i < 7; i++) {
      const day = first + w * 7 + i;
      if (day > today) break;
      const ms = byDay.get(day) ?? 0;
      col.push({ day, ms, level: level(ms) });
    }
    out.push(col);
  }
  return out;
}

/** Hours and minutes, for stats: "6h 12m", "41m", "0m". */
export function formatSpan(ms: number): string {
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
