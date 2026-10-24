import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { nowIso } from "../../src/core/position.ts";
import { bookmarksOf, highlightId, highlightsOf, markFields } from "../../src/core/bookmarks.ts";
import { claimsFor, mergeById, mergePlaces, mergeTextPlaces, nextSeq, parseLog, ribbonClaim, type DeviceInfo, type LogRecord, type MarkRecord, type ReadRecord, type SessionRecord, type Why } from "../../src/core/poslog.ts";
import { standingOf } from "../../src/core/progress.ts";
import { bookIdOf, listenThrough, readsOf } from "../../src/core/stats.ts";
import type { BookText } from "../../src/core/reading/booktext.ts";
import { highlightOf, placeAfter, trimRange } from "../../src/core/reading/highlights.ts";
import { nthSentence, sentenceAt, sentenceReadAt, sentencesIn, sentencesRange } from "../../src/core/reading/readalong.ts";
import { localIdOf } from "../../src/core/server-books.ts";
import type { Bookmark, Highlight } from "../../src/core/types.ts";
import { signedIn, type Auth } from "./auth.ts";
import type { Events } from "./events.ts";
import { sendRevalidated, storedBook } from "./library/api.ts";
import type { BookIndex, ListedBook, StoredBook } from "./library/books.ts";
import type { Mp3Frames } from "./library/frames.ts";
import { ReadAlongError, type MadeReadAlong, type ReadAlongs } from "./library/readalong.ts";
import type { SearchIndex } from "./library/search.ts";
import type { Transcriber } from "./library/transcribe.ts";
import { PlacesError, type Places } from "./places.ts";

/** Why a device that only draws and plays says it's at a moment: what any app writes, but `remote` and `import`, which it never does. */
const WHYS: readonly Why[] = ["open", "pause", "seek", "periodic", "end", "close"];

/** A stretch of listening shorter than this is no session, as the desktop keeps them (src/app/controller.ts, `endListening`). */
const SESSION_MIN_MS = 30_000;

/** Where a person is in a book, as a device that only draws and plays is told it. */
export interface BookPlace {
  /** The sentence, counted across the book's read-along. */
  sentence: number;
  /** The moment of the recording: where they stopped listening, or where the sentence they were reading is read. */
  ms: number;
  /** Whether they were last listening or reading. */
  from: "listening" | "reading";
  /** When. */
  at: string;
}

/**
 * Reading a book along with its narration on a device that only draws and
 * plays, and keeps nothing (docs/SERVER.md, section 8: the Apple TV):
 *
 * - `GET /api/books/:id/readalong`: the book's text with when each
 *   sentence is read (src/core/reading/readalong.ts). Revalidated by ETag,
 *   like the library: it changes only when the book's records do.
 * - `GET /api/books/:id/place`: where the person is in the book: the newest
 *   of their listening and reading places, from all their devices, as a
 *   sentence and a moment. Never cached.
 * - `POST /api/books/:id/place`: this device is at this moment of the
 *   recording. Written into the device's position log as any app writes it
 *   (docs/POSITION-FORMAT.md), with the claims the apps give the book, so
 *   the other devices find it and the device needs no log of its own.
 * - `GET`, `POST /api/books/:id/bookmarks` and `DELETE …/bookmarks/:mark`:
 *   the person's bookmarks in the book, from every device; bookmarking whole
 *   sentences, as the desktop bookmarks words selected in its reader (the same
 *   `mark`, so it's one of the audiobook's bookmarks too); and taking one back.
 * - `GET /api/bookmarks`: the person's bookmarks in every book, newest
 *   first, with each book's title: for the TV's screen of passages that
 *   drift by while it's paused.
 * - `POST /api/books/:id/listened`: a stretch of listening, as the desktop
 *   keeps one: it opens a listen-through when none is open (a new one after
 *   a finished one only when the person chose to listen again), and is kept
 *   as a session unless the person turned sessions off on that device
 *   (docs/POSITION-FORMAT.md, sections 3.2 and 3.3).
 * - `POST /api/books/:id/finished`: the book played to its end. The
 *   listen-through closes, as the desktop closes one, and the answer says
 *   how it went: when it started and finished, and the time spent in it on
 *   every device (src/core/stats.ts, `listenThrough`).
 * - `GET /api/search?q=&book=`: the sentences that best match words someone
 *   remembers, or says, in one book or every one, each named by its book and
 *   its sentence of the read-along, so a device can go straight to it.
 * - `GET /api/progress`: how far the person is through each book, for a
 *   library that keeps no log either: where they are, when, and whether
 *   it's finished, as the apps' shelves work it out (src/core/progress.ts).
 *   Never cached, and never in the library answer, which stays the same
 *   while people listen.
 */
export function readAlongRoutes(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; places: Places; events: Events; readAlongs: ReadAlongs; search: SearchIndex; frames: Mp3Frames; transcriber: Transcriber; dataDir: string }): void {
  /** The book and its read-along, or the answer that says why there's none. */
  const readAlongOf = async (id: string, reply: FastifyReply): Promise<{ listed: ListedBook; stored: StoredBook; made: MadeReadAlong } | null> => {
    const listed = deps.books.get(id);
    const stored = listed && (await storedBook(deps, id));
    if (!listed || !stored) return (await reply.code(404).send({ error: "No such book on this server." }), null);
    // A device that streams plays an MP3 from a moment only as the server sends it from there; without that it would be out of step with the text.
    if (stored.files.some((f) => /\.mp3$/i.test(f.path)) && !deps.frames.available) {
      return (await reply.code(503).send({ error: "This server can't send an MP3 from a moment: the ribbon-frames command isn't installed (server/README.md)." }), null);
    }
    try {
      const made = await deps.readAlongs.of(id, stored);
      // Someone is reading it along: its narration is transcribed next, if it isn't yet.
      deps.transcriber.want(id);
      if (made) return { listed, stored, made };
      await reply.code(404).send({ error: "This book has no text and narration to read along." });
    } catch (e) {
      if (!(e instanceof ReadAlongError)) throw e;
      await reply.code(e.status).send({ error: e.message });
    }
    return null;
  };

  app.get("/api/progress", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    reply.header("cache-control", "no-store");
    const records = parseLog(deps.places.export(me.id)).records;
    const places = mergePlaces(records);
    const reads = mergeById<ReadRecord>(records, "read");
    const books: Record<string, { ms: number; at: string; started: boolean; finished: boolean }> = {};
    for (const listed of deps.books.list()) {
      const id = localIdOf(listed);
      const place = places.get(id);
      const theirs = readsOf(reads, id);
      if (!place && theirs.length === 0) continue;
      const ms = place?.ms ?? 0;
      books[listed.id] = { ms, at: place?.t ?? theirs.at(-1)!.started, ...standingOf(ms, listed.durationMs, theirs) };
    }
    return { books };
  });

  app.get<{ Querystring: { q?: string; book?: string } }>("/api/search", async (request, reply) => {
    if (!(await signedIn(deps.auth, request))) return reply.code(401).send({ error: "Sign in first." });
    const { q = "", book } = request.query;
    if (book && !deps.books.has(book)) return reply.code(404).send({ error: "No such book on this server." });
    reply.header("cache-control", "no-store");
    return { results: deps.search.search(q, book ? { book } : {}) };
  });

  app.get<{ Params: { id: string } }>("/api/books/:id/readalong", async (request, reply) => {
    if (!(await signedIn(deps.auth, request))) return reply.code(401).send({ error: "Sign in first." });
    const book = await readAlongOf(request.params.id, reply);
    return book && sendRevalidated(request, reply, book.made.readAlong, book.made.json);
  });

  app.get<{ Params: { id: string } }>("/api/books/:id/place", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const book = await readAlongOf(request.params.id, reply);
    if (!book) return reply;
    reply.header("cache-control", "no-store");
    const { readAlong, text } = book.made;
    // The person's places, merged the way every app merges them, under the id the apps give a server's book.
    const records = parseLog(deps.places.export(me.id)).records;
    const id = localIdOf(book.listed);
    const listening = mergePlaces(records).get(id);
    const reading = mergeTextPlaces(records).get(id);
    let place: BookPlace | null = null;
    if (reading && (!listening || Date.parse(reading.t) > Date.parse(listening.t))) {
      const sentence = sentenceAt(text, text.fromLocator(reading.loc));
      place = { sentence, ms: nthSentence(readAlong, sentence)?.ms ?? 0, from: "reading", at: reading.t };
    } else if (listening) {
      place = { sentence: sentenceReadAt(readAlong, listening.ms), ms: listening.ms, from: "listening", at: listening.t };
    }
    if (place) deps.transcriber.want(book.listed.id, place.ms);
    return { place };
  });

  app.post<{ Params: { id: string }; Body: { device?: DeviceBody; ms?: unknown; why?: unknown } }>("/api/books/:id/place", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const { device, ms, why } = request.body ?? {};
    const who = deviceOf(device);
    if (!who || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || !WHYS.includes(why as Why)) {
      return reply.code(400).send({ error: "Send the device ({ id, name }), the moment (ms) and why (pause, seek, periodic, …)." });
    }
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    const added = write(reply, me.id, who, listed, stored, { k: "pos", why, ms: Math.round(Math.min(ms, stored.book.durationMs)) });
    deps.transcriber.want(listed.id, ms);
    return added === null ? reply : { added };
  });

  app.get<{ Params: { id: string } }>("/api/books/:id/bookmarks", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    reply.header("cache-control", "no-store");
    // Words are shown as the sentences they're in when the book has a read-along; a book without one still has its bookmarks by time.
    const text = listed.ebook ? ((await deps.readAlongs.of(listed.id, stored).catch(() => null))?.text ?? null) : null;
    const bookmarks = bookmarksIn(parseLog(deps.places.export(me.id)).records, listed, stored).map((b) => shownBookmark(b, text));
    bookmarks.sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || (a.ms ?? 0) - (b.ms ?? 0));
    return { bookmarks };
  });

  app.post<{ Params: { id: string }; Body: { device?: DeviceBody; first?: unknown; last?: unknown } }>("/api/books/:id/bookmarks", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const { device, first, last } = request.body ?? {};
    const who = deviceOf(device);
    if (!who || !Number.isInteger(first) || !Number.isInteger(last) || (first as number) < 0 || (last as number) < (first as number)) {
      return reply.code(400).send({ error: "Send the device ({ id, name }) and the sentences, first and last, counted across the read-along." });
    }
    const book = await readAlongOf(request.params.id, reply);
    if (!book) return reply;
    const { readAlong, text } = book.made;
    const sentences = sentencesRange(text, first as number, last as number);
    const range = sentences && trimRange(text, sentences.from, sentences.to);
    if (!range) return reply.code(400).send({ error: "Those sentences aren't in this book's read-along." });
    // The bookmark the desktop makes of words selected in its reader (docs/POSITION-FORMAT.md, section 3.4), with the time the
    // first sentence is read: the same words bookmarked on any device are one bookmark. A device that only plays keeps no clip.
    const bookId = localIdOf(book.listed);
    const words = highlightOf(text, bookId, range);
    const highlight: Highlight = { id: highlightId(bookId, words.start, words.quote), bookId, offsetMs: nthSentence(readAlong, first as number)?.ms ?? null, createdAt: nowIso(Date.now()), note: "", clip: "", text: words };
    const added = write(reply, me.id, who, book.listed, book.stored, markFields(highlight));
    return added === null ? reply : { bookmark: shownBookmark(highlight, text) };
  });

  app.delete<{ Params: { id: string; mark: string }; Body: { device?: DeviceBody } }>("/api/books/:id/bookmarks/:mark", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const who = deviceOf(request.body?.device);
    if (!who) return reply.code(400).send({ error: "Send the device ({ id, name })." });
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    if (!bookmarksIn(parseLog(deps.places.export(me.id)).records, listed, stored).some((b) => b.id === request.params.mark)) return reply.code(404).send({ error: "No such bookmark in this book." });
    // Taken back as every app takes a bookmark back: a `del` of its id (section 3.5).
    const added = write(reply, me.id, who, listed, stored, { k: "del", of: request.params.mark });
    return added === null ? reply : { deleted: request.params.mark };
  });

  app.get("/api/bookmarks", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    reply.header("cache-control", "no-store");
    const records = parseLog(deps.places.export(me.id)).records;
    // Only the books a bookmark names are looked at closely: most books in a library have none.
    const named = new Set(mergeById<MarkRecord>(records, "mark").flatMap((m) => m.book.ids));
    const bookmarks: (ShownBookmark & { book: { id: string; title: string; author: string } })[] = [];
    for (const listed of deps.books.list()) {
      if (!named.has(ribbonClaim(localIdOf(listed)))) continue;
      const stored = await storedBook(deps, listed.id);
      if (!stored) continue;
      // Without the sentences: a read-along is made for a book only when it's opened.
      for (const b of bookmarksIn(records, listed, stored)) bookmarks.push({ ...shownBookmark(b, null), book: { id: listed.id, title: listed.title, author: listed.author } });
    }
    bookmarks.sort((a, b) => b.created.localeCompare(a.created));
    return { bookmarks };
  });

  app.post<{ Params: { id: string }; Body: { device?: DeviceBody; start?: unknown; end?: unknown; fromMs?: unknown; toMs?: unknown; speed?: unknown; again?: unknown; keep?: unknown } }>("/api/books/:id/listened", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const { device, start, end, fromMs, toMs, speed, again, keep } = request.body ?? {};
    const who = deviceOf(device);
    const began = typeof start === "string" ? Date.parse(start) : NaN;
    const ended = typeof end === "string" ? Date.parse(end) : NaN;
    if (!who || !(ended >= began) || !isMoment(fromMs) || !isMoment(toMs) || (speed !== undefined && !(typeof speed === "number" && speed > 0))) {
      return reply.code(400).send({ error: "Send the device ({ id, name }), when the stretch started and ended (start, end) and the moments it ran between (fromMs, toMs)." });
    }
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    const id = localIdOf(listed);
    const last = readsOf(mergeById<ReadRecord>(parseLog(deps.places.export(me.id)).records, "read"), id).at(-1);
    const fields: Record<string, unknown>[] = [];
    // A listen-through opens as the desktop opens one when playing starts (`beginListening`): when none is open, and
    // after a finished one only when the person chose to start again.
    if (!last || (last.finished && again === true)) fields.push({ k: "read", id: `urn:uuid:${randomUUID()}`, started: nowIso(began) });
    if (keep !== false && ended - began >= SESSION_MIN_MS) {
      const durationMs = stored.book.durationMs;
      fields.push({ k: "session", start: nowIso(began), end: nowIso(ended), from_ms: Math.round(Math.min(fromMs as number, durationMs)), to_ms: Math.round(Math.min(toMs as number, durationMs)), listened_ms: ended - began, ...(typeof speed === "number" ? { speed } : {}) });
    }
    const added = write(reply, me.id, who, listed, stored, ...fields);
    return added === null ? reply : { added };
  });

  app.post<{ Params: { id: string }; Body: { device?: DeviceBody } }>("/api/books/:id/finished", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const who = deviceOf(request.body?.device);
    if (!who) return reply.code(400).send({ error: "Send the device ({ id, name })." });
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    const id = localIdOf(listed);
    const records = parseLog(deps.places.export(me.id)).records;
    const last = readsOf(mergeById<ReadRecord>(records, "read"), id).at(-1);
    const sessions = records.filter((r): r is SessionRecord => r.k === "session");
    // Finished already, on another device: it stays as it was.
    if (last?.finished) return { read: listenThrough(last, sessions, id) };
    // The listen-through open closes, as the desktop's `markFinished` closes it. A book listened to before anything opened
    // one started with the first place kept in it.
    const now = nowIso(Date.now());
    const read = { k: "read" as const, id: last?.id ?? `urn:uuid:${randomUUID()}`, started: last?.started ?? firstHeard(records, id) ?? now, finished: now };
    const added = write(reply, me.id, who, listed, stored, read);
    return added === null ? reply : { read: listenThrough(read, sessions, id) };
  });

  /** A person's bookmarks in a book, by time and by words, from every device's log, merged as the apps merge them. */
  function bookmarksIn(records: readonly LogRecord[], listed: ListedBook, stored: StoredBook): (Bookmark | Highlight)[] {
    const id = localIdOf(listed);
    const book = { id, claims: claimsFor({ id, isbn: stored.book.isbn, asin: stored.book.asin }) };
    const byId = new Map<string, Bookmark | Highlight>();
    for (const b of bookmarksOf(records, book, [])) byId.set(b.id, b);
    for (const h of highlightsOf(records, book)) byId.set(h.id, h);
    return [...byId.values()];
  }

  /**
   * Add records to the device's own position log, with the claims the apps
   * give the book, and tell the person's other devices. How many records were
   * new, or null when the answer has already said why they couldn't be kept.
   */
  function write(reply: FastifyReply, personId: string, device: DeviceInfo, listed: ListedBook, stored: StoredBook, ...fields: Record<string, unknown>[]): number | null {
    if (fields.length === 0) return 0;
    const now = Date.now();
    let seq = deps.places.lastSeq(personId, device.id);
    const book = { ids: claimsFor({ id: localIdOf(listed), isbn: stored.book.isbn, asin: stored.book.asin }), dur_ms: stored.book.durationMs };
    const records = fields.map((f) => ({ v: 1, dev: device.id, seq: (seq = nextSeq(seq, now)), t: nowIso(now), book, ...f }));
    try {
      const done = deps.places.append(personId, device, records);
      if (done.added > 0) deps.events.toPerson(personId, { type: "places", data: { device: device.id } });
      return done.added;
    } catch (e) {
      if (!(e instanceof PlacesError)) throw e;
      void reply.code(400).send({ error: e.message });
      return null;
    }
  }
}

/** Who a device says it is, as it sends it. */
interface DeviceBody {
  id?: unknown;
  name?: unknown;
  app?: unknown;
}

function deviceOf(device: DeviceBody | undefined): DeviceInfo | null {
  if (!device || typeof device.id !== "string") return null;
  return { id: device.id, name: typeof device.name === "string" ? device.name : "", ...(typeof device.app === "string" ? { app: device.app } : {}) };
}

/** A bookmark as a device that only draws and plays shows it. */
export interface ShownBookmark {
  id: string;
  /** The moment it marks in the recording; null for words in a book with no audio. */
  ms: number | null;
  note: string;
  created: string;
  /** The words, for a bookmark made of words in the text. */
  quote?: string;
  /** The sentences the words are in, counted across the read-along, when the book has one. */
  first?: number;
  last?: number;
}

/** A bookmark as shown: its words found again in the text as the apps find them (section 3.4), and named by their sentences. */
function shownBookmark(b: Bookmark | Highlight, text: BookText | null): ShownBookmark {
  let sentences: { first: number; last: number } | null = null;
  if (b.text && text) {
    const from = text.fromLocator(b.text.start);
    sentences = sentencesIn(text, { from, to: placeAfter(text, from, b.text.quote) ?? text.fromLocator(b.text.end) });
  }
  return { id: b.id, ms: b.offsetMs, note: b.note, created: b.createdAt, ...(b.text ? { quote: b.text.quote } : {}), ...(sentences ?? {}) };
}

/** A moment of a recording, as a device sends one. */
function isMoment(ms: unknown): boolean {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
}

/**
 * When a book was first listened to since it was last finished: the first
 * place or session kept in it after that. For a listen-through no app opened,
 * as a TV from before it opened them leaves.
 */
function firstHeard(records: readonly LogRecord[], bookId: string): string | null {
  const after = readsOf(mergeById<ReadRecord>(records, "read"), bookId).findLast((r) => r.finished)?.finished;
  let first: string | null = null;
  for (const r of records) {
    if ((r.k !== "pos" && r.k !== "session") || bookIdOf(r) !== bookId) continue;
    const t = r.k === "session" ? r.start : r.t;
    if ((!after || t > after) && (!first || t < first)) first = t;
  }
  return first;
}
