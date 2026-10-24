import fastifyCompress from "@fastify/compress";
import fastifyCors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders } from "better-auth/node";
import type { DatabaseSync } from "node:sqlite";
import { authOptions, makeAuth, placeholderEmail, signedIn, type Auth } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { invitePage } from "./invite-page.ts";
import { Invites, type Role } from "./invites.ts";
import { Events } from "./events.ts";
import { Jobs } from "./jobs.ts";
import { nodeHost } from "../../src/host/node.ts";
import { BookIndex } from "./library/books.ts";
import { booksToPrepare, prepareBooks, type PrepareProgress } from "./library/prepare.ts";
import { booksToHydrate, hydrateBooks, type HydrateProgress } from "./library/hydrate.ts";
import { libraryApi } from "./library/api.ts";
import { libraryRoutes } from "./library/routes.ts";
import { ReadAlongs } from "./library/readalong.ts";
import { SearchIndex } from "./library/search.ts";
import { LibrarySeries } from "./library/series.ts";
import { Mp3Frames } from "./library/frames.ts";
import { Transcriber } from "./library/transcribe.ts";
import { Places } from "./places.ts";
import { placesRoutes } from "./places-routes.ts";
import { readAlongRoutes } from "./readalong-routes.ts";

export interface RibbonServer {
  app: FastifyInstance;
  auth: Auth;
  db: DatabaseSync;
  invites: Invites;
  jobs: Jobs;
  books: BookIndex;
  places: Places;
  events: Events;
}

/**
 * The server, ready to listen: its database opened and brought up to date,
 * accounts, invites and the routes over them (docs/SERVER.md). Built
 * without listening, so the tests drive it with `app.inject`.
 */
export async function buildServer(config: ServerConfig, opts: { logger?: boolean } = {}): Promise<RibbonServer> {
  const db = openDatabase(config.dataDir);
  const options = authOptions(db, config);
  await (await getMigrations(options)).runMigrations();
  const auth = makeAuth(options);
  const invites = new Invites(db);
  const jobs = new Jobs(db);
  const books = new BookIndex(db);
  // Books added before the server kept series join theirs now; after that, as each folder is added.
  const series = new LibrarySeries(db);
  series.find(books.list(), Date.now());
  const places = new Places(db);
  const imported = await places.importFiles(config.dataDir);
  // Books added before the server measured them are measured once, in the background.
  const unprepared = await booksToPrepare(config.dataDir, books);
  if (unprepared.length > 0) jobs.start<PrepareProgress>("prepare", { books: unprepared.length, done: 0, current: null }, (report) => prepareBooks(nodeHost(), config.dataDir, unprepared, report), null);
  const events = new Events();

  // A proxy on this machine (Caddy, Tailscale Serve) says whether the request came in over HTTPS; anyone else's word for it isn't taken.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: ["127.0.0.1", "::1"] });
  if (imported > 0) app.log.info(`took ${imported} place records kept in files into the database`);
  // JSON shrinks a lot; audio, pictures and EPUBs are compressed already and go as they are.
  await app.register(fastifyCompress, { encodings: ["br", "gzip"] });
  // The apps call the API from their own origin. They sign in with a token in a header, never a cookie, so any
  // origin may ask: a page elsewhere has nothing of the person's to send along.
  await app.register(fastifyCors, {
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "if-none-match", "range", "if-range"],
    exposedHeaders: ["etag", "set-auth-token", "content-range", "accept-ranges", "content-length", "last-modified"],
    maxAge: 86_400,
  });

  // Passwords travel only over HTTPS, or within this machine (docs/SERVER.md, section 6).
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || !sendsPassword(request.url) || isSecure(request)) return;
    await reply.code(403).send({ error: "Passwords are only sent over HTTPS. Reach this server through HTTPS, or from the machine it runs on." });
  });

  app.get("/healthz", async () => ({ ok: true }));

  // Better Auth's own routes: sign in with a name, sign out, sessions, the admin's tools.
  app.route({ method: ["GET", "POST"], url: "/api/auth/*", handler: (request, reply) => passToAuth(auth, request, reply) });

  app.get("/api/me", async (request, reply) => {
    const me = await signedIn(auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    return { user: me };
  });

  app.post("/api/invites", async (request, reply) => {
    const me = await signedIn(auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can invite people." });
    const invite = invites.create("user", me.id);
    return { code: invite.code, url: `${config.url}/invite/${invite.code}`, expiresAt: new Date(invite.expiresAt).toISOString() };
  });

  app.get<{ Params: { code: string } }>("/invite/:code", async (request, reply) => {
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(invitePage({ code: request.params.code, usable: invites.usable(request.params.code), serverUrl: config.url }));
  });

  app.post<{ Params: { code: string }; Body: { name?: unknown; password?: unknown } }>("/api/invites/:code/accept", async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!name || !password) return reply.code(400).send({ error: "A name and a password, please." });
    const { code } = request.params;
    const role = invites.reserve(code);
    if (!role) return reply.code(410).send({ error: "This invite has been used already, or it has expired. Ask the server's admin for a new one." });
    try {
      const { headers, response } = await auth.api.signUpEmail({
        body: { email: placeholderEmail(name), name, username: name, password },
        headers: fromNodeHeaders(request.headers),
        returnHeaders: true,
      });
      setRole(db, response.user.id, role);
      invites.spend(code, response.user.id);
      const token = headers.get("set-auth-token");
      return { token, user: { id: response.user.id, name, role } };
    } catch (e) {
      invites.release(code);
      if (e instanceof APIError) {
        const said = inOurWords(e);
        return reply.code(said.taken ? 409 : e.statusCode >= 500 ? 500 : 400).send({ error: said.message });
      }
      throw e;
    }
  });

  const frames = new Mp3Frames(config.dataDir, config.framesTool ?? null);
  // MP3s added before the server indexed them are indexed once, in the background.
  if (frames.available) jobs.start("frames", { indexed: 0 }, async () => ({ indexed: await frames.indexMissing(books) }), null);
  const search = new SearchIndex(db);
  const readAlongs = new ReadAlongs(config.dataDir, config.ebookTool ?? null, search, app.log);
  // Books added before the server filled in what they came without get it from their EPUBs, in the background, before
  // their sentences are indexed with the chapters named.
  if (readAlongs.available) jobs.start<HydrateProgress>("hydrate", { books: 0, done: 0, described: 0, named: 0, current: null }, async (report) => hydrateBooks(readAlongs, config.dataDir, await booksToHydrate(config.dataDir, books), report), null);
  // Books added before the server searched sentences are indexed once, in the background, after the MP3s.
  if (readAlongs.available) jobs.start("search", { indexed: 0 }, async () => ({ indexed: await search.indexAll(books, readAlongs, config.dataDir) }), null);
  // The narration of books added before the server transcribed is heard in the background, in a lane of its own: it takes hours a book.
  const transcriber = new Transcriber({ dataDir: config.dataDir, books, readAlongs, speech: config.speech ?? null, log: app.log });
  transcriber.start(jobs);
  app.addHook("onClose", async () => transcriber.stop());
  libraryRoutes(app, { auth, jobs, books, series, events, frames, readAlongs, search, transcriber, dataDir: config.dataDir });
  await libraryApi(app, { auth, books, series, dataDir: config.dataDir, frames });
  placesRoutes(app, { auth, places, events });
  readAlongRoutes(app, { auth, books, places, events, readAlongs, search, frames, transcriber, dataDir: config.dataDir });

  return { app, auth, db, invites, jobs, books, places, events };
}

/** Hand a request to Better Auth as the Fetch request it expects, and its answer back to Fastify. */
async function passToAuth(auth: Auth, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = new URL(request.url, `${request.protocol}://${request.headers.host ?? "localhost"}`);
  const init: RequestInit = { method: request.method, headers: fromNodeHeaders(request.headers) };
  if (request.body !== undefined && request.method !== "GET") init.body = JSON.stringify(request.body);
  const response = await auth.handler(new Request(url, init));
  reply.code(response.status);
  for (const [key, value] of response.headers) if (key !== "set-cookie") reply.header(key, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  await reply.send(response.body ? await response.text() : null);
}

/** Routes that carry a password in their body. */
function sendsPassword(url: string): boolean {
  const pathname = url.split("?")[0]!;
  return pathname.startsWith("/api/auth/") || /^\/api\/invites\/[^/]+\/accept$/.test(pathname);
}

function isSecure(request: FastifyRequest): boolean {
  return request.protocol === "https" || ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip);
}

/** Better Auth's admin plugin keeps the role on the user; an invite's role is set when its account is made. */
function setRole(db: DatabaseSync, userId: string, role: Role): void {
  db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run(role, userId);
}

/** Better Auth's messages for a refused sign-up, said the way Ribbon says things, and whether the name was the trouble. */
function inOurWords(e: APIError): { message: string; taken: boolean } {
  const message = e.body?.message ?? e.message;
  if (/taken|already exists/i.test(message)) return { message: "That name is taken. Try another.", taken: true };
  if (/username.*(invalid|short|long)|invalid username/i.test(message)) return { message: "A name is 3 to 30 letters, numbers, dots and underscores.", taken: false };
  if (/password.*short/i.test(message)) return { message: "The password needs at least 8 characters.", taken: false };
  return { message, taken: false };
}
