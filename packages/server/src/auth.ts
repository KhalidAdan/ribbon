import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { Identity, IdentityProvider } from "@ribbon/auth/identity";
import { Sessions, tokenFrom } from "@ribbon/auth/sessions";
import { ACCOUNTS, accountsKept, openAccounts, sessionsKept, type Accounts } from "@ribbon/auth-accounts/accounts";
import { pocketId } from "@ribbon/auth-pocket-id/pocket-id";
import type { ServerConfig } from "./config.ts";
import type { Role } from "./invites.ts";

/**
 * Who's who on this server (docs/SERVER.md, section 6), in three parts
 * that don't know about one another:
 *
 * - a **provider** proves who someone is (`packages/auth`): the accounts
 *   the server keeps itself (`packages/auth-accounts`), or a Pocket ID
 *   instance beside it (`packages/auth-pocket-id`). A server runs one.
 * - **people** are Ribbon's own (`People`, below): a person is whoever a
 *   provider says they are, with a role that's Ribbon's to give. Places,
 *   goals and devices are kept against the person, never the provider.
 * - **sessions** are what devices keep (`Sessions`): a token, good for a
 *   year, the same whichever provider signed its person in.
 *
 * A route asks only `signedIn`, and gets a person or nobody.
 */
export interface Auth {
  provider: IdentityProvider;
  /** The accounts with passwords, when they are this server's provider: invites make them. Null with any other. */
  accounts: Accounts | null;
  people: People;
  sessions: Sessions;
  /** Usernames that are admins whenever they sign in (`ServerConfig.admins`). */
  admins: string[];
}

/** Someone signed in, as a route sees them. */
export interface Person {
  id: string;
  /** What they sign in as. */
  name: string;
  /** What to call them. */
  displayName: string;
  /** Where their picture is, or null. */
  picture: string | null;
  role: string;
}

/**
 * Everything about signing in to this database, made ready: the provider
 * the config chose, and the people and sessions an older server kept in
 * Better Auth's tables brought over to the server's own.
 */
export async function openAuth(db: DatabaseSync, config: ServerConfig): Promise<Auth> {
  const people = new People(db);
  const sessions = new Sessions(db);
  const chosen = config.signIn ?? { with: "accounts" };
  const accounts = chosen.with === "accounts" ? await openAccounts(db, { url: config.url, secret: config.secret }) : null;
  const provider = accounts ?? pocketId(chosen as Exclude<typeof chosen, { with: "accounts" }>);

  // Whichever provider runs now, the people who had accounts are still people here, with what's theirs.
  people.bringOver(accountsKept(db));
  // The devices they were signed in on stay signed in, once: sessions ended since aren't brought back.
  if (!wasDone(db, "sessions")) {
    for (const kept of sessionsKept(db)) sessions.adopt(kept.token, kept.subject, kept.expiresAt);
    markDone(db, "sessions");
  }
  return { provider, accounts, people, sessions, admins: config.admins ?? [] };
}

/** The request's person, from its bearer token or its session cookie, or null. */
export async function signedIn(auth: Auth, request: FastifyRequest): Promise<Person | null> {
  const token = tokenFrom(request.headers);
  const session = token ? auth.sessions.find(token) : null;
  return session ? auth.people.get(session.personId) : null;
}

/**
 * The people of this server. Each is known to a provider by its own id
 * for them (`person_identity`), so what they're called there can change
 * without their places going to someone else.
 */
export class People {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): Person | null {
    const row = this.db.prepare("SELECT id, name, display_name, picture, role FROM person WHERE id = ?").get(id);
    return row ? personOf(row) : null;
  }

  /** Everyone, in the order they arrived. */
  all(): Person[] {
    return this.db.prepare("SELECT id, name, display_name, picture, role FROM person ORDER BY created_at, name").all().map(personOf);
  }

  count(): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM person").get()?.n ?? 0);
  }

  /**
   * The person a provider's identity is, as of this sign-in.
   *
   * Someone the provider has vouched for before is found by its id for
   * them. Someone new to the provider is the person an admin said to
   * expect under that username (`expect`), when there is one, and
   * otherwise a new person. Either way their name and picture become what
   * the provider says now, and a username on the admins' list is an admin.
   */
  welcome(identity: Identity, admins: readonly string[] = []): Person {
    const known = this.db.prepare("SELECT person_id FROM person_identity WHERE provider = ? AND subject = ?").get(identity.provider, identity.subject);
    const expected = known ? null : this.db.prepare("SELECT person_id FROM person_link WHERE provider = ? AND username = ?").get(identity.provider, identity.username.toLowerCase());
    // A person with an account here keeps the account's id, as they had before people were kept apart from accounts.
    const id = String(known?.person_id ?? expected?.person_id ?? (identity.provider === ACCOUNTS ? identity.subject : randomBytes(16).toString("base64url")));

    this.db.prepare("INSERT OR IGNORE INTO person (id, name, display_name, role, created_at) VALUES (?, ?, ?, 'user', ?)").run(id, identity.username, identity.displayName, this.now());
    this.db.prepare("UPDATE person SET name = ?, display_name = ?, picture = ? WHERE id = ?").run(identity.username, identity.displayName, identity.picture ?? null, id);
    this.db.prepare("INSERT OR IGNORE INTO person_identity (provider, subject, person_id) VALUES (?, ?, ?)").run(identity.provider, identity.subject, id);
    if (expected) this.db.prepare("DELETE FROM person_link WHERE provider = ? AND username = ?").run(identity.provider, identity.username.toLowerCase());
    if (admins.some((name) => name.toLowerCase() === identity.username.toLowerCase())) this.setRole(id, "admin");
    return this.get(id)!;
  }

  setRole(id: string, role: Role): void {
    this.db.prepare("UPDATE person SET role = ? WHERE id = ?").run(role, id);
  }

  /**
   * Say that someone already here will sign in to a provider under this
   * username, before they ever have: their first sign-in there is then
   * theirs. How a server's people keep their places when it changes
   * providers (src/link.ts). False when there's no such person.
   */
  expect(personName: string, provider: string, username: string): boolean {
    const person = this.db.prepare("SELECT id FROM person WHERE lower(name) = lower(?)").get(personName);
    if (!person) return false;
    this.db.prepare("INSERT INTO person_link (provider, username, person_id) VALUES (?, ?, ?) ON CONFLICT (provider, username) DO UPDATE SET person_id = excluded.person_id").run(provider, username.toLowerCase(), String(person.id));
    return true;
  }

  /** Who is expected at a provider, and under what username. */
  expected(provider: string): { username: string; person: string }[] {
    return this.db
      .prepare("SELECT l.username, p.name FROM person_link l JOIN person p ON p.id = l.person_id WHERE l.provider = ? ORDER BY l.username")
      .all(provider)
      .map((row) => ({ username: String(row.username), person: String(row.name) }));
  }

  /**
   * The accounts an older server kept become people here, each with the
   * id, name and role their account had. Ones already here are left as
   * they are. How many were new.
   */
  bringOver(accounts: readonly { subject: string; username: string; displayName: string; role: string }[]): number {
    let brought = 0;
    for (const account of accounts) {
      const made = this.db
        .prepare("INSERT OR IGNORE INTO person (id, name, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(account.subject, account.username, account.displayName, account.role === "admin" ? "admin" : "user", this.now());
      this.db.prepare("INSERT OR IGNORE INTO person_identity (provider, subject, person_id) VALUES (?, ?, ?)").run(ACCOUNTS, account.subject, account.subject);
      brought += Number(made.changes);
    }
    return brought;
  }
}

function personOf(row: Record<string, unknown>): Person {
  return { id: String(row.id), name: String(row.name), displayName: String(row.display_name), picture: row.picture === null ? null : String(row.picture), role: String(row.role) };
}

function wasDone(db: DatabaseSync, what: string): boolean {
  return db.prepare("SELECT 1 FROM brought_over WHERE what = ?").get(what) !== undefined;
}

function markDone(db: DatabaseSync, what: string): void {
  db.prepare("INSERT OR IGNORE INTO brought_over (what, at) VALUES (?, ?)").run(what, Date.now());
}
