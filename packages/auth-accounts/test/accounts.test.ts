import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { SignInRefused } from "@ribbon/auth/identity";
import { AccountRefused, accountsKept, openAccounts, sessionsKept, type Accounts } from "../src/accounts.ts";

const MINUTE = 60_000;
const settings = { url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" };

describe("accounts the server keeps itself", () => {
  let db: DatabaseSync;
  let clock = 0;
  let accounts: Accounts;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    clock = Date.parse("2026-11-21T12:00:00Z");
    accounts = await openAccounts(db, settings, () => clock);
  });

  it("says who a name and password belong to, whatever case the name is typed in", async () => {
    const made = await accounts.signUp("Ann", "a long password");
    expect(made).toMatchObject({ provider: "accounts", username: "ann", displayName: "Ann", groups: [] });
    const found = await accounts.check("ANN", "a long password");
    expect(found).toEqual(made);
  });

  it("says nobody for a wrong password, or a name there's no account for", async () => {
    await accounts.signUp("ann", "a long password");
    expect(await accounts.check("ann", "not the password")).toBeNull();
    expect(await accounts.check("nobody", "a long password")).toBeNull();
  });

  it("makes a name wait after eight wrong tries, and lets it try again ten minutes on", async () => {
    await accounts.signUp("ann", "a long password");
    for (let i = 0; i < 8; i++) expect(await accounts.check("ann", "a guess")).toBeNull();
    await expect(accounts.check("ann", "a long password")).rejects.toThrow(SignInRefused);
    // Someone else's name isn't held up by it.
    await accounts.signUp("yusuf", "another long password");
    expect(await accounts.check("yusuf", "another long password")).not.toBeNull();
    clock += 11 * MINUTE;
    expect(await accounts.check("ann", "a long password")).not.toBeNull();
  });

  it("counts tries sent all at once, each of them", async () => {
    await accounts.signUp("ann", "a long password");
    await Promise.all(Array.from({ length: 8 }, () => accounts.check("ann", "a guess")));
    await expect(accounts.check("ann", "a long password")).rejects.toThrow(SignInRefused);
  });

  it("leaves out someone the older server's admin banned", async () => {
    const ann = await accounts.signUp("ann", "a long password");
    await accounts.signUp("yusuf", "another long password");
    db.exec(`ALTER TABLE "user" ADD COLUMN banned INTEGER`);
    db.prepare(`UPDATE "user" SET banned = 1 WHERE id = ?`).run(ann.subject);
    expect(accountsKept(db).map((account) => account.username)).toEqual(["yusuf"]);
  });

  it("refuses a name that's taken or a password that's too short, in plain words", async () => {
    await accounts.signUp("ann", "a long password");
    await expect(accounts.signUp("Ann", "another long password")).rejects.toMatchObject({ message: "That name is taken. Try another.", taken: true });
    await expect(accounts.signUp("bea", "short")).rejects.toThrow(AccountRefused);
    await expect(accounts.signUp("no spaces allowed", "a long password")).rejects.toMatchObject({ taken: false });
  });

  it("lists every account, for a server bringing its people over", async () => {
    const ann = await accounts.signUp("Ann", "a long password");
    expect(accountsKept(db)).toEqual([{ subject: ann.subject, username: "ann", displayName: "Ann", role: "user" }]);
    expect(accountsKept(new DatabaseSync(":memory:"))).toEqual([]);
  });

  it("lists the sessions an older server kept that haven't run out, with the role its admin plugin kept", async () => {
    const ann = await accounts.signUp("Ann", "a long password");
    // As the server that ran all of Better Auth left them.
    db.exec(`ALTER TABLE "user" ADD COLUMN role TEXT`);
    db.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?`).run(ann.subject);
    const add = db.prepare(`INSERT INTO "session" (id, expiresAt, token, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, '2026-11-21T18:57:11.355Z', '2026-11-21T18:57:11.355Z')`);
    add.run("1", "2027-11-21T18:57:11.355Z", "a token still good", ann.subject);
    add.run("2", "2026-01-01T00:00:00.000Z", "a token run out", ann.subject);

    expect(accountsKept(db)[0]).toMatchObject({ role: "admin" });
    expect(sessionsKept(db, clock)).toEqual([{ token: "a token still good", subject: ann.subject, expiresAt: Date.parse("2027-11-21T18:57:11.355Z") }]);
    expect(sessionsKept(new DatabaseSync(":memory:"), clock)).toEqual([]);
  });
});
