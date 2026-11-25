import type { FastifyInstance } from "fastify";
import { panelsFrom, type Panel } from "@ribbon/core/comic/panels";
import { signedIn, type Auth } from "./auth.ts";
import { sendRevalidated, storedBook } from "./library/api.ts";
import type { BookIndex, StoredBook } from "./library/books.ts";
import type { ComicPage } from "./library/comic.ts";
import type { ComicPanels } from "./library/panels.ts";

/**
 * A comic's panels, for the devices (docs/COMICS.md, section 14):
 *
 * - `GET /api/books/:id/panels`: every divided page of a comic, each with
 *   its panels in reading order. Pages count from 1; a page not listed
 *   has none, and is read whole.
 * - `PUT /api/books/:id/pages/:n/panels`: a page's panels, in place of the
 *   ones it had; an empty list takes them away. The admin's to do, as a
 *   book's edits are.
 *
 * The MCP (mcp.ts) reads and writes the same panels through the same
 * store, with the same checks.
 */
export function panelsRoutes(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; panels: ComicPanels; dataDir: string }): void {
  app.get<{ Params: { id: string } }>("/api/books/:id/panels", async (request, reply) => {
    if (!(await signedIn(deps.auth, request))) return reply.code(401).send({ error: "Sign in first." });
    const comic = await comicOn(deps, request.params.id);
    if (!comic) return reply.code(404).send({ error: "No such comic on this server." });
    return sendRevalidated(request, reply, { pages: dividedPages(comic.pages, deps.panels.of(request.params.id)) });
  });

  app.put<{ Params: { id: string; page: string }; Body: { panels?: unknown } }>("/api/books/:id/pages/:page/panels", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin can change a comic's panels." });
    const comic = await comicOn(deps, request.params.id);
    if (!comic) return reply.code(404).send({ error: "No such comic on this server." });
    const page = /^\d+$/.test(request.params.page) ? comic.pages[Number(request.params.page) - 1] : undefined;
    if (!page) return reply.code(404).send({ error: `This comic has ${comic.pages.length} pages, counted from 1.` });
    const panels = panelsFrom(request.body?.panels);
    if (!panels) return reply.code(400).send({ error: "Give the page's panels in reading order, each as x, y, w and h in fractions of the page." });
    const problem = deps.panels.keep(request.params.id, page.name, panels, me.id);
    if (problem) return reply.code(400).send({ error: problem });
    return { page: Number(request.params.page), panels };
  });
}

/** A comic on the server with its pages, or null: not a book here, or not one of pages. */
export async function comicOn(deps: { books: BookIndex; dataDir: string }, id: string): Promise<{ stored: StoredBook; file: string; pages: ComicPage[] } | null> {
  const stored = await storedBook(deps, id);
  return stored?.book.comic && stored.pages ? { stored, file: stored.book.comic, pages: stored.pages } : null;
}

/** A comic's divided pages in page order, each by its number counted from 1. */
export function dividedPages(pages: readonly ComicPage[], kept: Map<string, Panel[]>): { page: number; panels: Panel[] }[] {
  return pages.flatMap((page, at) => {
    const panels = kept.get(page.name);
    return panels ? [{ page: at + 1, panels }] : [];
  });
}
