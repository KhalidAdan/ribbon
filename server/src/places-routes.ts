import type { FastifyInstance } from "fastify";
import { signedIn, type Auth } from "./auth.ts";
import type { Events } from "./events.ts";
import { Places, PlacesError } from "./places.ts";

/** How often an open event stream gets a comment, so proxies and phones don't take it for dead. */
const HEARTBEAT_MS = 25_000;

/**
 * Places and events (docs/SERVER.md, sections 7 and 10):
 *
 * - `GET /api/places?after=`: your records from every device, newer than
 *   the cursor; never cached, since the cursor does that job.
 * - `POST /api/places`: what this device appended, added to its own log.
 * - `GET /api/events`: a stream of server-sent events: your place moved on
 *   another device, the library changed.
 */
export function placesRoutes(app: FastifyInstance, deps: { auth: Auth; places: Places; events: Events }): void {
  app.get<{ Querystring: { after?: string } }>("/api/places", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    reply.header("cache-control", "no-store");
    return deps.places.since(me.id, request.query.after);
  });

  app.post<{ Body: { device?: { id?: unknown; name?: unknown; app?: unknown }; records?: unknown } }>("/api/places", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    const device = request.body?.device;
    const records = request.body?.records;
    if (!device || typeof device.id !== "string" || !Array.isArray(records)) return reply.code(400).send({ error: "Send the device ({ id, name }) and its records." });
    try {
      const done = await deps.places.append(me.id, { id: device.id, name: typeof device.name === "string" ? device.name : "", ...(typeof device.app === "string" ? { app: device.app } : {}) }, records);
      if (done.accepted > 0) deps.events.toPerson(me.id, { type: "places", data: { device: device.id } });
      return done;
    } catch (e) {
      if (e instanceof PlacesError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get("/api/events", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).send({ error: "Sign in first." });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    raw.write(": connected\n\n");
    const stop = deps.events.listen(me.id, (event) => raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
    const heartbeat = setInterval(() => raw.write(": still here\n\n"), HEARTBEAT_MS);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      stop();
    });
  });
}
