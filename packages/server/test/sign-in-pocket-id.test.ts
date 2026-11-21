import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { challengeOf } from "@ribbon/auth/sign-ins";
import { openAccounts } from "@ribbon/auth-accounts/accounts";
import { fakeIssuer, signInAt, type FakeIssuer } from "../../auth-pocket-id/test/fake-issuer.ts";
import { buildServer, type RibbonServer } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const ANN = { sub: "3f0c9a2e-7d41-4a0b-9c55-1b2e8d6f4a10", preferred_username: "ann", name: "Ann Example", display_name: "Ann", picture: "https://id.example/api/users/3f0c/profile-picture.png", email: "ann@example.com", email_verified: true, groups: ["family"] };
const YUSUF = { sub: "9b1d4c77-0e2a-4f6b-8a13-6c5e2f7d9b02", preferred_username: "yusuf", name: "Yusuf Example", display_name: "", groups: [] };

// A server whose people sign in with Pocket ID (a stand-in for one: packages/auth-pocket-id/test/fake-issuer.ts).
// The apps still talk only to the server.
describe("signing in with Pocket ID", () => {
  let dir: string;
  let issuer: FakeIssuer;
  let server: RibbonServer;
  const config = (): ServerConfig => ({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    url: "https://ribbon.example",
    secret: "a test secret of thirty-two chars!!",
    signIn: { with: "pocket-id", url: issuer.url, clientId: issuer.clientId, clientSecret: issuer.clientSecret },
    admins: ["Ann"],
  });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-pocket-id-"));
    issuer = await fakeIssuer();
    server = await buildServer(config());
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    await issuer.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    issuer.person = ANN;
    issuer.refuses = null;
  });

  const get = (url: string) => server.app.inject({ method: "GET", url });
  const post = (url: string, payload: object, headers: Record<string, string> = {}) => server.app.inject({ method: "POST", url, payload, headers });
  /** Follow a redirect the server answered with out to the issuer and back: the server's answer to the callback. */
  const throughIssuer = async (started: { headers: Record<string, unknown> }) => {
    const { callback } = await signInAt(String(started.headers.location));
    expect(callback.origin + callback.pathname).toBe("https://ribbon.example/sign-in/callback");
    return get(callback.pathname + callback.search);
  };
  /** Sign in as the desktop app does: out through the browser, back to its own address, and the code traded. */
  const signInAsApp = async (verifier = "the app's own secret", device = "Ribbon on Ann's Mac") => {
    const started = await get(`/sign-in/start?return=${encodeURIComponent("http://127.0.0.1:53111/signed-in")}&challenge=${challengeOf(verifier)}`);
    expect(started.statusCode).toBe(302);
    const back = await throughIssuer(started);
    expect(back.statusCode).toBe(302);
    const returned = new URL(String(back.headers.location));
    expect(returned.origin + returned.pathname).toBe("http://127.0.0.1:53111/signed-in");
    return { returned, finish: (withVerifier = verifier) => post("/api/sign-in/finish", { code: returned.searchParams.get("code"), verifier: withVerifier, device }) };
  };

  it("tells an app to open the browser, and what the button should say", async () => {
    expect((await get("/api/sign-in")).json()).toEqual({ kind: "browser", name: "Pocket ID" });
  });

  it("signs an app in through the browser, as who Pocket ID says they are", async () => {
    const { finish } = await signInAsApp();
    const done = await finish();
    expect(done.statusCode).toBe(200);
    const body = done.json() as { token: string; cookie: { name: string; value: string }; user: Record<string, unknown> };
    expect(body.user).toMatchObject({ name: "ann", displayName: "Ann", picture: ANN.picture, role: "admin" });
    const me = await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(body.token) });
    expect(me.json()).toMatchObject({ user: { name: "ann", displayName: "Ann", role: "admin" } });
    expect((await server.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `${body.cookie.name}=${body.cookie.value}` } })).statusCode).toBe(200);
  });

  it("makes someone new a person here on their first sign-in, as a user, and the same person every time after", async () => {
    issuer.person = YUSUF;
    const first = (await (await signInAsApp()).finish()).json() as { user: { id: string; name: string; displayName: string; role: string; picture: string | null } };
    expect(first.user).toMatchObject({ name: "yusuf", displayName: "Yusuf Example", role: "user", picture: null });
    // They change what they're called at Pocket ID: still them, under the new name.
    issuer.person = { ...YUSUF, preferred_username: "yusuf.e", display_name: "Yus" };
    const again = (await (await signInAsApp()).finish()).json() as { user: { id: string; name: string; displayName: string } };
    expect(again.user).toMatchObject({ id: first.user.id, name: "yusuf.e", displayName: "Yus" });
  });

  it("gives the app's code to nobody without the secret the app kept, and only once", async () => {
    const stolen = await signInAsApp();
    expect((await stolen.finish("a guess at the secret")).statusCode).toBe(400);
    expect((await stolen.finish()).statusCode).toBe(400);
    const mine = await signInAsApp();
    expect((await mine.finish()).statusCode).toBe(200);
    expect((await mine.finish()).statusCode).toBe(400);
  });

  it("won't send a sign-in back to an address that isn't the app's", async () => {
    const r = await get(`/sign-in/start?return=${encodeURIComponent("https://elsewhere.example/take")}&challenge=${challengeOf("x")}`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("Start from the app");
  });

  it("sends a phone's sign-in back to the app by its own scheme", async () => {
    const started = await get(`/sign-in/start?return=${encodeURIComponent("ribbon://signed-in")}&challenge=${challengeOf("the phone's secret")}`);
    const back = await throughIssuer(started);
    expect(String(back.headers.location)).toMatch(/^ribbon:\/\/signed-in\?code=/);
  });

  it("tells the waiting app why, when Pocket ID wouldn't sign them in", async () => {
    const started = await get(`/sign-in/start?return=${encodeURIComponent("http://127.0.0.1:53111/signed-in")}&challenge=${challengeOf("x")}`);
    issuer.refuses = "access_denied";
    const back = await throughIssuer(started);
    const returned = new URL(String(back.headers.location));
    expect(returned.searchParams.get("code")).toBeNull();
    expect(returned.searchParams.get("error")).toContain("isn't allowed in here");
  });

  it("answers a callback nobody is waiting on with a page that says to start again", async () => {
    const r = await get("/sign-in/callback?state=never-asked&code=abc");
    expect(r.statusCode).toBe(410);
    expect(r.body).toContain("start again");
  });

  it("signs a TV in from a phone: the code's page leads to Pocket ID, and coming back is the TV's answer", async () => {
    const asked = (await post("/api/sign-in/device", { device: "Ribbon on Living Room" })).json() as { code: string; secret: string };
    const page = await get(`/link?code=${asked.code}`);
    expect(page.body).toContain("Sign in with Pocket ID");
    expect(page.body).not.toContain('type="password"');

    const started = await get(`/sign-in/start?device=${asked.code}`);
    const back = await throughIssuer(started);
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain("Sign in Ribbon on Living Room as Ann?");
    expect(back.body).toContain(asked.code);
    // Arriving signed in is not a yes: the TV still waits.
    expect((await post("/api/sign-in/device/poll", { secret: asked.secret })).statusCode).toBe(202);

    const ticket = /ticket: "([^"]+)"/.exec(back.body)![1]!;
    expect((await post("/api/sign-in/device/confirm", { ticket })).statusCode).toBe(200);
    expect((await post("/api/sign-in/device/confirm", { ticket })).statusCode).toBe(410);

    const answer = await post("/api/sign-in/device/poll", { secret: asked.secret });
    expect(answer.json()).toMatchObject({ user: { name: "ann" } });
  });

  it("doesn't sign a stranger's TV in as someone who only followed a link", async () => {
    // Someone else asks for a code and sends a person, already known to Pocket ID, a link straight past the code's page.
    const theirs = (await post("/api/sign-in/device", { device: "A TV somewhere else" })).json() as { code: string; secret: string };
    const back = await throughIssuer(await get(`/sign-in/start?device=${theirs.code}`));
    expect(back.body).toContain("Only if that code is on a screen in front of you");
    expect((await post("/api/sign-in/device/poll", { secret: theirs.secret })).statusCode).toBe(202);
    expect((await post("/api/sign-in/device/confirm", { ticket: "not the page's ticket" })).statusCode).toBe(410);
    expect((await post("/api/sign-in/device/poll", { secret: theirs.secret })).statusCode).toBe(202);
  });

  it("makes an admin of someone listed by Pocket ID's own id for them, whatever they're called", async () => {
    await server.app.close();
    server.db.close();
    server = await buildServer({ ...config(), admins: [YUSUF.sub] });
    issuer.person = { ...YUSUF, preferred_username: "renamed" };
    const signedIn = (await (await signInAsApp()).finish()).json() as { user: { name: string; role: string } };
    expect(signedIn.user).toMatchObject({ name: "renamed", role: "admin" });
  });

  it("lets the admin sign someone out everywhere, and nobody else", async () => {
    issuer.person = ANN;
    const ann = (await (await signInAsApp()).finish()).json() as { token: string; user: { id: string } };
    issuer.person = YUSUF;
    const yusuf = (await (await signInAsApp()).finish()).json() as { token: string; user: { id: string } };
    // Ann is no admin on this server now (only Yusuf's id is listed), though she was made one earlier and stays one.
    const people = (await server.app.inject({ method: "GET", url: "/api/people", headers: bearer(yusuf.token) })).json() as { people: { id: string }[] };
    expect(people.people.map((person) => person.id)).toContain(ann.user.id);
    expect((await post(`/api/people/${ann.user.id}/sign-out`, {})).statusCode).toBe(401);
    expect((await post(`/api/people/${ann.user.id}/sign-out`, {}, bearer(yusuf.token))).statusCode).toBe(200);
    expect((await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(ann.token) })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(yusuf.token) })).statusCode).toBe(200);
  });

  it("answers an address with a name given twice, rather than falling over", async () => {
    expect((await get("/link?code=a&code=b")).statusCode).toBe(200);
    expect((await get("/sign-in/start?device=a&device=b")).statusCode).toBe(410);
    expect((await get("/sign-in/callback?state=a&state=b")).statusCode).toBe(410);
  });

  it("has no passwords and no invites: Pocket ID's admin lets people in", async () => {
    const old = await post("/api/auth/sign-in/username", { username: "ann", password: "a long password" });
    expect(old.statusCode).toBe(400);
    expect(old.json()).toEqual({ error: "This server signs people in with Pocket ID, not a password. Update Ribbon, then connect again." });
    expect((await post("/api/sign-in/password", { name: "ann", password: "a long password" })).statusCode).toBe(400);

    const admin = ((await (await signInAsApp()).finish()).json() as { token: string }).token;
    const invite = await post("/api/invites", {}, bearer(admin));
    expect(invite.statusCode).toBe(404);
    expect(invite.json()).toEqual({ error: "People join this server through Pocket ID: ask its admin there." });
    expect((await get("/invite/anything")).body).toContain("This invite can't be used");
  });
});

// A server that kept its own accounts changes to Pocket ID. Each person is said to be expected under their
// Pocket ID username (src/link.ts), and their first sign-in there finds everything that was theirs.
describe("changing a server from its own accounts to Pocket ID", () => {
  let dir: string;
  let issuer: FakeIssuer;
  let server: RibbonServer;
  let annId = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-change-"));
    issuer = await fakeIssuer();
    const db = openDatabase(dir);
    const accounts = await openAccounts(db, { url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" });
    annId = (await accounts.signUp("annie", "a long password")).subject;
    db.prepare("INSERT INTO person_goal (person_id, minutes, chosen_at) VALUES (?, 45, 1)").run(annId);
    db.close();
    server = await buildServer({ dataDir: dir, host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!", signIn: { with: "pocket-id", url: issuer.url, clientId: issuer.clientId, clientSecret: issuer.clientSecret } });
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    await issuer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const signIn = async () => {
    const started = await server.app.inject({ method: "GET", url: `/sign-in/start?return=${encodeURIComponent("http://127.0.0.1:53111/")}&challenge=${challengeOf("secret")}` });
    const { callback } = await signInAt(String(started.headers.location));
    const back = await server.app.inject({ method: "GET", url: callback.pathname + callback.search });
    const code = new URL(String(back.headers.location)).searchParams.get("code");
    return (await server.app.inject({ method: "POST", url: "/api/sign-in/finish", payload: { code, verifier: "secret" } })).json() as { token: string; user: { id: string; name: string } };
  };

  it("still has the people who had accounts", () => {
    expect(server.auth.people.all()).toMatchObject([{ id: annId, name: "annie" }]);
  });

  it("can't expect someone who isn't here", () => {
    expect(server.auth.people.expect("nobody", "pocket-id", "ann")).toBe(false);
  });

  it("gives someone expected under a Pocket ID username their own places, though the names differ", async () => {
    expect(server.auth.people.expect("annie", "pocket-id", "Ann")).toBe(true);
    expect(server.auth.people.expected("pocket-id")).toEqual([{ username: "ann", person: "annie" }]);
    issuer.person = ANN;
    const signedIn = await signIn();
    expect(signedIn.user).toMatchObject({ id: annId, name: "ann" });
    const goal = await server.app.inject({ method: "GET", url: "/api/goal", headers: bearer(signedIn.token) });
    expect(goal.json()).toMatchObject({ goal: { minutes: 45 } });
    // Expected once: after that it's Pocket ID's own id for them that finds them.
    expect(server.auth.people.expected("pocket-id")).toEqual([]);
    expect((await signIn()).user.id).toBe(annId);
  });

  it("stops expecting someone after two weeks, so the username isn't left for whoever takes it later", () => {
    const db = server.db;
    expect(server.auth.people.expect("ann", "pocket-id", "left-waiting")).toBe(true);
    db.prepare("UPDATE person_link SET created_at = created_at - ? WHERE username = 'left-waiting'").run(15 * 86_400_000);
    expect(server.auth.people.expected("pocket-id")).toEqual([]);
  });

  it("makes someone nobody was expecting a new person, with nothing of anyone else's", async () => {
    issuer.person = YUSUF;
    const signedIn = await signIn();
    expect(signedIn.user.id).not.toBe(annId);
    expect(server.auth.people.all().map((person) => person.name)).toEqual(["ann", "yusuf"]);
  });
});
