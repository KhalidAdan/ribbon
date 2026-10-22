import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { signedIn, type Auth } from "../auth.ts";
import { bookDir, type BookIndex, type StoredBook } from "./books.ts";
import { COVER_WIDTHS } from "./covers.ts";

/** A cover's file name: its picture's hash and one of the widths it's made at. */
const COVER_NAME = new RegExp(`^([0-9a-f]{16})-(${COVER_WIDTHS.join("|")})\\.jpg$`);

/** A year: as long as a browser or an app keeps anything. A cover's address changes when its picture does. */
const FOREVER = "private, max-age=31536000, immutable";
/** Kept, but asked about every time: the answer is almost always "nothing changed". */
const ASK_FIRST = "private, no-cache";

/**
 * The library as the apps read it (docs/SERVER.md, sections 7 and 10),
 * for anyone signed in:
 *
 * - `GET /api/books`: every book, with each cover's shape and colour.
 * - `GET /api/books/:id`: one book in full: its files, chapters and parts.
 * - `GET /covers/:hash-:width.jpg`: a cover, at an address that never changes.
 * - `GET /api/books/:id/files/*`: a file of the book, for downloads.
 *
 * The two JSON answers carry an ETag and are sent "no-cache": a device
 * keeps them and asks again with If-None-Match, and gets a bare 304 when
 * nothing changed. Places are never in them, so they stay the same while
 * people listen. Files carry an ETag and Last-Modified and answer Range
 * and If-Range, so a download that stopped carries on where it was.
 */
export async function libraryApi(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; dataDir: string }): Promise<void> {
  // Sends files with Range, ETag and Last-Modified (the `send` module); no routes of its own.
  // Made now, not with the first book: the files plugin wants its folder to exist.
  mkdirSync(path.join(deps.dataDir, "books"), { recursive: true });
  await app.register(fastifyStatic, { root: path.join(deps.dataDir, "books"), serve: false });

  const mustSignIn = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await signedIn(deps.auth, request))) await reply.code(401).send({ error: "Sign in first." });
  };

  app.get("/api/books", { onRequest: mustSignIn }, async (request, reply) => sendRevalidated(request, reply, { books: deps.books.list() }));

  app.get<{ Params: { id: string } }>("/api/books/:id", { onRequest: mustSignIn }, async (request, reply) => {
    const stored = await storedBook(deps, request.params.id);
    if (!stored) return reply.code(404).send({ error: "No such book on this server." });
    return sendRevalidated(request, reply, stored);
  });

  app.get<{ Params: { name: string } }>("/covers/:name", { onRequest: mustSignIn }, async (request, reply) => {
    const match = COVER_NAME.exec(request.params.name);
    const id = match ? deps.books.byCover(match[1]!) : null;
    if (!id) return reply.code(404).send({ error: "No such cover." });
    return reply.header("cache-control", FOREVER).sendFile(path.posix.join(id, "covers", request.params.name), { cacheControl: false });
  });

  app.get<{ Params: { id: string; "*": string } }>("/api/books/:id/files/*", { onRequest: mustSignIn }, async (request, reply) => {
    const stored = await storedBook(deps, request.params.id);
    const file = request.params["*"];
    // Only the book's own files: its EPUB and the audio its record lists. Nothing else under its folder, and nothing outside it.
    const known = stored && (file === stored.book.ebook || stored.files.some((f) => f.path === file));
    if (!known) return reply.code(404).send({ error: "No such file in this book." });
    return reply.header("cache-control", ASK_FIRST).sendFile(path.posix.join(request.params.id, file), { cacheControl: false, acceptRanges: true, etag: true, lastModified: true });
  });
}

/**
 * Send JSON with an ETag made from it, or a bare 304 when the device already
 * has exactly this (If-None-Match). Made here rather than by a plugin so the
 * ETag is always of the JSON itself, whatever compression does after.
 */
function sendRevalidated(request: FastifyRequest, reply: FastifyReply, data: unknown): FastifyReply {
  const body = JSON.stringify(data);
  const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
  reply.header("etag", etag).header("cache-control", ASK_FIRST);
  const asked = request.headers["if-none-match"];
  if (asked && asked.split(",").some((tag) => tag.trim() === etag || tag.trim() === "*")) return reply.code(304).send();
  return reply.type("application/json; charset=utf-8").send(body);
}

/** A book's full record from its folder, or null when there's no such book. */
async function storedBook(deps: { books: BookIndex; dataDir: string }, id: string): Promise<StoredBook | null> {
  if (!deps.books.has(id)) return null;
  return JSON.parse(await readFile(path.join(bookDir(deps.dataDir, id), "book.json"), "utf8")) as StoredBook;
}
