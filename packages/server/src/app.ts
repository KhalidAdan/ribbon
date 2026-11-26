import fastifyCompress from "@fastify/compress";
import fastifyCors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { AccountRefused } from "@ribbon/auth-accounts/accounts";
import { sessionCookie } from "@ribbon/auth/sessions";
import { openAuth, signedIn, type Auth } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { invitePage } from "./invite-page.ts";
import { Invites } from "./invites.ts";
import { isSecure, sendsPassword, signInRoutes } from "./sign-in-routes.ts";
import { Events } from "./events.ts";
import { Jobs } from "./jobs.ts";
import { nodeHost } from "@ribbon/host-node/node";
import { listDirections, relistRecords } from "./library/book-folder.ts";
import { BookIndex } from "./library/books.ts";
import { readComicsAgain } from "./library/comic-details.ts";
import { startMatching } from "./library/comic-match.ts";
import { ComicVine, type Clock } from "./library/comicvine.ts";
import { booksToPrepare, prepareBooks, type PrepareProgress } from "./library/prepare.ts";
import { audibleCatalog, booksToDescribe, describeBooks, type DescribeProgress } from "./library/describe.ts";
import { booksToHydrate, hydrateBooks, type HydrateProgress } from "./library/hydrate.ts";
import { booksToPlace, placeBooks, type PlaceProgress } from "./library/place.ts";
import { libraryApi } from "./library/api.ts";
import { libraryRoutes } from "./library/routes.ts";
import { readAlongOff } from "@ribbon/core/edits";
import { ReadAlongs } from "./library/readalong.ts";
import { SearchIndex } from "./library/search.ts";
import { LibrarySeries } from "./library/series.ts";
import { Mp3Frames } from "./library/frames.ts";
import { Goals } from "./goals.ts";
import { Places } from "./places.ts";
import { placesRoutes } from "./places-routes.ts";
import { ComicPanels } from "./library/panels.ts";
import { panelsRoutes } from "./panels-routes.ts";
import { mcpRoutes } from "./mcp.ts";
import { comicVineRoutes } from "./comicvine-routes.ts";
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
export async function buildServer(config: ServerConfig, opts: { logger?: boolean; comicVineClock?: Clock } = {}): Promise<RibbonServer> {
  const db = openDatabase(config.dataDir);
  const auth = await openAuth(db, config);
  const invites = new Invites(db);
  const jobs = new Jobs(db);
  const books = new BookIndex(db);
  // Comics added before comics had details of their own are read again, named from them, and their edits moved into them,
  // once (comic-details.ts): before anything lists them, and before series are found by their names.
  const comics = await readComicsAgain(config.dataDir, books);
  // Books added before the server kept series join theirs now; after that, as each folder is added.
  const series = new LibrarySeries(db);
  series.find(books.list(), Date.now());
  const places = new Places(db);
  const imported = await places.importFiles(config.dataDir);
  // Records a book holds that a job writing back an older copy of its record left off its list (book-folder.ts), listed again.
  const relisted = await relistRecords(config.dataDir, books);
  // Comics added before the library listed which way they read, listed as their records say.
  const directed = await listDirections(config.dataDir, books);
  // Books added before the server measured them are measured once, in the background.
  const unprepared = await booksToPrepare(config.dataDir, books);
  if (unprepared.length > 0) jobs.start<PrepareProgress>("prepare", { books: unprepared.length, done: 0, current: null }, (report) => prepareBooks(nodeHost(), config.dataDir, unprepared, report), null);
  const events = new Events();

  // A proxy on this machine (Caddy, Tailscale Serve) says whether the request came in over HTTPS; anyone else's word for it isn't taken.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: ["127.0.0.1", "::1"] });
  if (imported > 0) app.log.info(`took ${imported} place records kept in files into the database`);
  if (relisted > 0) app.log.info(`listed again the records of ${relisted} books whose record had lost them`);
  if (directed > 0) app.log.info(`listed which way ${directed} comics read, from their records`);
  if (comics.read > 0) app.log.info(`read ${comics.read} comics again for their own details, and moved the edits of ${comics.moved} into them`);
  if (comics.unreadable.length > 0) app.log.warn(`couldn't read ${comics.unreadable.length} comics again for their own details, to try at the next start: ${comics.unreadable.join(", ")}`);
  // JSON shrinks a lot; audio, pictures and EPUBs are compressed already and go as they are.
  await app.register(fastifyCompress, { encodings: ["br", "gzip"] });
  // The apps call the API from their own origin. They sign in with a token in a header, never a cookie, so any
  // origin may ask: a page elsewhere has nothing of the person's to send along.
  await app.register(fastifyCors, {
    origin: true,
    credentials: false,
    // PUT: a series renamed or reordered, and a book's whole transcript (#152).
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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

  signInRoutes(app, { auth, config });

  app.get("/api/me", async (request, reply) => {
    const me = await signedIn(auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    return { user: me };
  });

  // Invites are how people join the accounts the server keeps itself. With another provider, its own admin lets people in.
  const { accounts } = auth;
  const noInvites = accounts ? null : `People join this server through ${auth.provider.kind === "browser" ? auth.provider.name : "its sign-in"}: ask its admin there.`;

  app.post("/api/invites", async (request, reply) => {
    const me = await signedIn(auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can invite people." });
    if (noInvites) return reply.code(404).send({ error: noInvites });
    const invite = invites.create("user", me.id);
    return { code: invite.code, url: `${config.url}/invite/${invite.code}`, expiresAt: new Date(invite.expiresAt).toISOString() };
  });

  app.get<{ Params: { code: string } }>("/invite/:code", async (request, reply) => {
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(invitePage({ code: request.params.code, usable: accounts !== null && invites.usable(request.params.code), serverUrl: config.url }));
  });

  app.post<{ Params: { code: string }; Body: { name?: unknown; password?: unknown } }>("/api/invites/:code/accept", async (request, reply) => {
    if (!accounts) return reply.code(404).send({ error: noInvites });
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!name || !password) return reply.code(400).send({ error: "A name and a password, please." });
    const { code } = request.params;
    const role = invites.reserve(code);
    if (!role) return reply.code(410).send({ error: "This invite has been used already, or it has expired. Ask the server's admin for a new one." });
    try {
      const person = auth.people.welcome(await accounts.signUp(name, password));
      auth.people.setRole(person.id, role);
      invites.spend(code, person.id);
      const token = auth.sessions.start(person.id);
      reply.header("set-auth-token", token).header("set-cookie", sessionCookie(token, { secure: config.url.startsWith("https://") }).header);
      return { token, user: { id: person.id, name, role } };
    } catch (e) {
      invites.release(code);
      if (e instanceof AccountRefused) return reply.code(e.taken ? 409 : 400).send({ error: e.message });
      throw e;
    }
  });

  const frames = new Mp3Frames(config.dataDir, config.framesTool ?? null);
  // MP3s added before the server indexed them are indexed once, in the background.
  if (frames.available) jobs.start("frames", { indexed: 0 }, async () => ({ indexed: await frames.indexMissing(books) }), null);
  const search = new SearchIndex(db);
  const readAlongs = new ReadAlongs(config.dataDir, config.ebookTool ?? null, search, app.log, (id) => readAlongOff(books.edits(id)?.values));
  // Books added before the server filled in what they came without get it from their EPUBs, in the background, before
  // their sentences are indexed with the chapters named.
  if (readAlongs.available) jobs.start<HydrateProgress>("hydrate", { books: 0, done: 0, described: 0, named: 0, current: null }, async (report) => hydrateBooks(readAlongs, config.dataDir, await booksToHydrate(config.dataDir, books), report), null);
  // Transcripts kept before they were placed by what was said in them are placed now, once each (place.ts).
  if (readAlongs.available) jobs.start<PlaceProgress>("place", { books: 0, done: 0, placed: 0, current: null }, async (report) => placeBooks(readAlongs, config.dataDir, await booksToPlace(config.dataDir, books), report), null);
  // Then, when the admin has turned it on, the books still without a description get the catalog's (describe.ts).
  const catalog = config.descriptions ? audibleCatalog(config.descriptions.store) : null;
  if (catalog) jobs.start<DescribeProgress>("describe", { books: 0, done: 0, described: 0, current: null }, async (report) => describeBooks(catalog, config.dataDir, await booksToDescribe(config.dataDir, books), report), null);
  // Books added before the server searched sentences are indexed once, in the background, after the MP3s; and the ones
  // indexed before it counted their words are counted, from the sentences it has, for the bookcase.
  if (readAlongs.available) jobs.start("search", { indexed: 0, counted: 0 }, async () => ({ counted: await search.countMissing(), indexed: await search.indexAll(books, readAlongs, config.dataDir) }), null);
  // The narration isn't transcribed here: a device with a graphics card transcribes each book whole and sends it (records.ts, `keepTranscript`).
  // A comic's panels: for the devices to read by, and for an assistant to set through the MCP (docs/COMICS.md, section 14).
  const panels = new ComicPanels(db);
  // When the admin has turned it on, comics whose files name their issue on ComicVine are matched to it (comic-match.ts).
  const comicVine = config.comicVine ? new ComicVine(db, { ...config.comicVine, ...(opts.comicVineClock ? { clock: opts.comicVineClock } : {}) }) : null;
  if (comicVine) startMatching({ jobs, comicVine, books, series, events, dataDir: config.dataDir }, null);
  libraryRoutes(app, { auth, jobs, books, places, series, events, frames, readAlongs, search, catalog, comicVine, panels, dataDir: config.dataDir, folders: config.folders ?? [] });
  await libraryApi(app, { auth, books, series, dataDir: config.dataDir, frames, readAlongs, comicVine: comicVine !== null });
  placesRoutes(app, { auth, places, events });
  readAlongRoutes(app, { auth, books, places, goals: new Goals(db), events, readAlongs, search, frames, dataDir: config.dataDir });

  panelsRoutes(app, { auth, books, panels, dataDir: config.dataDir });
  mcpRoutes(app, { auth, books, panels, series, events, comicVine, dataDir: config.dataDir });
  comicVineRoutes(app, { auth, books, series, events, comicVine, dataDir: config.dataDir });

  return { app, auth, db, invites, jobs, books, places, events };
}
