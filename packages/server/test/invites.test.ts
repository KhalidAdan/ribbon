import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { Invites } from "../src/invites.ts";
import { serverWithAdmin } from "./fixture.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * An invite is good once, for a few days (docs/SERVER.md, section 6). A
 * sign-up holds it while the account is made, so two people can't spend it
 * at once, spends it when the account exists, and gives it back when the
 * sign-up fails.
 */
describe("an invite", () => {
  let dir: string;
  let db: DatabaseSync;
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-invites-"));
    db = openDatabase(dir);
    clock = Date.parse("2026-11-10T12:00:00Z");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const usedBy = (code: string) => db.prepare("SELECT used_by FROM invite WHERE code = ?").get(code)?.used_by ?? null;

  it("held by a sign-up still under way isn't given to anyone else, however long the sign-up takes", () => {
    const invites = new Invites(db, now);
    const { code } = invites.create("user", null);
    expect(invites.reserve(code)).toBe("user");
    clock += 6 * MINUTE;
    expect(invites.usable(code)).toBe(false);
    expect(invites.reserve(code)).toBeNull();
  });

  it("is spent once, by the sign-up that held it", () => {
    const invites = new Invites(db, now);
    const { code } = invites.create("user", null);
    invites.reserve(code);
    invites.spend(code, "ann");
    invites.spend(code, "bea");
    expect(usedBy(code)).toBe("ann");
  });

  it("can't be spent without being held first", () => {
    const invites = new Invites(db, now);
    const { code } = invites.create("user", null);
    invites.spend(code, "ann");
    expect(usedBy(code)).toBeNull();
    expect(invites.usable(code)).toBe(true);
  });

  it("given back by a sign-up that failed is good again; a spent one isn't", () => {
    const invites = new Invites(db, now);
    const { code } = invites.create("user", null);
    invites.reserve(code);
    invites.release(code);
    expect(invites.usable(code)).toBe(true);
    invites.reserve(code);
    invites.spend(code, "ann");
    invites.release(code);
    expect(invites.usable(code)).toBe(false);
    expect(usedBy(code)).toBe("ann");
  });

  it("held when the server stopped mid sign-up is good again when it starts", () => {
    const { code } = new Invites(db, now).create("user", null);
    new Invites(db, now).reserve(code);
    // The server starts again a moment later.
    clock += 1000;
    expect(new Invites(db, now).usable(code)).toBe(true);
  });

  it("expires after its days, but a sign-up that held it in time still spends it", () => {
    const invites = new Invites(db, now);
    const late = invites.create("user", null, 1).code;
    const held = invites.create("user", null, 1).code;
    clock += DAY - MINUTE;
    invites.reserve(held);
    clock += 2 * MINUTE;
    expect(invites.usable(late)).toBe(false);
    expect(invites.reserve(late)).toBeNull();
    invites.spend(held, "ann");
    expect(usedBy(held)).toBe("ann");
  });
});

/** The same, through the server: one invite makes one account, however slow a sign-up is. */
describe("an invite on the server", () => {
  let dir: string;
  let server: RibbonServer;
  let admin = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-invite-route-"));
    ({ server, admin } = await serverWithAdmin(dir));
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("can't be taken by a second person while the first is still signing up with it", async () => {
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    // Someone's sign-up has held the code for six minutes, and is still under way.
    expect(server.invites.reserve(code)).toBe("user");
    server.db.prepare("UPDATE invite SET reserved_at = reserved_at - ? WHERE code = ?").run(6 * MINUTE, code);
    const second = await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "second", password: "a long password" }, remoteAddress: "127.0.0.1" });
    expect(second.statusCode).toBe(410);
  });
});
