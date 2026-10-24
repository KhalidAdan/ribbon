import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nodeHost } from "../../../src/host/node.ts";
import { signedIn, type Auth } from "../auth.ts";
import type { Events } from "../events.ts";
import type { Jobs } from "../jobs.ts";
import { removeBookDir, type BookIndex } from "./books.ts";
import type { Mp3Frames } from "./frames.ts";
import type { ReadAlongs } from "./readalong.ts";
import type { SearchIndex } from "./search.ts";
import type { Transcriber } from "./transcribe.ts";
import { importFolder, type ImportProgress } from "./importer.ts";
import { booksToHydrate, hydrateBooks } from "./hydrate.ts";

/**
 * The admin's side of the library: adding a folder of books, following the
 * job that does it, and deleting a book. The listing the apps read comes in
 * its own routes.
 */
export function libraryRoutes(app: FastifyInstance, deps: { auth: Auth; jobs: Jobs; books: BookIndex; events: Events; frames: Mp3Frames; readAlongs: ReadAlongs; search: SearchIndex; transcriber: Transcriber; dataDir: string }): void {
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
        // The new books' MP3s are indexed now, so the TV's first play from a moment doesn't wait on reading a whole file;
        // what they came without is filled in from their EPUBs; and their sentences are indexed, so they can be searched.
        await deps.frames.indexMissing(deps.books);
        if (deps.readAlongs.available) await hydrateBooks(deps.readAlongs, deps.dataDir, await booksToHydrate(deps.dataDir, deps.books), () => undefined);
        await deps.search.indexAll(deps.books, deps.readAlongs, deps.dataDir);
        // And their narration is transcribed, after any being heard already.
        deps.transcriber.start(deps.jobs);
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

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can see the server's jobs." });
    const job = deps.jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "No such job." });
    return { job };
  });
}
