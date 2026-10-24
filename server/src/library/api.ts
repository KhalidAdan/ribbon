import fastifyStatic, { type SendOptions } from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn, type Auth } from "../auth.ts";
import { bookDir, type BookIndex, type StoredBook } from "./books.ts";
import { bytesToRows } from "../../../src/core/csv.ts";
import { servedBook, servedCorrections, servedRecords } from "./chapters.ts";
import { COVER_WIDTHS } from "./covers.ts";
import type { Mp3Frames } from "./frames.ts";
import { HEARD, keepHeard, type HeardKind } from "./records.ts";

/** A cover's file name: its picture's hash and one of the widths it's made at. */
const COVER_NAME = new RegExp(`^([0-9a-f]{16})-(${COVER_WIDTHS.join("|")})\\.jpg$`);

/** Most a device sends of a book's records at once: a 60-hour book's whole transcript is about 5 MB. */
const RECORD_BYTES = 32 * 1024 * 1024;

/** A year: as long as a browser or an app keeps anything. A cover's address changes when its picture does. */
const FOREVER = "private, max-age=31536000, immutable";
/** Kept, but asked about every time: the answer is almost always "nothing changed". */
const ASK_FIRST = "private, no-cache";

/**
 * The library as the apps read it (docs/SERVER.md, sections 7 and 10),
 * for anyone signed in:
 *
 * - `GET /api/books`: every book, with each cover's shape and colour, and
 *   the ids of the books deleted, which a device that downloaded one takes
 *   off (the admin deletes one in routes.ts).
 * - `GET /api/books/:id`: one book in full: its files, chapters and parts,
 *   the chapters as corrected (chapters.ts).
 * - `GET /covers/:hash-:width.jpg`: a cover, at an address that never changes.
 * - `GET /api/books/:id/files/*`: a file of the book, for downloads; an
 *   MP3 with `?ms=` is sent from the frame where that moment falls, for a
 *   player that streams (the TV), which then starts it at its own 0.
 * - `POST /api/books/:id/records/:kind`: what a device heard of the
 *   narration (`heard`, `aligned`), as the CSV it keeps beside the book,
 *   merged into the book's own (records.ts), so every device and the TV
 *   read along with what any of them transcribed.
 *
 * The two JSON answers carry an ETag and are sent "no-cache": a device
 * keeps them and asks again with If-None-Match, and gets a bare 304 when
 * nothing changed. Places are never in them, so they stay the same while
 * people listen. Files carry an ETag and Last-Modified and answer Range
 * and If-Range, so a download that stopped carries on where it was.
 */
export async function libraryApi(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; dataDir: string; frames: Mp3Frames }): Promise<void> {
  // Sends files with Range, ETag and Last-Modified (the `send` module); no routes of its own.
  // Made now, not with the first book: the files plugin wants its folder to exist.
  mkdirSync(path.join(deps.dataDir, "books"), { recursive: true });
  await app.register(fastifyStatic, { root: path.join(deps.dataDir, "books"), serve: false });

  const mustSignIn = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await signedIn(deps.auth, request))) await reply.code(401).send({ error: "Sign in first." });
  };

  app.get("/api/books", { onRequest: mustSignIn }, async (request, reply) => sendRevalidated(request, reply, { books: deps.books.list(), deleted: deps.books.deleted() }));

  app.get<{ Params: { id: string } }>("/api/books/:id", { onRequest: mustSignIn }, async (request, reply) => {
    const stored = await storedBook(deps, request.params.id);
    if (!stored) return reply.code(404).send({ error: "No such book on this server." });
    return sendRevalidated(request, reply, await servedBook(bookDir(deps.dataDir, request.params.id), stored));
  });

  app.get<{ Params: { name: string } }>("/covers/:name", { onRequest: mustSignIn }, async (request, reply) => {
    const match = COVER_NAME.exec(request.params.name);
    const id = match ? deps.books.byCover(match[1]!) : null;
    if (!id) return reply.code(404).send({ error: "No such cover." });
    return reply.header("cache-control", FOREVER).sendFile(path.posix.join(id, "covers", request.params.name), { cacheControl: false });
  });

  app.get<{ Params: { id: string; "*": string }; Querystring: { ms?: string } }>("/api/books/:id/files/*", { onRequest: mustSignIn }, async (request, reply) => {
    const stored = await storedBook(deps, request.params.id);
    const file = request.params["*"];
    // Only the book's own files: its EPUB, the audio its record lists, and the records carried in with it. Nothing else under its folder, and nothing outside it.
    const known = stored && (file === stored.book.ebook || stored.files.some((f) => f.path === file) || servedRecords(stored).some((kind) => file === `records/${kind}.csv`));
    if (!known) return reply.code(404).send({ error: "No such file in this book." });
    // The corrections with the chapter names the server filled in after them, made as they're asked for.
    const corrections = file === "records/corrections.csv" ? await servedCorrections(bookDir(deps.dataDir, request.params.id), stored) : null;
    if (corrections) return sendRevalidated(request, reply, null, new TextDecoder().decode(corrections), "text/csv; charset=utf-8");
    const where = path.posix.join(request.params.id, file);
    const ms = Number(request.query.ms);
    if (request.query.ms !== undefined && /\.mp3$/i.test(file) && deps.frames.available && Number.isFinite(ms) && ms > 0) {
      // From the moment's frame on, as if the file began there: its own ranges, and no ETag of the whole file's.
      const start = await deps.frames.start(request.params.id, stored, file, ms);
      // The plugin hands its options to @fastify/send, which takes `start`; the plugin's types leave it out.
      const fromFrame: SendOptions & { start: number } = { cacheControl: false, acceptRanges: true, etag: false, lastModified: false, start: start.byte };
      return reply.header("cache-control", ASK_FIRST).header("x-ribbon-starts-at-ms", String(start.ms)).sendFile(where, fromFrame);
    }
    return reply.header("cache-control", ASK_FIRST).sendFile(where, { cacheControl: false, acceptRanges: true, etag: true, lastModified: true });
  });

  // Records come as the CSV a device keeps them in.
  app.addContentTypeParser("text/csv", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.post<{ Params: { id: string; kind: string }; Body: Buffer }>("/api/books/:id/records/:kind", { onRequest: mustSignIn, bodyLimit: RECORD_BYTES }, async (request, reply) => {
    const kind = request.params.kind as HeardKind;
    if (!HEARD.includes(kind)) return reply.code(404).send({ error: "A device sends only what it heard of a book: its heard and aligned records." });
    if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: "Send the record as text/csv." });
    const kept = await keepHeard(deps.dataDir, request.params.id, kind, (await bytesToRows(new Uint8Array(request.body))).rows);
    if (!kept) return reply.code(404).send({ error: "No such book on this server." });
    return kept;
  });
}

/**
 * Send JSON with an ETag made from it, or a bare 304 when the device already
 * has exactly this (If-None-Match). Made here rather than by a plugin so the
 * ETag is always of the JSON itself, whatever compression does after. A
 * body already made is sent as it is, as JSON unless it says otherwise.
 */
export function sendRevalidated(request: FastifyRequest, reply: FastifyReply, data: unknown, body = JSON.stringify(data), type = "application/json; charset=utf-8"): FastifyReply {
  const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
  reply.header("etag", etag).header("cache-control", ASK_FIRST);
  const asked = request.headers["if-none-match"];
  if (asked && asked.split(",").some((tag) => tag.trim() === etag || tag.trim() === "*")) return reply.code(304).send();
  return reply.type(type).send(body);
}

/** A book's full record from its folder, or null when there's no such book. */
export async function storedBook(deps: { books: BookIndex; dataDir: string }, id: string): Promise<StoredBook | null> {
  if (!deps.books.has(id)) return null;
  return JSON.parse(await readFile(path.join(bookDir(deps.dataDir, id), "book.json"), "utf8")) as StoredBook;
}
