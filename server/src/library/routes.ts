import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nodeHost } from "../../../src/host/node.ts";
import { signedIn, type Auth } from "../auth.ts";
import type { Events } from "../events.ts";
import type { Jobs } from "../jobs.ts";
import { removeBookDir, type BookIndex } from "./books.ts";
import { readStored } from "./prepare.ts";
import type { Mp3Frames } from "./frames.ts";
import { stateOf, type ReadAlongState, type ReadAlongs } from "./readalong.ts";
import type { SearchIndex } from "./search.ts";
import type { LibrarySeries, SeriesBookChange } from "./series.ts";
import type { Transcriber } from "./transcribe.ts";
import { importFolder, type ImportProgress } from "./importer.ts";
import { booksToHydrate, hydrateBooks } from "./hydrate.ts";
import { booksToDescribe, describeBooks, type Catalog, type DescribeProgress } from "./describe.ts";

/**
 * The admin's side of the library: adding a folder of books, following the
 * job that does it, deleting a book, and making, changing and deleting a
 * series (`POST /api/series`, `PUT` and `DELETE /api/series/:id`, each with
 * its name and its books in order). And how every book reads along
 * (`GET /api/library/readalong`), so a book left by chapter is never found
 * only on the TV. The listing the apps read comes in its own routes.
 */
export function libraryRoutes(app: FastifyInstance, deps: { auth: Auth; jobs: Jobs; books: BookIndex; series: LibrarySeries; events: Events; frames: Mp3Frames; readAlongs: ReadAlongs; search: SearchIndex; transcriber: Transcriber; catalog: Catalog | null; dataDir: string }): void {
  const host = nodeHost();

  app.post<{ Body: { folder?: unknown } }>("/api/library/import", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can add books." });
    const folder = typeof request.body?.folder === "string" ? request.body.folder.trim() : "";
    if (!folder || !path.isAbsolute(folder)) return reply.code(400).send({ error: "Give the folder's full path on the server's machine." });
    const first: ImportProgress = { folder, found: 0, added: 0, skipped: 0, failed: 0, current: null, notes: [] };
    const job = deps.jobs.start(
      "import",
      first,
      async (report) => {
        // Every device showing the library hears of each book as it's added, so shelves fill as the import goes.
        let added = 0;
        const done = await importFolder({ host, dataDir: deps.dataDir, index: deps.books, addedBy: me.id }, folder, (progress) => {
          report(progress);
          if (progress.added > added) {
            added = progress.added;
            deps.events.toEveryone({ type: "books", data: { added } });
          }
        });
        // The new books join the series they belong to, or make new ones.
        if (deps.series.find(deps.books.list(), Date.now()) > 0) deps.events.toEveryone({ type: "series", data: {} });
        // The new books' MP3s are indexed now, so the TV's first play from a moment doesn't wait on reading a whole file;
        // what they came without is filled in from their EPUBs; and their sentences are indexed, so they can be searched.
        await deps.frames.indexMissing(deps.books);
        if (deps.readAlongs.available) await hydrateBooks(deps.readAlongs, deps.dataDir, await booksToHydrate(deps.dataDir, deps.books), () => undefined);
        await deps.search.indexAll(deps.books, deps.readAlongs, deps.dataDir);
        // And their narration is transcribed, after any being heard already.
        deps.transcriber.start(deps.jobs);
        // The ones still without a description get the catalog's, once this job is done (describe.ts).
        const catalog = deps.catalog;
        if (catalog) deps.jobs.start<DescribeProgress>("describe", { books: 0, done: 0, described: 0, current: null }, async (report) => describeBooks(catalog, deps.dataDir, await booksToDescribe(deps.dataDir, deps.books), report), me.id);
        return done;
      },
      me.id,
    );
    return reply.code(202).send({ job });
  });

  // Deleting a book: its files go from here, and from every device that downloaded it as each hears (the library answer lists it as deleted). Everyone's places in it stay theirs.
  app.delete<{ Params: { id: string } }>("/api/books/:id", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can delete books." });
    const id = request.params.id;
    if (!deps.books.remove(id, me.id, Date.now())) return reply.code(404).send({ error: "No such book on this server." });
    // Off the list first, so nobody starts a download of it; then out of search, and its files.
    deps.search.remove(id);
    await removeBookDir(deps.dataDir, id).catch((e: unknown) => request.log.warn({ err: e }, `could not remove the files of deleted book ${id}`));
    deps.events.toEveryone({ type: "books", data: { deleted: id } });
    return reply.code(204).send();
  });

  app.post<{ Body: unknown }>("/api/series", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can change the library's series." });
    const asked = seriesAsked(request.body);
    if (!asked) return reply.code(400).send({ error: "Give the series a name and its books, in order." });
    const made = deps.series.create(asked.name, asked.books, me.id, Date.now());
    if (!made) return reply.code(400).send({ error: "None of those books is on this server." });
    deps.events.toEveryone({ type: "series", data: {} });
    return reply.code(201).send({ series: made });
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/series/:id", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can change the library's series." });
    const asked = seriesAsked(request.body);
    if (!asked) return reply.code(400).send({ error: "Give the series a name and its books, in order." });
    const saved = deps.series.save(request.params.id, asked.name, asked.books, me.id, Date.now());
    if (!saved) return reply.code(404).send({ error: "No such series on this server." });
    deps.events.toEveryone({ type: "series", data: {} });
    return { series: saved };
  });

  app.delete<{ Params: { id: string } }>("/api/series/:id", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can change the library's series." });
    if (!deps.series.drop(request.params.id, me.id, Date.now())) return reply.code(404).send({ error: "No such series on this server." });
    deps.events.toEveryone({ type: "series", data: {} });
    return reply.code(204).send();
  });

  // Every book with text and narration: where its read-along stands (readalong.ts, `stateOf`), the ones a person needs to look at first.
  app.get("/api/library/readalong", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can see how the library reads along." });
    reply.header("cache-control", "no-store");
    const transcribes = deps.transcriber.available;
    const books = [];
    // One at a time: a book whose transcript changed since is made again, which takes a moment on a slow machine.
    for (const b of deps.books.list().filter((b) => b.ebook && b.audio)) {
      const stored = await readStored(deps.dataDir, b.id);
      const standing = stored ? await deps.readAlongs.standing(b.id, stored) : "It's no longer on the server.";
      if (typeof standing === "string") books.push({ id: b.id, title: b.title, state: "unreadable" as const, error: standing });
      else books.push({ id: b.id, title: b.title, state: stateOf(standing, transcribes), placed: standing.check.placed, heldOut: standing.check.heldOut, pairedBy: standing.pairedBy, transcribed: standing.transcribed });
    }
    books.sort((a, b) => FIRST.indexOf(a.state) - FIRST.indexOf(b.state) || a.title.localeCompare(b.title));
    return { transcribes, books };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can see the server's jobs." });
    const job = deps.jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "No such job." });
    return { job };
  });
}

/** The order books are listed in by how they read along: the ones that need a person first. */
const FIRST: readonly (ReadAlongState | "unreadable")[] = ["unreadable", "flagged", "unpaired", "waiting", "transcribing", "sentence"];

/** A series as a request gives it: a name, and its books in order, each with its number, title and whether it's on the shelf where given. Null when it isn't one. */
function seriesAsked(body: unknown): { name: string; books: SeriesBookChange[] } | null {
  const b = body as { name?: unknown; books?: unknown } | null;
  const name = typeof b?.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 200 || !Array.isArray(b?.books)) return null;
  const books: SeriesBookChange[] = [];
  for (const item of b.books as unknown[]) {
    const x = item as { id?: unknown; number?: unknown; title?: unknown; shelved?: unknown } | null;
    if (typeof x?.id !== "string") return null;
    if (x.number !== undefined && x.number !== null && (typeof x.number !== "number" || !Number.isFinite(x.number))) return null;
    if (x.title !== undefined && x.title !== null && typeof x.title !== "string") return null;
    if (x.shelved !== undefined && typeof x.shelved !== "boolean") return null;
    books.push({
      id: x.id,
      ...(x.number !== undefined ? { number: x.number as number | null } : {}),
      ...(x.title !== undefined ? { title: x.title as string | null } : {}),
      ...(x.shelved !== undefined ? { shelved: x.shelved } : {}),
    });
  }
  return { name, books };
}
