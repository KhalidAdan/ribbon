import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openAccounts } from "@ribbon/auth-accounts/accounts";
import { buildServer, type RibbonServer } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { serverWithAdmin } from "./fixture.ts";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// Signing in to a server that keeps its own accounts, as the apps do it now (docs/SERVER.md, section 6).
describe("signing in with a name and a password", () => {
  let dir: string;
  let server: RibbonServer;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-sign-in-"));
    ({ server } = await serverWithAdmin(dir));
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: object, headers: Record<string, string> = {}) => server.app.inject({ method: "POST", url, payload, headers });
  const me = async (headers: Record<string, string>) => (await server.app.inject({ method: "GET", url: "/api/me", headers })).json() as { user?: { name: string; role: string }; error?: string };

  it("tells an app to show a form", async () => {
    expect((await server.app.inject({ method: "GET", url: "/api/sign-in" })).json()).toEqual({ kind: "password" });
  });

  it("gives a session: a token for the app's requests, and a cookie for a player that can't send a header", async () => {
    const r = await post("/api/sign-in/password", { name: "Admin", password: "a long password", device: "Ribbon on Ann's iPhone" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { token: string; cookie: { name: string; value: string }; user: { name: string; displayName: string; role: string } };
    expect(body.user).toMatchObject({ name: "admin", displayName: "admin", role: "admin" });
    expect(await me(bearer(body.token))).toMatchObject({ user: { name: "admin" } });
    expect(body.cookie.name).toBe("__Secure-ribbon.session_token");
    expect(await me({ cookie: `${body.cookie.name}=${body.cookie.value}` })).toMatchObject({ user: { name: "admin" } });
    expect(String(r.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("refuses a wrong password, and a request with half of what it needs", async () => {
    expect((await post("/api/sign-in/password", { name: "admin", password: "not the password" })).statusCode).toBe(401);
    expect((await post("/api/sign-in/password", { name: "admin" })).statusCode).toBe(400);
  });

  it("signs one device out, and leaves the others in", async () => {
    const phone = ((await post("/api/sign-in/password", { name: "admin", password: "a long password" })).json() as { token: string }).token;
    const tv = ((await post("/api/sign-in/password", { name: "admin", password: "a long password" })).json() as { token: string }).token;
    await post("/api/sign-out", {}, bearer(phone));
    expect((await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(phone) })).statusCode).toBe(401);
    expect(await me(bearer(tv))).toMatchObject({ user: { name: "admin" } });
  });

  it("has no browser sign-in to start", async () => {
    const r = await server.app.inject({ method: "GET", url: "/sign-in/start?return=http://127.0.0.1:5000/&challenge=abc" });
    expect(r.statusCode).toBe(404);
  });

  it("signs a TV in from a phone: the TV shows a code, and a name and password on the code's page are its answer", async () => {
    const asked = (await post("/api/sign-in/device", { device: "Ribbon on Living Room" })).json() as { code: string; secret: string; url: string; complete: string; interval: number };
    expect(asked.url).toBe("https://ribbon.example/link");
    expect(asked.complete).toBe(`https://ribbon.example/link?code=${asked.code}`);
    expect((await post("/api/sign-in/device/poll", { secret: asked.secret })).statusCode).toBe(202);

    const page = await server.app.inject({ method: "GET", url: `/link?code=${asked.code}` });
    expect(page.body).toContain("Sign in Ribbon on Living Room");
    expect(page.body).toContain(asked.code);
    expect(page.body).toContain('type="password"');

    expect((await post("/api/sign-in/device/approve", { code: asked.code, name: "admin", password: "wrong" })).statusCode).toBe(401);
    expect((await post("/api/sign-in/device/approve", { code: asked.code, name: "admin", password: "a long password" })).statusCode).toBe(200);

    const answer = await post("/api/sign-in/device/poll", { secret: asked.secret });
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as { token: string; cookie: { name: string }; user: { name: string } };
    expect(body.user.name).toBe("admin");
    expect(await me(bearer(body.token))).toMatchObject({ user: { name: "admin" } });
    // Told once: the secret is no use after.
    expect((await post("/api/sign-in/device/poll", { secret: asked.secret })).statusCode).toBe(410);
  });

  it("asks for the code again when nothing is showing it", async () => {
    expect((await server.app.inject({ method: "GET", url: "/link" })).body).toContain("Type the code your TV is showing");
    expect((await server.app.inject({ method: "GET", url: "/link?code=BBBB-BBBB" })).body).toContain("No device is showing that code now");
    expect((await post("/api/sign-in/device/approve", { code: "BBBB-BBBB", name: "admin", password: "a long password" })).statusCode).toBe(410);
  });
});

// A server from before sign-in was a provider's business kept its people and their sessions in Better Auth's
// tables. Starting the new server on that database, nobody notices.
describe("a database from the server that Better Auth ran", () => {
  let dir: string;
  let server: RibbonServer;
  let annId = "";
  const config = (): ServerConfig => ({ dataDir: dir, host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" });
  // A session's token as that server handed it to a device: the token, a dot, and a signature.
  const signed = "SC6MbLu0aajSPUaDeRvq2wIdnVSgJVwY.IBq9r1bUzzy0UVLGGEZbsDVMxiVp73PX77lQbyLjlVI=";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-older-"));
    const db = openDatabase(dir);
    const accounts = await openAccounts(db, { url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" });
    annId = (await accounts.signUp("Ann", "a long password")).subject;
    await accounts.signUp("yusuf", "another long password");
    db.exec(`ALTER TABLE "user" ADD COLUMN role TEXT`);
    db.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?`).run(annId);
    db.prepare(`INSERT INTO "session" (id, expiresAt, token, userId, createdAt, updatedAt) VALUES ('1', '2099-01-01T00:00:00.000Z', 'SC6MbLu0aajSPUaDeRvq2wIdnVSgJVwY', ?, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')`).run(annId);
    // Places are kept against the account's id.
    db.prepare("INSERT INTO person_goal (person_id, minutes, chosen_at) VALUES (?, 45, 1)").run(annId);
    db.close();
    server = await buildServer(config());
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a phone signed in with the token it already has, in its header", async () => {
    const r = await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(signed) });
    expect(r.json()).toMatchObject({ user: { id: annId, name: "ann", displayName: "Ann", role: "admin" } });
  });

  it("keeps a TV's player signed in with the cookie it already has", async () => {
    const r = await server.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `__Secure-better-auth.session_token=${encodeURIComponent(signed)}` } });
    expect(r.json()).toMatchObject({ user: { name: "ann" } });
  });

  it("leaves what was theirs with them", async () => {
    const r = await server.app.inject({ method: "GET", url: "/api/goal", headers: bearer(signed) });
    expect(r.json()).toMatchObject({ goal: { minutes: 45 } });
  });

  it("signs an app from before in the way it asks to be, with their old password", async () => {
    const r = await server.app.inject({ method: "POST", url: "/api/auth/sign-in/username", payload: { username: "yusuf", password: "another long password" } });
    expect(r.statusCode).toBe(200);
    expect(typeof r.headers["set-auth-token"]).toBe("string");
    expect(String(r.headers["set-cookie"])).toContain("session_token=");
    const me = await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(String(r.headers["set-auth-token"])) });
    expect(me.json()).toMatchObject({ user: { name: "yusuf", role: "user" } });
  });

  it("doesn't bring back a session that was ended since, the next time it starts", async () => {
    await server.app.inject({ method: "POST", url: "/api/sign-out", headers: bearer(signed) });
    await server.app.close();
    server.db.close();
    server = await buildServer(config());
    expect((await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(signed) })).statusCode).toBe(401);
    expect(server.auth.people.all().map((person) => person.name)).toEqual(["ann", "yusuf"]);
  });
});
