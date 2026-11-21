import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { username } from "better-auth/plugins";
import type { DatabaseSync } from "node:sqlite";
import { SignInRefused, type Identity, type PasswordProvider } from "@ribbon/auth/identity";

/** This provider's name, as identities carry it. */
export const ACCOUNTS = "accounts";

/**
 * Accounts the server keeps itself: a name and a password each, in its own
 * database. The provider for a server with nothing else beside it.
 *
 * The accounts are [Better Auth](https://better-auth.com)'s: its tables
 * (`user`, `account`), its rules for a name, and its password hashing
 * (scrypt). Only that much of it is used. Sessions are not its business
 * here: whoever calls `check` starts their own (`@ribbon/auth/sessions`).
 */
export interface Accounts extends PasswordProvider {
  /** Make an account. Throws `AccountRefused` when the name or the password won't do. */
  signUp(name: string, password: string): Promise<Identity>;
}

/** An account that couldn't be made, in words to show, and whether the name being taken was why. */
export class AccountRefused extends Error {
  constructor(
    message: string,
    readonly taken: boolean,
  ) {
    super(message);
    this.name = "AccountRefused";
  }
}

/** Wrong tries at one name before it has to wait, and for how long. Guessing a password this way takes years. */
const TRIES = 8;
const WAIT_MS = 10 * 60_000;

/** The accounts in this database, their tables made or brought up to date first. */
export async function openAccounts(db: DatabaseSync, settings: { url: string; secret: string }, now: () => number = Date.now): Promise<Accounts> {
  const options = {
    database: db,
    baseURL: settings.url,
    secret: settings.secret,
    // No session of Better Auth's own on signing up: the caller starts one.
    emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: false },
    plugins: [username()],
  } satisfies BetterAuthOptions;
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  const wrong = new Map<string, { tries: number; since: number }>();
  // Checked against when there's no such name, so a wrong name takes as long to refuse as a wrong password.
  const nobody = await hashPassword("nobody signs in with this");

  return {
    kind: "password",
    id: ACCOUNTS,

    async check(name, password) {
      const key = name.trim().toLowerCase();
      const since = now();
      // Names that waited out their ten minutes are let go, so the list is only ever of names tried lately.
      for (const [tried, at] of wrong) if (since - at.since >= WAIT_MS) wrong.delete(tried);
      const before = wrong.get(key);
      if (before && before.tries >= TRIES) throw new SignInRefused("Too many wrong tries at that name. Wait ten minutes, then try again.", 429);
      // Counted before the password is looked at, so tries sent all at once are each counted. A right one clears it.
      wrong.set(key, { tries: (before?.tries ?? 0) + 1, since: before?.since ?? since });

      const row = db
        .prepare(`SELECT u.id, u.username, u.displayUsername, u.name, a.password FROM "user" u JOIN account a ON a.userId = u.id AND a.providerId = 'credential' WHERE u.username = ?`)
        .get(key);
      const right = await verifyPassword({ hash: String(row?.password ?? nobody), password });
      if (!row || !right) return null;
      wrong.delete(key);
      return identityOf({ id: String(row.id), username: String(row.username), shown: String(row.displayUsername ?? row.name) });
    },

    async signUp(name, password) {
      try {
        const made = await auth.api.signUpEmail({ body: { email: placeholderEmail(name), name, username: name, password } });
        return identityOf({ id: made.user.id, username: name.toLowerCase(), shown: name });
      } catch (e) {
        if (e instanceof APIError) throw inOurWords(e);
        throw e;
      }
    },
  };
}

/** An account as the server's database has it from before sign-in was a provider's business. */
export interface KeptAccount {
  subject: string;
  username: string;
  displayName: string;
  /** What Better Auth's admin plugin kept on the account: "admin" or "user". */
  role: string;
}

/**
 * Every account in a database, read straight from Better Auth's table:
 * for a server bringing the people it already has over to its own table.
 * None when there has never been an account.
 */
export function accountsKept(db: DatabaseSync): KeptAccount[] {
  const columns = columnsOf(db, "user");
  if (columns.length === 0) return [];
  const role = columns.includes("role") ? "role" : "NULL";
  // Someone the older server's admin banned isn't brought over, nor their sessions.
  const allowed = columns.includes("banned") ? "AND (banned IS NULL OR banned = 0)" : "";
  return db
    .prepare(`SELECT id, username, displayUsername, name, ${role} AS role FROM "user" WHERE username IS NOT NULL ${allowed}`)
    .all()
    .map((row) => ({ subject: String(row.id), username: String(row.username), displayName: String(row.displayUsername ?? row.name), role: String(row.role ?? "user") }));
}

/** A session Better Auth started, when it kept them: the token a device still holds, whose it is, and when it ends. */
export interface KeptSession {
  token: string;
  subject: string;
  expiresAt: number;
}

/** Every session Better Auth kept that hasn't run out, for a server taking them into its own (`Sessions.adopt`). */
export function sessionsKept(db: DatabaseSync, now = Date.now()): KeptSession[] {
  if (columnsOf(db, "session").length === 0) return [];
  return db
    .prepare(`SELECT token, userId, expiresAt FROM "session"`)
    .all()
    .map((row) => ({ token: String(row.token), subject: String(row.userId), expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : Date.parse(String(row.expiresAt)) }))
    .filter((session) => session.expiresAt > now);
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((column) => String(column.name));
}

function identityOf(account: { id: string; username: string; shown: string }): Identity {
  return { provider: ACCOUNTS, subject: account.id, username: account.username, displayName: account.shown, groups: [], claims: {} };
}

/**
 * Better Auth keeps an email for every account; these people have only a
 * name. This one is never sent anything: `.invalid` is reserved for
 * addresses that can't exist.
 */
function placeholderEmail(name: string): string {
  return `${name.toLowerCase()}@people.ribbon.invalid`;
}

/** Better Auth's reasons for refusing a sign-up, said plainly. */
function inOurWords(e: APIError): AccountRefused {
  const message = e.body?.message ?? e.message;
  if (/taken|already exists/i.test(message)) return new AccountRefused("That name is taken. Try another.", true);
  if (/username.*(invalid|short|long)|invalid username/i.test(message)) return new AccountRefused("A name is 3 to 30 letters, numbers, dots and underscores.", false);
  if (/password.*short/i.test(message)) return new AccountRefused("The password needs at least 8 characters.", false);
  return new AccountRefused(message, false);
}
