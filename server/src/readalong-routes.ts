import type { FastifyInstance, FastifyReply } from "fastify";
import { nowIso } from "../../src/core/position.ts";
import { claimsFor, mergeById, mergePlaces, mergeTextPlaces, nextSeq, parseLog, type ReadRecord, type Why } from "../../src/core/poslog.ts";
import { standingOf } from "../../src/core/progress.ts";
import { readsOf } from "../../src/core/stats.ts";
import { nthSentence, sentenceAt, sentenceReadAt } from "../../src/core/reading/readalong.ts";
import { localIdOf } from "../../src/core/server-books.ts";
import { signedIn, type Auth } from "./auth.ts";
import type { Events } from "./events.ts";
import { sendRevalidated, storedBook } from "./library/api.ts";
import type { BookIndex, ListedBook, StoredBook } from "./library/books.ts";
import type { Mp3Frames } from "./library/frames.ts";
import { ReadAlongError, type MadeReadAlong, type ReadAlongs } from "./library/readalong.ts";
import { PlacesError, type Places } from "./places.ts";

/** Why a device that only draws and plays says it's at a moment: what any app writes, but `remote` and `import`, which it never does. */
const WHYS: readonly Why[] = ["open", "pause", "seek", "periodic", "end", "close"];

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
 * - `GET /api/progress`: how far the person is through each book, for a
 *   library that keeps no log either: where they are, when, and whether
 *   it's finished, as the apps' shelves work it out (src/core/progress.ts).
 *   Never cached, and never in the library answer, which stays the same
 *   while people listen.
 */
export function readAlongRoutes(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; places: Places; events: Events; readAlongs: ReadAlongs; frames: Mp3Frames; dataDir: string }): void {
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

  app.post<{ Params: { id: string }; Body: { device?: { id?: unknown; name?: unknown; app?: unknown }; ms?: unknown; why?: unknown } }>("/api/books/:id/place", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const { device, ms, why } = request.body ?? {};
    if (!device || typeof device.id !== "string" || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || !WHYS.includes(why as Why)) {
      return reply.code(400).send({ error: "Send the device ({ id, name }), the moment (ms) and why (pause, seek, periodic, …)." });
    }
    const listed = deps.books.get(request.params.id);
    const stored = listed && (await storedBook(deps, request.params.id));
    if (!listed || !stored) return reply.code(404).send({ error: "No such book on this server." });
    const now = Date.now();
    const durationMs = stored.book.durationMs;
    const record = {
      v: 1,
      k: "pos",
      dev: device.id,
      seq: nextSeq(deps.places.lastSeq(me.id, device.id), now),
      t: nowIso(now),
      book: { ids: claimsFor({ id: localIdOf(listed), isbn: stored.book.isbn, asin: stored.book.asin }), dur_ms: durationMs },
      why,
      ms: Math.round(Math.min(ms, durationMs)),
    };
    try {
      const done = deps.places.append(me.id, { id: device.id, name: typeof device.name === "string" ? device.name : "", ...(typeof device.app === "string" ? { app: device.app } : {}) }, [record]);
      if (done.added > 0) deps.events.toPerson(me.id, { type: "places", data: { device: device.id } });
      return { added: done.added };
    } catch (e) {
      if (e instanceof PlacesError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
}
