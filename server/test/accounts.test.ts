import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type RibbonServer } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";

// The whole accounts story on a fresh server: the first invite makes the
// admin, the admin invites a brother, and nobody gets in another way.
describe("accounts", () => {
  let dir: string;
  let server: RibbonServer;
  const config = (): ServerConfig => ({ dataDir: dir, host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-server-"));
    server = await buildServer(config());
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") => server.app.inject({ method: "POST", url, payload: payload as object, headers, remoteAddress });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  let adminToken = "";
  let brotherCode = "";

  it("makes the admin from the first invite", async () => {
    const first = server.invites.firstAdmin();
    expect(server.invites.firstAdmin().code).toBe(first.code); // the same one on every start, until spent
    const page = await server.app.inject({ method: "GET", url: `/invite/${first.code}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Join this Ribbon library");

    const joined = await post(`/api/invites/${first.code}/accept`, { name: "Ann", password: "a long password" });
    expect(joined.statusCode).toBe(200);
    const body = joined.json() as { token: string; user: { name: string; role: string } };
    expect(body.user).toMatchObject({ name: "Ann", role: "admin" });
    expect(body.token).toBeTruthy();
    adminToken = body.token;

    const me = await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(adminToken) });
    expect(me.json()).toMatchObject({ user: { name: "ann", role: "admin" } });
  });

  it("spends an invite once", async () => {
    const { code } = (await post("/api/invites", {}, bearer(adminToken))).json() as { code: string };
    expect((await post(`/api/invites/${code}/accept`, { name: "someone", password: "a long password" })).statusCode).toBe(200);
    const twice = await post(`/api/invites/${code}/accept`, { name: "someone_else", password: "a long password" });
    expect(twice.statusCode).toBe(410);
    const page = await server.app.inject({ method: "GET", url: `/invite/${code}` });
    expect(page.body).toContain("This invite can't be used");
    expect((await server.app.inject({ method: "GET", url: "/invite/not-a-code" })).body).toContain("This invite can't be used");
  });

  it("lets the admin invite a brother, who signs in by name", async () => {
    const made = await post("/api/invites", {}, bearer(adminToken));
    expect(made.statusCode).toBe(200);
    const invite = made.json() as { code: string; url: string };
    expect(invite.url).toBe(`https://ribbon.example/invite/${invite.code}`);
    brotherCode = invite.code;

    const joined = await post(`/api/invites/${brotherCode}/accept`, { name: "Yusuf", password: "another long password" });
    expect(joined.json()).toMatchObject({ user: { name: "Yusuf", role: "user" } });

    const signIn = await post("/api/auth/sign-in/username", { username: "yusuf", password: "another long password" });
    expect(signIn.statusCode).toBe(200);
    const token = signIn.headers["set-auth-token"];
    expect(typeof token).toBe("string");
    const me = await server.app.inject({ method: "GET", url: "/api/me", headers: bearer(token as string) });
    expect(me.json()).toMatchObject({ user: { name: "yusuf", role: "user" } });

    // A user can't invite anyone.
    const refused = await post("/api/invites", {}, bearer(token as string));
    expect(refused.statusCode).toBe(403);
  });

  it("gives a code back when the name is taken", async () => {
    const made = (await post("/api/invites", {}, bearer(adminToken))).json() as { code: string };
    const taken = await post(`/api/invites/${made.code}/accept`, { name: "yusuf", password: "a long password" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "That name is taken. Try another." });
    expect(server.invites.usable(made.code)).toBe(true);
  });

  it("closes sign-up to anyone without an invite", async () => {
    const r = await post("/api/auth/sign-up/email", { email: "x@example.com", name: "x", username: "intruder", password: "a long password" });
    expect(r.statusCode).toBe(403);
    const wrong = await post("/api/auth/sign-in/username", { username: "yusuf", password: "not the password" });
    expect(wrong.statusCode).toBe(401);
    const nobody = await server.app.inject({ method: "GET", url: "/api/me" });
    expect(nobody.statusCode).toBe(401);
  });

  it("only takes passwords over HTTPS or from this machine", async () => {
    // Straight from another machine, in plain HTTP: refused.
    const plain = await post("/api/auth/sign-in/username", { username: "yusuf", password: "another long password" }, {}, "100.64.0.5");
    expect(plain.statusCode).toBe(403);
    // Through a proxy on this machine that took it over HTTPS: fine.
    const proxied = await post("/api/auth/sign-in/username", { username: "yusuf", password: "another long password" }, { "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.5" });
    expect(proxied.statusCode).toBe(200);
    // A request from elsewhere claiming HTTPS itself isn't believed.
    const claimed = await post("/api/auth/sign-in/username", { username: "yusuf", password: "another long password" }, { "x-forwarded-proto": "https" }, "100.64.0.5");
    expect(claimed.statusCode).toBe(403);
  });
});

describe("the apps' origins", () => {
  let dir: string;
  let server: RibbonServer;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-origins-"));
    server = await buildServer({ dataDir: dir, host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" });
    await server.app.inject({ method: "POST", url: `/api/invites/${server.invites.firstAdmin().code}/accept`, payload: { name: "ann", password: "a long password" } });
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets the desktop and phone apps call the API from their own origin", async () => {
    const preflight = await server.app.inject({ method: "OPTIONS", url: "/api/books", headers: { origin: "tauri://localhost", "access-control-request-method": "GET", "access-control-request-headers": "authorization,if-none-match" } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    expect(String(preflight.headers["access-control-allow-headers"])).toContain("if-none-match");
    const signIn = await server.app.inject({ method: "POST", url: "/api/auth/sign-in/username", headers: { origin: "tauri://localhost" }, payload: { username: "ann", password: "a long password" } });
    expect(signIn.statusCode).toBe(200);
    expect(String(signIn.headers["access-control-expose-headers"])).toContain("set-auth-token");
  });
});
