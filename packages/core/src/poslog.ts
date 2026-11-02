import type { Position } from "./types";

/**
 * The Ribbon position log (docs/POSITION-FORMAT.md): one append-only
 * NDJSON file per device beside the books, merged by every reader. Pure:
 * text in, records and places out.
 */

export const FORMAT = "ribbon-position-log/1";
export const LOG_EXT = ".ndjson";
/** Logs past this are compacted by their owner. */
export const COMPACT_BYTES = 256 * 1024;
/** A time more than this ahead of the reader's clock is taken as this long ago. */
export const FUTURE_SLACK_MS = 5 * 60_000;

export type Why = "pause" | "seek" | "periodic" | "end" | "close" | "open" | "import" | "remote";

export interface BookRef {
  ids: string[];
  dur_ms?: number;
}

interface Base {
  v: 1;
  dev: string;
  seq: number;
  t: string;
  book: BookRef;
  x?: Record<string, unknown>;
}

export interface Locator {
  href: string;
  type?: string;
  locations?: { fragments?: string[]; progression?: number; totalProgression?: number; position?: number };
  text?: { before?: string; highlight?: string; after?: string };
}

export interface PosRecord extends Base {
  k: "pos";
  ms: number;
  why: Why;
  loc?: Locator;
}

/**
 * A place in a text edition (format 1.1): no `ms`, and a Locator into the
 * text. Readers of 1.0 skip it, and its writer's compaction keeps it.
 */
export interface TextPosRecord extends Base {
  k: "pos";
  ms?: undefined;
  why: Why;
  loc: Locator;
}

export interface ReadRecord extends Base {
  k: "read";
  id: string;
  started: string;
  finished?: string;
}

export interface SessionRecord extends Base {
  k: "session";
  start: string;
  end: string;
  from_ms: number;
  to_ms: number;
  listened_ms: number;
  speed?: number;
}

export interface MarkRecord extends Base {
  k: "mark";
  id: string;
  motivation: string;
  created: string;
  modified?: string;
  /** `ms` is left out of a highlight in a book with no audio (section 3.4). */
  target: { ms?: number; selector?: unknown; text?: unknown };
  body?: string;
}

export interface DelRecord extends Base {
  k: "del";
  of: string;
}

export type LogRecord = PosRecord | TextPosRecord | ReadRecord | SessionRecord | MarkRecord | DelRecord;

export interface DeviceInfo {
  id: string;
  name: string;
  app?: string;
  format?: string;
}

/** Ribbon's own claim for a book id. */
export function ribbonClaim(bookId: string): string {
  return `urn:ribbon:${bookId}`;
}

/** Ribbon's own claim for a book's text edition, the EPUB beside it. */
export function textClaim(bookId: string): string {
  return `urn:ribbon:${bookId}-text`;
}

/** Every claim for a book's text edition: Ribbon's, and the EPUB's own ISBN and uuid. Never the audiobook's: a claim names an edition. */
export function textClaimsFor(bookId: string, identifiers: readonly { scheme: string; value: string }[]): string[] {
  const ids = [textClaim(bookId)];
  for (const i of identifiers) {
    if (i.scheme === "isbn") ids.push(`urn:isbn:${i.value}`);
    if (i.scheme === "uuid") ids.push(`urn:uuid:${i.value}`);
  }
  return [...new Set(ids)];
}

/** Every claim Ribbon knows for a book. */
export function claimsFor(book: { id: string; isbn?: string | undefined; asin?: string | undefined }): string[] {
  const ids = [ribbonClaim(book.id)];
  if (book.isbn) ids.push(`urn:isbn:${book.isbn}`);
  if (book.asin) ids.push(`urn:asin:${book.asin}`);
  return ids;
}

export function encodeRecord(r: LogRecord | Record<string, unknown>): string {
  return `${JSON.stringify(r)}\n`;
}

/**
 * Every record in a log that parses and has the fields its kind needs.
 * Anything else (a cut-off last line, a newer kind) is counted, kept raw
 * for the owner's compaction, and otherwise ignored.
 */
export function parseLog(text: string): { records: LogRecord[]; raw: Record<string, unknown>[]; skipped: number } {
  const records: LogRecord[] = [];
  const raw: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    let o: unknown;
    try {
      o = JSON.parse(l);
    } catch {
      skipped++;
      continue;
    }
    if (!o || typeof o !== "object") {
      skipped++;
      continue;
    }
    const r = o as Record<string, unknown>;
    raw.push(r);
    if (isRecord(r)) records.push(r);
    else skipped++;
  }
  return { records, raw, skipped };
}

function isRecord(r: Record<string, unknown>): r is LogRecord & Record<string, unknown> {
  if (r.v !== 1 || typeof r.dev !== "string" || typeof r.seq !== "number" || typeof r.t !== "string" || Number.isNaN(Date.parse(r.t))) return false;
  const book = r.book as BookRef | undefined;
  if (!book || !Array.isArray(book.ids) || !book.ids.every((x) => typeof x === "string")) return false;
  switch (r.k) {
    case "pos":
      if (typeof r.why !== "string") return false;
      if (r.ms === undefined) return isLocator(r.loc);
      return typeof r.ms === "number" && Number.isFinite(r.ms);
    case "read":
      return typeof r.id === "string" && typeof r.started === "string";
    case "session":
      return typeof r.start === "string" && typeof r.end === "string" && typeof r.listened_ms === "number";
    case "mark":
      return typeof r.id === "string" && typeof r.target === "object" && r.target !== null;
    case "del":
      return typeof r.of === "string";
    default:
      return false;
  }
}

function isLocator(l: unknown): l is Locator {
  return typeof l === "object" && l !== null && typeof (l as Locator).href === "string";
}

/** True for a place in a text edition rather than a time in an audiobook. */
export function isTextPos(r: LogRecord): r is TextPosRecord {
  return r.k === "pos" && r.ms === undefined;
}

/** A legacy per-book CSV position, read as a `pos` record of a device of its own. */
export function fromLegacy(p: Position, file: string): PosRecord {
  return { v: 1, k: "pos", dev: `legacy:${p.device || "unknown"}:${file}`, seq: 0, t: p.updatedAt, book: { ids: [ribbonClaim(p.bookId)] }, ms: p.offsetMs, why: "import" };
}

/** A fresh start: written before the listener did anything, at the very beginning. */
function weak(r: PosRecord): boolean {
  return r.ms <= 0 && (r.why === "open" || r.why === "periodic" || r.why === "import");
}

/**
 * When a record counts as written. A time from the future means a clock
 * that runs fast; counting it as a little in the past lets it beat old
 * records but never anything written lately by a clock that is right.
 */
function effectiveTime(r: Base, nowMs: number): number {
  const t = Date.parse(r.t);
  return t > nowMs + FUTURE_SLACK_MS ? nowMs - FUTURE_SLACK_MS : t;
}

/**
 * The place, from every `pos` record about one book (section 5): each
 * device's latest by its own sequence, then the latest across devices by
 * time (a time from the future counted as five minutes ago, ties to the
 * greater device), and a fresh start never beats real progress.
 */
export function mergePlace(records: readonly PosRecord[], nowMs = Date.now()): PosRecord | null {
  return latestPlace(records, weak, nowMs);
}

/** The merge of section 5, for any kind of place: `isWeak` says which records are fresh starts. */
function latestPlace<T extends Base>(records: readonly T[], isWeak: (r: T) => boolean, nowMs: number): T | null {
  const latest = new Map<string, T>();
  for (const r of records) {
    const have = latest.get(r.dev);
    if (!have || r.seq > have.seq || (r.seq === have.seq && Date.parse(r.t) > Date.parse(have.t))) latest.set(r.dev, r);
  }
  const better = (a: T, b: T) => {
    const ta = effectiveTime(a, nowMs);
    const tb = effectiveTime(b, nowMs);
    if (ta !== tb) return ta > tb;
    return a.dev > b.dev;
  };
  let best: T | null = null;
  let bestStrong: T | null = null;
  for (const r of latest.values()) {
    if (!best || better(r, best)) best = r;
    if (!isWeak(r) && (!bestStrong || better(r, bestStrong))) bestStrong = r;
  }
  return bestStrong ?? best;
}

/** A text place written before the reader did anything, at the very start. */
function weakText(r: TextPosRecord): boolean {
  return (r.loc.locations?.totalProgression ?? 0) <= 0 && (r.why === "open" || r.why === "periodic" || r.why === "import");
}

/**
 * The reading place in each book's text edition, merged across devices
 * the same way as listening places, keyed by Ribbon book id. Audio
 * records never take part: they are another edition.
 */
export function mergeTextPlaces(records: readonly LogRecord[], nowMs = Date.now()): Map<string, TextPosRecord> {
  const byBook = new Map<string, TextPosRecord[]>();
  for (const r of records) {
    if (!isTextPos(r)) continue;
    for (const id of r.book.ids) {
      const m = /^urn:ribbon:(.+)-text$/.exec(id);
      if (!m) continue;
      const list = byBook.get(m[1]!) ?? [];
      list.push(r);
      byBook.set(m[1]!, list);
    }
  }
  const out = new Map<string, TextPosRecord>();
  for (const [id, list] of byBook) {
    const place = latestPlace(list, weakText, nowMs);
    if (place) out.set(id, place);
  }
  return out;
}

/**
 * Group `pos` records by book through their claims (any shared claim is
 * the same book) and merge each group. Keys are Ribbon book ids, for
 * groups that carry one.
 */
export function mergePlaces(records: readonly LogRecord[], nowMs = Date.now()): Map<string, PosRecord> {
  const pos = records.filter((r): r is PosRecord => r.k === "pos" && typeof r.ms === "number");
  // Union-find over claims.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(x, p);
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of pos) for (let i = 1; i < r.book.ids.length; i++) union(r.book.ids[0]!, r.book.ids[i]!);
  const groups = new Map<string, PosRecord[]>();
  for (const r of pos) {
    if (r.book.ids.length === 0) continue;
    const root = find(r.book.ids[0]!);
    const g = groups.get(root) ?? [];
    g.push(r);
    groups.set(root, g);
  }
  const out = new Map<string, PosRecord>();
  for (const g of groups.values()) {
    const place = mergePlace(g, nowMs);
    if (!place) continue;
    const ribbonIds = new Set(g.flatMap((r) => r.book.ids.filter((id) => id.startsWith("urn:ribbon:")).map((id) => id.slice(11))));
    for (const id of ribbonIds) out.set(id, place);
  }
  return out;
}

/** A merged place as the app's Position. */
export function toPosition(bookId: string, r: PosRecord, deviceNames: ReadonlyMap<string, string> = new Map()): Position {
  const device = r.dev.startsWith("legacy:") ? r.dev.split(":")[1] ?? "" : (deviceNames.get(r.dev) ?? r.dev);
  return { bookId, offsetMs: Math.max(0, Math.round(r.ms)), updatedAt: new Date(Date.parse(r.t)).toISOString(), device };
}

/** The later of two records: within one device by its sequence, across devices by time, then by device. */
function newer(a: Base, b: Base, nowMs: number): boolean {
  if (a.dev === b.dev) return a.seq > b.seq;
  const ta = effectiveTime(a, nowMs);
  const tb = effectiveTime(b, nowMs);
  return ta !== tb ? ta > tb : a.dev > b.dev;
}

/**
 * Reads and marks as of now: the union of every device's records, the
 * latest per id, minus what a later `del` took back.
 */
export function mergeById<T extends ReadRecord | MarkRecord>(records: readonly LogRecord[], kind: T["k"], nowMs = Date.now()): T[] {
  const byId = new Map<string, T>();
  const dels = new Map<string, number>();
  for (const r of records) {
    if (r.k === "del") dels.set(r.of, Math.max(dels.get(r.of) ?? 0, effectiveTime(r, nowMs)));
    if (r.k !== kind) continue;
    const rr = r as T;
    const have = byId.get(rr.id);
    if (!have || newer(rr, have, nowMs)) byId.set(rr.id, rr);
  }
  return [...byId.values()].filter((r) => (dels.get(r.id) ?? -Infinity) < effectiveTime(r, nowMs));
}

/**
 * The owner's log, smaller: only the latest `pos` per book stays; every
 * other record, and anything this version does not understand, is kept
 * in its original order.
 */
export function compact(raw: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const lastPos = new Map<string, number>();
  raw.forEach((r, i) => {
    if (r.k !== "pos") return;
    const ids = (r.book as BookRef | undefined)?.ids ?? [];
    const key = [...ids].sort().join("|");
    lastPos.set(key, i);
  });
  const keep = new Set(lastPos.values());
  return raw.filter((r, i) => r.k !== "pos" || keep.has(i));
}

/** A sequence that only increases: milliseconds since the epoch, bumped past the last one. */
export function nextSeq(last: number, nowMs = Date.now()): number {
  return Math.max(last + 1, Math.floor(nowMs));
}

/** The log's file name for a device. */
export function logName(deviceId: string): string {
  return `${deviceId.replace(/^urn:uuid:/, "")}${LOG_EXT}`;
}

export function deviceFileName(deviceId: string): string {
  return `${deviceId.replace(/^urn:uuid:/, "")}.json`;
}

/**
 * Where a book offset falls in its files, as a Readium Locator: the file,
 * a Media Fragment in it, and the progressions.
 */
export function locatorFor(files: readonly { path: string; durationMs: number }[], ms: number, durationMs: number): Locator | undefined {
  let start = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const end = start + Math.max(0, f.durationMs);
    if (ms < end || i === files.length - 1) {
      const inFile = Math.max(0, Math.min(f.durationMs, ms - start));
      const loc: Locator = {
        href: f.path,
        locations: {
          fragments: [`t=${(inFile / 1000).toFixed(2)}`],
          progression: f.durationMs > 0 ? round(inFile / f.durationMs) : 0,
          totalProgression: durationMs > 0 ? round(ms / durationMs) : 0,
          position: i + 1,
        },
      };
      const type = mediaType(f.path);
      if (type) loc.type = type;
      return loc;
    }
    start = end;
  }
  return undefined;
}

function round(x: number): number {
  return Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000;
}

function mediaType(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return { mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", wma: "audio/x-ms-wma" }[ext];
}
