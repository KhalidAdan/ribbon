import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { nowIso } from "@ribbon/core/position";
import { bookmarksOf, highlightId, highlightsOf, markFields, markId } from "@ribbon/core/bookmarks";
import { claimsFor, mergeById, mergePlaces, mergeTextPlaces, nextSeq, parseLog, ribbonClaim, textClaimsFor, type DeviceInfo, type LogRecord, type MarkRecord, type ReadRecord, type SessionRecord, type Why } from "@ribbon/core/poslog";
import { readingStandingOf, standingOf } from "@ribbon/core/progress";
import { lastSpeed } from "@ribbon/core/settings";
import { splitPeople } from "@ribbon/core/scan/sidefiles";
import { bookIdOf, endOf, heatmap, listenThrough, readsOf, timeBy, totals } from "@ribbon/core/stats";
import type { BookText } from "@ribbon/core/reading/booktext";
import { highlightOf, placeAfter, trimRange } from "@ribbon/core/reading/highlights";
import { nthSentence, sentenceAt, sentenceReadAt, sentencesIn, sentencesRange } from "@ribbon/core/reading/readalong";
import { indexBooks, searchBooks } from "@ribbon/core/search";
import { localIdOf } from "@ribbon/core/server-books";
import type { Bookmark, Highlight } from "@ribbon/core/types";
import { signedIn, type Auth } from "./auth.ts";
import type { Events } from "./events.ts";
import { sendRevalidated, storedBook } from "./library/api.ts";
import type { BookIndex, ListedBook, StoredBook } from "./library/books.ts";
import type { Mp3Frames } from "./library/frames.ts";
import { ReadAlongError, type MadeReadAlong, type ReadAlongs } from "./library/readalong.ts";
import type { SearchIndex } from "./library/search.ts";
import { PlacesError, type Places } from "./places.ts";

/** Why a device that only draws and plays says it's at a moment: what any app writes, but `remote` and `import`, which it never does. */
const WHYS: readonly Why[] = ["open", "pause", "seek", "periodic", "end", "close"];

/** A stretch of listening shorter than this is no session, as the desktop keeps them (packages/desktop/src/app/controller.ts, `endListening`). */
const SESSION_MIN_MS = 30_000;

/** At most this many books come back from a search, best first. */
const BOOKS_FOUND = 20;

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
 *   sentence is read (packages/core/src/reading/readalong.ts). Revalidated by ETag,
 *   like the library: it changes only when the book's records do.
 * - `GET /api/books/:id/place`: where the person is in the book: the newest
 *   of their listening and reading places, from all their devices, as a
 *   sentence and a moment. Never cached.
 * - `POST /api/books/:id/place`: this device is at this moment of the
 *   recording, or reading at this sentence of the read-along. Written into
 *   the device's position log as any app writes it (docs/POSITION-FORMAT.md):
 *   a moment as a listening place, with the claims the apps give the book; a
 *   sentence as a reading place in the book's text, where the desktop's
 *   reader writes one, so the other devices find it and the device needs no
 *   log of its own.
 * - `GET`, `POST /api/books/:id/bookmarks`, `PUT` and `DELETE …/bookmarks/:mark`:
 *   the person's bookmarks in the book, from every device; bookmarking whole
 *   sentences, as the desktop bookmarks words selected in its reader (the same
 *   `mark`, so it's one of the audiobook's bookmarks too), or a moment of the
 *   recording, as the desktop's player bookmarks one, either with a note;
 *   changing a bookmark's note; and taking one back.
 * - `GET /api/bookmarks`: the person's bookmarks in every book, newest
 *   first, with each book's title: for the TV's screen of passages that
 *   drift by while it's paused.
 * - `POST /api/books/:id/listened`: a stretch of listening, as the desktop
 *   keeps one: it opens a listen-through when none is open, and a new one
 *   whenever the person chose to start again (the desktop's Listen again and
 *   Start again from the beginning), and is kept as a session unless the
 *   person turned sessions off on that device (docs/POSITION-FORMAT.md,
 *   sections 3.2 and 3.3).
 * - `POST /api/books/:id/finished`: the book played to its end, or the person
 *   marked it finished. The listen-through closes, as the desktop closes one,
 *   and the answer says how it went: when it started and finished, and the
 *   time spent in it on every device (packages/core/src/stats.ts,
 *   `listenThrough`).
 * - `POST /api/books/:id/unfinished`: not finished after all. The latest
 *   listen-through opens again, as the desktop's Mark as not finished opens it.
 * - `GET /api/stats?tz=`: what the person has been listening to, counted as
 *   the desktop's Stats counts it (packages/core/src/stats.ts): this week, a
 *   day lately, the streak and the books finished this year; each day of the
 *   last year; the books, authors and narrators listened to most; and the
 *   books finished lately. Days are the device's own, by its offset from UTC
 *   in minutes (`tz`, as JavaScript's `getTimezoneOffset` gives it).
 * - `GET /api/books/:id/listens`: every listen-through of the book, oldest
 *   first, each with how it ended and the time spent in it, as the desktop's
 *   book page lists them (packages/desktop/src/ui/ReadHistory.tsx).
 * - `GET /api/search?q=&book=`: the sentences that best match words someone
 *   remembers, or says, in one book or every one, each named by its book and
 *   its sentence of the read-along, so a device can go straight to it. In
 *   every book, the books whose details have every word come back too, as the
 *   desktop's shelf finds them (packages/core/src/search.ts), so a title, an
 *   author or a narrator said to the TV finds the book, not only lines that
 *   share its words.
 * - `GET /api/progress`: how far the person is through each book, for a
 *   library that keeps no log either: where they are, when, and whether
 *   it's finished, as the apps' shelves work it out (packages/core/src/progress.ts);
 *   for a book that is only its text, how far through its text (`fraction`);
 *   and the speed it was last heard at, on any device, and when (`speed`,
 *   `speedAt`), so a device opens it at that unless it chose one since.
 *   Never cached, and never in the library answer, which stays the same
 *   while people listen.
 */
export function readAlongRoutes(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; places: Places; events: Events; readAlongs: ReadAlongs; search: SearchIndex; frames: Mp3Frames; dataDir: string }): void {
  /** The book and its read-along, or the answer that says why there's none. */
  const readAlongOf = async (id: string, reply: FastifyReply): Promise<{ listed: ListedBook; stored: StoredBook; made: MadeReadAlong } | null> => {
    const listed = deps.books.get(id);
    const stored = listed && (await storedBook(deps, id));
    if (!listed || !stored) return (await reply.code(404).send({ error: "No such book on this server." }), null);
    // A device that streams plays an MP3 from a moment only as the server sends it from there; without that it would be out of step with the text.
    if (stored.files.some((f) => /\.mp3$/i.test(f.path)) && !deps.frames.available) {
      return (await reply.code(503).send({ error: "This server can't send an MP3 from a moment: the ribbon-frames command isn't installed (packages/server/README.md)." }), null);
    }
    try {
      const made = await deps.readAlongs.of(id, stored);
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
    const reading = mergeTextPlaces(records);
    const reads = mergeById<ReadRecord>(records, "read");
    const sessions = records.filter((r): r is SessionRecord => r.k === "session");
    const books: Record<string, { ms: number; at: string; started: boolean; finished: boolean; fraction?: number; speed?: number; speedAt?: string }> = {};
    for (const listed of deps.books.list()) {
      const id = localIdOf(listed);
      const theirs = readsOf(reads, id);
      if (!listed.audio) {
        // Only its text: as far as its reading place, as the desktop's shelf has it.
        const read = reading.get(id);
        if (!read && theirs.length === 0) continue;
        books[listed.id] = { ms: 0, at: read?.t ?? theirs.at(-1)!.started, ...readingStandingOf(read?.loc.locations?.totalProgression ?? 0, theirs) };
        continue;
      }
      const place = places.get(id);
      if (!place && theirs.length === 0) continue;
      const ms = place?.ms ?? 0;
      // The speed it was last heard at, on any device, and when: a device opens it at that unless it chose one since.
      const heard = lastSpeed(sessions, id);
      books[listed.id] = { ms, at: place?.t ?? theirs.at(-1)!.started, ...standingOf(ms, listed.durationMs, theirs), ...(heard ? { speed: heard.speed, speedAt: heard.at } : {}) };
    }
    return { books };
  });

  app.get<{ Querystring: { q?: string; book?: string } }>("/api/search", async (request, reply) => {
    if (!(await signedIn(deps.auth, request))) return reply.code(401).send({ error: "Sign in first." });
    const { q = "", book } = request.query;
    if (book && !deps.books.has(book)) return reply.code(404).send({ error: "No such book on this server." });
    reply.header("cache-control", "no-store");
    // The index of the books' details is made for each search: a few milliseconds for a few hundred books.
    const books = book ? [] : await searchBooks(await indexBooks(deps.books.list().map((listed) => ({ book: listed, parts: [] }))), q, BOOKS_FOUND);
    return { results: deps.search.search(q, book ? { book } : {}), books };
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
    return { place };
  });

  app.post<{ Params: { id: string }; Body: { device?: DeviceBody; ms?: unknown; sentence?: unknown; why?: unknown } }>("/api/books/:id/place", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const { device, ms, sentence, why } = request.body ?? {};
    const who = deviceOf(device);
    if (who && sentence !== undefined && WHYS.includes(why as Why)) {
      if (!Number.isInteger(sentence) || (sentence as number) < 0) return reply.code(400).send({ error: "Send the sentence, counted across the read-along." });
      const book = await readAlongOf(request.params.id, reply);
      if (!book) return reply;
      const { readAlong, text } = book.made;
      const range = sentencesRange(text, sentence as number, sentence as number);
      if (!range) return reply.code(400).send({ error: "That sentence isn't in this book's read-along." });
      // A reading place, as the desktop's reader writes one (ReadingKeeper): the place in the text, under the claims of
      // the book's text, with where it is in the recording, when there is one, as a hint for players.
      const at = book.listed.audio ? nthSentence(readAlong, sentence as number) : null;
      const hint = at ? { x: { "urn:ribbon:audio": { ms: at.ms, how: at.exact ? "sentence" : "chapter" } } } : {};
      const claims = textClaimsFor(localIdOf(book.listed), text.ebook.meta.identifiers);
      const added = writeAs(reply, me.id, who, claims, { k: "pos", why, loc: text.locator(range.from), ...hint });
      return added === null ? reply : { added };
    }
    if (!who || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || !WHYS.includes(why as Why)) {
      return reply.code(400).send({ error: "Send the device ({ id, name }), the moment (ms) or the sentence, and why (pause, seek, periodic, …)." });
    }
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    const added = write(reply, me.id, who, listed, stored, { k: "pos", why, ms: Math.round(Math.min(ms, stored.book.durationMs)) });
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

  app.post<{ Params: { id: string }; Body: { device?: DeviceBody; first?: unknown; last?: unknown; ms?: unknown; note?: unknown } }>("/api/books/:id/bookmarks", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const { device, first, last, ms, note } = request.body ?? {};
    const who = deviceOf(device);
    if (!who || (note !== undefined && typeof note !== "string")) return reply.code(400).send({ error: "Send the device ({ id, name }), and the note, if there is one, as words." });
    const said = typeof note === "string" ? note.trim() : "";
    if (ms !== undefined) {
      if (!isMoment(ms)) return reply.code(400).send({ error: "Send the moment of the recording (ms)." });
      const listed = deps.books.get(request.params.id);
      const stored = listed && (await storedBook(deps, request.params.id));
      if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
      if (!listed.audio) return reply.code(400).send({ error: "This book has no recording to bookmark a moment of." });
      // The bookmark the desktop's player makes (docs/POSITION-FORMAT.md, section 3.4), named by its book and moment as
      // the desktop names it, so the same moment bookmarked twice is one bookmark. A device that only plays keeps no clip.
      const bookId = localIdOf(listed);
      const at = Math.round(Math.min(ms as number, stored.book.durationMs));
      const bookmark: Bookmark = { id: markId(bookId, at), bookId, offsetMs: at, createdAt: nowIso(Date.now()), note: said, clip: "" };
      const added = write(reply, me.id, who, listed, stored, markFields(bookmark));
      return added === null ? reply : { bookmark: shownBookmark(bookmark, null) };
    }
    if (!Number.isInteger(first) || !Number.isInteger(last) || (first as number) < 0 || (last as number) < (first as number)) {
      return reply.code(400).send({ error: "Send the device ({ id, name }) and the sentences, first and last, counted across the read-along, or a moment (ms)." });
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
    const offsetMs = book.listed.audio ? (nthSentence(readAlong, first as number)?.ms ?? null) : null;
    const highlight: Highlight = { id: highlightId(bookId, words.start, words.quote), bookId, offsetMs, createdAt: nowIso(Date.now()), note: said, clip: "", text: words };
    const added = write(reply, me.id, who, book.listed, book.stored, markFields(highlight));
    return added === null ? reply : { bookmark: shownBookmark(highlight, text) };
  });

  app.put<{ Params: { id: string; mark: string }; Body: { device?: DeviceBody; note?: unknown } }>("/api/books/:id/bookmarks/:mark", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const who = deviceOf(request.body?.device);
    const note = request.body?.note;
    if (!who || typeof note !== "string") return reply.code(400).send({ error: "Send the device ({ id, name }) and the note (empty takes it away)." });
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    const found = bookmarksIn(parseLog(deps.places.export(me.id)).records, listed, stored).find((b) => b.id === request.params.mark);
    if (!found) return reply.code(404).send({ error: "No such bookmark in this book." });
    // Written again with its new note, as the desktop changes one (`editBookmark`): the same id, so it's the same bookmark everywhere.
    const changed = { ...found, note: note.trim(), modifiedAt: nowIso(Date.now()) };
    const added = write(reply, me.id, who, listed, stored, markFields(changed));
    if (added === null) return reply;
    const text = changed.text && listed.ebook ? ((await deps.readAlongs.of(listed.id, stored).catch(() => null))?.text ?? null) : null;
    return { bookmark: shownBookmark(changed, text) };
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
    // a new one whenever the person chose to start again, finished or not (`listenAgain`).
    if (!last || again === true) fields.push({ k: "read", id: `urn:uuid:${randomUUID()}`, started: nowIso(began) });
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

  app.post<{ Params: { id: string }; Body: { device?: DeviceBody } }>("/api/books/:id/unfinished", async (request, reply) => {
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
    // The latest listen-through written again without its finish, as the desktop's `markUnfinished` writes it; a book
    // never listened to through gets one that's going.
    const read = { k: "read" as const, id: last?.id ?? `urn:uuid:${randomUUID()}`, started: last?.started ?? nowIso(Date.now()) };
    const added = write(reply, me.id, who, listed, stored, read);
    const sessions = records.filter((r): r is SessionRecord => r.k === "session");
    return added === null ? reply : { read: listenThrough(read, sessions, id) };
  });

  app.get<{ Querystring: { tz?: string } }>("/api/stats", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    reply.header("cache-control", "no-store");
    const tz = Number(request.query.tz ?? 0);
    const now = Date.now();
    const records = parseLog(deps.places.export(me.id)).records;
    const sessions = records.filter((r): r is SessionRecord => r.k === "session");
    const reads = mergeById<ReadRecord>(records, "read");
    // The books on this server by the id the log names them by.
    const byLocal = new Map(deps.books.list().map((b) => [localIdOf(b), b]));
    const people = (field: "author" | "narrator") => timeBy(sessions, (id) => splitPeople(byLocal.get(id)?.[field] ?? "")).slice(0, 6).map(({ key, ms }) => ({ name: key, ms }));
    const finished = reads
      .filter((r) => r.finished && byLocal.has(bookIdOf(r) ?? ""))
      .sort((a, b) => Date.parse(b.finished!) - Date.parse(a.finished!))
      .slice(0, 8)
      .map((r) => ({ book: byLocal.get(bookIdOf(r)!)!.id, finished: r.finished! }));
    return {
      totals: totals(sessions, reads, now, Number.isFinite(tz) ? tz : 0),
      days: heatmap(sessions, now, Number.isFinite(tz) ? tz : 0).map((week) => week.map((d) => d.level)),
      books: timeBy(sessions, (id) => [id]).flatMap(({ key, ms }) => (byLocal.has(key) ? [{ book: byLocal.get(key)!.id, ms }] : [])).slice(0, 6),
      authors: people("author"),
      narrators: people("narrator"),
      finished,
      finishedInAll: reads.filter((r) => r.finished).length,
    };
  });

  app.get<{ Params: { id: string } }>("/api/books/:id/listens", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const listed = deps.books.get(request.params.id);
    if (!listed) return reply.code(404).send({ error: "No such book on this server." });
    reply.header("cache-control", "no-store");
    const id = localIdOf(listed);
    const records = parseLog(deps.places.export(me.id)).records;
    const reads = readsOf(mergeById<ReadRecord>(records, "read"), id);
    const sessions = records.filter((r): r is SessionRecord => r.k === "session");
    return { listens: reads.map((r, i) => ({ ...listenThrough(r, sessions, id), ended: endOf(r, reads[i + 1]) })) };
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
    const book = { ids: claimsFor({ id: localIdOf(listed), isbn: stored.book.isbn, asin: stored.book.asin }), dur_ms: stored.book.durationMs };
    return writeFor(reply, personId, device, book, fields);
  }

  /** The same, for a book's text, under its own claims: a reading place. */
  function writeAs(reply: FastifyReply, personId: string, device: DeviceInfo, claims: string[], ...fields: Record<string, unknown>[]): number | null {
    return writeFor(reply, personId, device, { ids: claims }, fields);
  }

  function writeFor(reply: FastifyReply, personId: string, device: DeviceInfo, book: { ids: string[]; dur_ms?: number }, fields: Record<string, unknown>[]): number | null {
    if (fields.length === 0) return 0;
    const now = Date.now();
    let seq = deps.places.lastSeq(personId, device.id);
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
