import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nodeHost } from "../../../src/host/node.ts";
import { signedIn, type Auth } from "../auth.ts";
import type { Jobs } from "../jobs.ts";
import type { BookIndex } from "./books.ts";
import { importFolder, type ImportProgress } from "./importer.ts";

/**
 * The admin's side of the library: adding a folder of books, and following
 * the job that does it. The listing the apps read comes in its own routes.
 */
export function libraryRoutes(app: FastifyInstance, deps: { auth: Auth; jobs: Jobs; books: BookIndex; dataDir: string }): void {
  const host = nodeHost();

  app.post<{ Body: { folder?: unknown } }>("/api/library/import", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can add books." });
    const folder = typeof request.body?.folder === "string" ? request.body.folder.trim() : "";
    if (!folder || !path.isAbsolute(folder)) return reply.code(400).send({ error: "Give the folder's full path on the server's machine." });
    const first: ImportProgress = { folder, found: 0, added: 0, skipped: 0, failed: 0, current: null, notes: [] };
    const job = deps.jobs.start("import", first, (report) => importFolder({ host, dataDir: deps.dataDir, index: deps.books, addedBy: me.id }, folder, report), me.id);
    return reply.code(202).send({ job });
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
