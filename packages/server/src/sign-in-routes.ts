import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SignInRefused } from "@ribbon/auth/identity";
import { sessionCookie, tokenFrom } from "@ribbon/auth/sessions";
import { BrowserSignIns, DeviceSignIns, isAppAddress } from "@ribbon/auth/sign-ins";
import type { Auth, Person } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { approveDevicePage, askForCodePage, deviceSignedInPage, signInFailedPage } from "./sign-in-pages.ts";

/** The schemes Ribbon's own apps answer to, where a browser sign-in may be sent back (the iPhone and iPad apps). */
const APP_SCHEMES = ["ribbon"];

/** How often a device waiting on its code should ask, in seconds. */
const ASK_EVERY = 3;

/**
 * Signing in, as the apps see it. They talk only to this server, never to
 * whatever proves who people are, so an app works the same with either
 * provider. It first asks how this server signs people in:
 *
 *     GET  /api/sign-in                 "password" or "browser"
 *
 * **With a password** (the server's own accounts), the app shows a form:
 *
 *     POST /api/sign-in/password        a name and a password, for a session
 *
 * **Through a browser** (Pocket ID), the app opens a page here in the
 * system browser and waits at an address of its own:
 *
 *     GET  /sign-in/start               sends the browser on to the provider
 *     GET  /sign-in/callback            the provider sends it back; on to the app, with a one-time code
 *     POST /api/sign-in/finish          the app trades the code, and the secret it kept, for a session
 *
 * **A TV**, with either provider, shows a code and someone signs in for it
 * on their phone:
 *
 *     POST /api/sign-in/device          a code to show, and a secret to ask with
 *     GET  /link                        the page the code leads to
 *     POST /api/sign-in/device/approve  a name and a password say the code's device is theirs (accounts)
 *     POST /api/sign-in/device/poll     the TV asks whether it's in yet
 *
 * Every way ends the same: a session (`Sessions`), its token for the app's
 * requests and its cookie for a player that can't send a header.
 *
 * `POST /api/auth/sign-in/username` is how apps from before all this sign
 * in, and still do: the same name and password, answered as they expect.
 */
export function signInRoutes(app: FastifyInstance, deps: { auth: Auth; config: ServerConfig }): void {
  const { auth, config } = deps;
  const { provider } = auth;
  const browserSignIns = new BrowserSignIns();
  const deviceSignIns = new DeviceSignIns();
  const callbackUrl = `${config.url}/sign-in/callback`;
  const secure = config.url.startsWith("https://");

  /** Start a session for someone on a device, and answer with everything an app keeps of it. */
  const signIn = (reply: FastifyReply, person: Person, device: unknown) => {
    const token = auth.sessions.start(person.id, typeof device === "string" ? device.slice(0, 200) : "");
    const cookie = sessionCookie(token, { secure });
    reply.header("set-auth-token", token).header("set-cookie", cookie.header);
    return { token, cookie: { name: cookie.name, value: cookie.value }, user: person };
  };

  /** Who a name and password belong to, as a person here, or the answer that says why not. */
  const byPassword = async (reply: FastifyReply, name: unknown, password: unknown): Promise<Person | null> => {
    if (provider.kind !== "password") {
      await reply.code(400).send({ error: `This server signs people in with ${provider.name}, not a password. Update Ribbon, then connect again.` });
      return null;
    }
    if (typeof name !== "string" || typeof password !== "string" || !name.trim() || !password) {
      await reply.code(400).send({ error: "A name and a password, please." });
      return null;
    }
    try {
      const identity = await provider.check(name, password);
      if (identity) return auth.people.welcome(identity, auth.admins);
      await reply.code(401).send({ error: "That name and password don't match an account on this server." });
    } catch (e) {
      if (!(e instanceof SignInRefused)) throw e;
      await reply.code(e.status).send({ error: e.message });
    }
    return null;
  };

  app.get("/api/sign-in", async () => (provider.kind === "password" ? { kind: "password" } : { kind: "browser", name: provider.name }));

  app.post<{ Body: { name?: unknown; password?: unknown; device?: unknown } }>("/api/sign-in/password", async (request, reply) => {
    const person = await byPassword(reply, request.body?.name, request.body?.password);
    return person ? signIn(reply, person, request.body?.device) : reply;
  });

  // As Better Auth answered it, for the apps that still ask it: the token in a header, and the session's cookie.
  app.post<{ Body: { username?: unknown; password?: unknown } }>("/api/auth/sign-in/username", async (request, reply) => {
    const person = await byPassword(reply, request.body?.username, request.body?.password);
    return person ? signIn(reply, person, request.headers["user-agent"]) : reply;
  });

  // Nobody signs themselves up: with accounts an invite does it (app.ts), and otherwise the provider's own admin.
  app.post("/api/auth/sign-up/email", async (_request, reply) => reply.code(403).send({ error: "Ribbon accounts are by invite. Ask the server's admin for a link." }));

  app.post("/api/sign-out", async (request) => {
    const token = tokenFrom(request.headers);
    if (token) auth.sessions.end(token);
    return { ok: true };
  });

  app.get<{ Querystring: { return?: string; challenge?: string; device?: string } }>("/sign-in/start", async (request, reply) => {
    if (provider.kind !== "browser") return failed(reply, 404, "This server signs people in with a name and a password, in the app itself.");
    const { return: returnTo, challenge, device } = request.query;
    if (device) {
      if (!deviceSignIns.waiting(device)) return failed(reply, 410, "No device is waiting on that code any more. Start again on the device.");
    } else if (!returnTo || !challenge || !isAppAddress(returnTo, APP_SCHEMES)) {
      return failed(reply, 400, "This page is opened by Ribbon when you connect to a server. Start from the app.");
    }
    const state = browserSignIns.ask(device ? { device } : { app: { returnTo: returnTo!, challenge: challenge! } });
    try {
      const { url, memo } = await provider.begin(state, callbackUrl);
      browserSignIns.remember(state, memo);
      return reply.redirect(url.toString());
    } catch (e) {
      return failed(reply, e instanceof SignInRefused ? e.status : 502, e instanceof SignInRefused ? e.message : `${provider.name} couldn't be reached. Try again in a moment.`);
    }
  });

  app.get<{ Querystring: Record<string, string> }>("/sign-in/callback", async (request, reply) => {
    if (provider.kind !== "browser") return failed(reply, 404, "This server signs people in with a name and a password.");
    const waiting = browserSignIns.comeBack(request.query.state ?? "");
    if (!waiting) return failed(reply, 410, "That sign-in took too long, or was already finished. Go back to Ribbon and start again.");
    let person: Person;
    try {
      person = auth.people.welcome(await provider.finish(request.query, callbackUrl, waiting.memo), auth.admins);
    } catch (e) {
      if (!(e instanceof SignInRefused)) throw e;
      // An app is waiting at its own address: tell it, so it can say why and stop waiting.
      if ("app" in waiting.purpose) return reply.redirect(withQuery(waiting.purpose.app.returnTo, { error: e.message }));
      return failed(reply, e.status, e.message);
    }
    if ("app" in waiting.purpose) {
      return reply.redirect(withQuery(waiting.purpose.app.returnTo, { code: browserSignIns.codeFor(person.id, waiting.purpose.app.challenge) }));
    }
    const device = deviceSignIns.waiting(waiting.purpose.device);
    if (!device || !deviceSignIns.approve(waiting.purpose.device, person.id)) return failed(reply, 410, "No device is waiting on that code any more. Start again on the device.");
    return page(reply, deviceSignedInPage({ device: device.device, person: person.displayName }));
  });

  app.post<{ Body: { code?: unknown; verifier?: unknown; device?: unknown } }>("/api/sign-in/finish", async (request, reply) => {
    const { code, verifier } = request.body ?? {};
    const personId = typeof code === "string" && typeof verifier === "string" ? browserSignIns.redeem(code, verifier) : null;
    const person = personId ? auth.people.get(personId) : null;
    if (!person) return reply.code(400).send({ error: "That sign-in took too long, or was already finished. Try again." });
    return signIn(reply, person, request.body?.device);
  });

  app.post<{ Body: { device?: unknown } }>("/api/sign-in/device", async (request) => {
    const device = typeof request.body?.device === "string" ? request.body.device.slice(0, 200) : "";
    const asked = deviceSignIns.ask(device);
    return { code: asked.code, secret: asked.secret, url: `${config.url}/link`, complete: `${config.url}/link?code=${asked.code}`, expiresIn: asked.expiresIn, interval: ASK_EVERY };
  });

  app.get<{ Querystring: { code?: string } }>("/link", async (request, reply) => {
    const code = request.query.code?.trim();
    if (!code) return page(reply, askForCodePage());
    const device = deviceSignIns.waiting(code);
    if (!device) return page(reply, askForCodePage("No device is showing that code now. Check it, or start again on the device."));
    return page(reply, approveDevicePage({ code, device: device.device, signIn: provider.kind === "password" ? { kind: "password" } : { kind: "browser", name: provider.name } }));
  });

  app.post<{ Body: { code?: unknown; name?: unknown; password?: unknown } }>("/api/sign-in/device/approve", async (request, reply) => {
    const code = typeof request.body?.code === "string" ? request.body.code : "";
    if (!deviceSignIns.waiting(code)) return reply.code(410).send({ error: "No device is waiting on that code any more. Start again on the device." });
    const person = await byPassword(reply, request.body?.name, request.body?.password);
    if (!person) return reply;
    if (!deviceSignIns.approve(code, person.id)) return reply.code(410).send({ error: "No device is waiting on that code any more. Start again on the device." });
    return { ok: true };
  });

  app.post<{ Body: { secret?: unknown } }>("/api/sign-in/device/poll", async (request, reply) => {
    const answer = deviceSignIns.answer(typeof request.body?.secret === "string" ? request.body.secret : "");
    if (answer === "waiting") return reply.code(202).send({ waiting: true });
    const person = answer === "gone" ? null : auth.people.get(answer.personId);
    if (answer === "gone" || !person) return reply.code(410).send({ error: "That code has run out. Start again." });
    return signIn(reply, person, answer.device);
  });
}

/** Routes that carry a password in their body: they're refused over plain HTTP from another machine (app.ts). */
export function sendsPassword(url: string): boolean {
  const pathname = url.split("?")[0]!;
  return pathname.startsWith("/api/auth/") || pathname === "/api/sign-in/password" || pathname === "/api/sign-in/device/approve" || /^\/api\/invites\/[^/]+\/accept$/.test(pathname);
}

function page(reply: FastifyReply, html: string): FastifyReply {
  return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(html);
}

function failed(reply: FastifyReply, status: number, why: string): FastifyReply {
  return page(reply.code(status), signInFailedPage(why));
}

/** An address with these added to its query, whatever kind of address it is (`ribbon://signed-in` too). */
function withQuery(address: string, add: Record<string, string>): string {
  const url = new URL(address);
  for (const [name, value] of Object.entries(add)) url.searchParams.set(name, value);
  return url.toString();
}

/** Whether a request came in over HTTPS, or from this machine: where a password may travel (app.ts). */
export function isSecure(request: FastifyRequest): boolean {
  return request.protocol === "https" || ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip);
}
