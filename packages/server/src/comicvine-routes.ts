import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { runOf, runPicture, type LookedUp, type CvVolume } from "@ribbon/core/comicvine";
import type { Book } from "@ribbon/core/types";
import { signedIn, type Auth, type Person } from "./auth.ts";
import type { Events } from "./events.ts";
import { storedBook } from "./library/api.ts";
import { asEdited, sharedMatch, type BookIndex } from "./library/books.ts";
import { lookUpAsked, shapeAsked, type LookUpRequest } from "./library/comic-match.ts";
import { ComicVineUnreachable, type ComicVine } from "./library/comicvine.ts";
import type { LibrarySeries } from "./library/series.ts";

/**
 * Looking a comic up on ComicVine, for the edit form's "Look it up"
 * (docs/BOOK-DETAILS.md, section 7). The admin's, as editing a book is;
 * every request to ComicVine is the server's, so a device never talks to
 * it, and the key and the answers stay here (library/comicvine.ts).
 *
 * - `GET /api/comicvine/runs?name=&year=`: the runs ComicVine has by a
 *   series' name (its run's year taken out and given as the year), each
 *   with its first year, publisher, how many issues it has, its page, and
 *   a small picture of its first cover, fetched by the server
 *   (`GET /api/comicvine/runs/:run/picture`).
 * - `GET /api/books/:id/comicvine?address=&issue=&as=`: what ComicVine
 *   says of a comic, by an issue's address, or a run's with the issue's
 *   number (a person picked the run), or the comic's own address; its
 *   number read as an issue's, a collection's volume, or neither. Shown
 *   beside what the comic has. Nothing is kept.
 * - `PUT /api/books/:id/comicvine`: "Use these": the same look-up, kept as
 *   the comic's match, between its files and its edits.
 * - `DELETE /api/books/:id/comicvine`: "Forget the match": the layer goes
 *   whole.
 *
 * Off unless the server's owner set a key (RIBBON_COMICVINE_KEY): then the
 * library answer doesn't say `comicVine`, so the form shows no "Look it
 * up", and each of these but forgetting answers 404 and says why. A match
 * kept while the key was set stays when it's taken away, and can still be
 * forgotten.
 */
export function comicVineRoutes(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; series: LibrarySeries; events: Events; dataDir: string; comicVine: ComicVine | null }): void {
  /** The admin, with ComicVine turned on; null once the answer saying otherwise is sent. */
  const admin = async (request: FastifyRequest, reply: FastifyReply, needsKey = true): Promise<{ me: Person; comicVine: ComicVine | null } | null> => {
    const me = await signedIn(deps.auth, request);
    if (!me) {
      await reply.code(401).send({ error: "Sign in first." });
      return null;
    }
    if (me.role !== "admin") {
      await reply.code(403).send({ error: "Only the admin looks the library's comics up on ComicVine." });
      return null;
    }
    if (needsKey && !deps.comicVine) {
      await reply.code(404).send({ error: COMICVINE_OFF });
      return null;
    }
    return { me, comicVine: deps.comicVine };
  };

  /**
   * Look a comic up as a person asked, or answer why it can't be: no such
   * comic, an address that isn't ComicVine's, no such issue there, or
   * ComicVine out of reach. Null once that answer is sent.
   */
  const lookUp = async (comicVine: ComicVine, id: string, asked: LookUpRequest, reply: FastifyReply): Promise<LookedUp | null> => {
    const standing = await comicStanding(deps, id);
    if (!standing) {
      await reply.code(404).send({ error: "No such comic on this server." });
      return null;
    }
    const what = lookUpAsked(standing, asked);
    if (typeof what === "string") {
      await reply.code(400).send({ error: what });
      return null;
    }
    try {
      const found = await comicVine.lookUp(what, "person");
      if (!found) await reply.code(404).send({ error: what.address.kind === "run" ? `ComicVine has no issue ${what.number} in that run.` : "ComicVine has no such issue." });
      return found;
    } catch (e) {
      await unreachable(reply, e);
      return null;
    }
  };

  /** Every device lists the comic as it is now, and finds the series a match names. */
  const changed = (id: string) => {
    deps.events.toEveryone({ type: "books", data: { edited: id } });
    if (deps.series.find(deps.books.list(), Date.now()) > 0) deps.events.toEveryone({ type: "series", data: {} });
  };

  app.get<{ Querystring: { name?: string; year?: string } }>("/api/comicvine/runs", async (request, reply) => {
    const ok = await admin(request, reply);
    if (!ok) return reply;
    const name = request.query.name?.trim() ?? "";
    if (!name) return reply.code(400).send({ error: "Give the series' name to search for, without its run's year." });
    const year = request.query.year?.trim() ? Number(request.query.year) : null;
    if (year !== null && !(Number.isInteger(year) && year >= 1800 && year <= 2200)) return reply.code(400).send({ error: "Give the run's first year as a year: 2023." });
    try {
      const runs = await ok.comicVine!.runs({ name, year }, "person");
      return { runs: runs.map((run) => offered(run)) };
    } catch (e) {
      return unreachable(reply, e);
    }
  });

  app.get<{ Params: { run: string } }>("/api/comicvine/runs/:run/picture", async (request, reply) => {
    const ok = await admin(request, reply);
    if (!ok) return reply;
    const id = request.params.run.match(/^4050-(\d+)$/)?.[1];
    if (!id) return reply.code(404).send({ error: "No such run." });
    try {
      const picture = await ok.comicVine!.runPicture(Number(id), "person");
      if (!picture) return reply.code(404).send({ error: "ComicVine has no picture of that run." });
      return reply.header("cache-control", "private, max-age=86400").type(picture.type).send(Buffer.from(picture.bytes));
    } catch (e) {
      return unreachable(reply, e);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { address?: string; issue?: string; as?: string } }>("/api/books/:id/comicvine", async (request, reply) => {
    const ok = await admin(request, reply);
    if (!ok) return reply;
    const found = await lookUp(ok.comicVine!, request.params.id, { ...request.query, as: shapeAsked(request.query.as) }, reply);
    if (!found) return reply;
    return { lookedUp: { address: found.address, as: found.as, values: found.values, run: found.run ? runOf(found.run) : null } };
  });

  app.put<{ Params: { id: string }; Body: { address?: unknown; issue?: unknown; as?: unknown } | null }>("/api/books/:id/comicvine", async (request, reply) => {
    const ok = await admin(request, reply);
    if (!ok) return reply;
    const body = request.body ?? {};
    const asked = { ...(typeof body.address === "string" ? { address: body.address } : {}), ...(typeof body.issue === "string" ? { issue: body.issue } : {}), as: shapeAsked(body.as) };
    const found = await lookUp(ok.comicVine!, request.params.id, asked, reply);
    if (!found) return reply;
    if (!deps.books.keepMatch(request.params.id, found, ok.me.id, new Date().toISOString())) return reply.code(404).send({ error: "No such comic on this server." });
    changed(request.params.id);
    return { matched: sharedMatch(deps.books.match(request.params.id)!) };
  });

  app.delete<{ Params: { id: string } }>("/api/books/:id/comicvine", async (request, reply) => {
    if (!(await admin(request, reply, false))) return reply;
    if (!deps.books.forgetMatch(request.params.id, Date.now())) return reply.code(404).send({ error: "That comic isn't matched on ComicVine." });
    changed(request.params.id);
    return reply.code(204).send();
  });

}

/** What the server says when ComicVine isn't turned on. */
export const COMICVINE_OFF = "This server doesn't look comics up on ComicVine: its admin hasn't set RIBBON_COMICVINE_KEY.";

/** A run as a person is offered it, with the address of its small picture here, when ComicVine has one. */
function offered(run: CvVolume) {
  const shown = runOf(run);
  return { ...shown, picture: runPicture(run) ? `/api/comicvine/runs/${shown.id}/picture` : null };
}

/** ComicVine couldn't be asked: said as it is, with 503, so a person can try again later. Anything else is the server's own failure. */
function unreachable(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ComicVineUnreachable) return reply.code(503).send({ error: e.message });
  throw e;
}

/** A comic as it stands, as every device shows it (its files, what ComicVine said and its edits), or null when there's no such comic here. */
export async function comicStanding(deps: { books: BookIndex; dataDir: string }, id: string): Promise<Book | null> {
  const stored = await storedBook(deps, id);
  if (!stored?.book.comic) return null;
  return asEdited(stored.book, deps.books.edits(id)?.values ?? {}, deps.books.hasDetails(id), deps.books.match(id));
}
