import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;

/** A session found for a request: whose it is, and which device it was started for. */
export interface Session {
  personId: string;
  device: string;
}

/**
 * The sessions people's devices keep, whichever provider signed them in.
 *
 * Signing in on a device starts one and hands the device a token: a long
 * random secret it sends with every request, in a header or a cookie
 * (`tokenFrom`). Only the token's hash is kept here, so reading the
 * database doesn't sign anyone in.
 *
 * A session lasts a year, and every day it's used pushes that out again: a
 * phone that's opened shouldn't ask anyone to sign in.
 */
export class Sessions {
  private readonly lifeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    opts: { days?: number; now?: () => number } = {},
  ) {
    this.lifeMs = (opts.days ?? 365) * DAY_MS;
    this.now = opts.now ?? Date.now;
    db.exec(`
CREATE TABLE IF NOT EXISTS device_session (
  token_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  -- What the device calls itself, for a list of someone's devices.
  device TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_session_by_person ON device_session (person_id);`);
  }

  /** Start a session for someone on a device. The token is the device's to keep; it can't be read back from here. */
  start(personId: string, device = ""): string {
    const token = randomBytes(32).toString("base64url");
    this.keep(token, personId, device, this.now() + this.lifeMs);
    return token;
  }

  /**
   * Keep a session whose token was made elsewhere, until `expiresAt`:
   * how the sessions an older server handed out go on working. One
   * already kept is left as it is.
   */
  adopt(token: string, personId: string, expiresAt: number): void {
    this.keep(token, personId, "", expiresAt);
  }

  /** Whose session this token is, or null when there's none or its time has passed. */
  find(token: string): Session | null {
    const hash = hashOf(token);
    const row = this.db.prepare("SELECT person_id, device, expires_at FROM device_session WHERE token_hash = ?").get(hash);
    if (!row) return null;
    const now = this.now();
    if (Number(row.expires_at) <= now) {
      this.db.prepare("DELETE FROM device_session WHERE token_hash = ?").run(hash);
      return null;
    }
    // Used today: good for another year from now. Written once a day at most, not on every request.
    if (Number(row.expires_at) < now + this.lifeMs - DAY_MS) this.db.prepare("UPDATE device_session SET expires_at = ? WHERE token_hash = ?").run(now + this.lifeMs, hash);
    return { personId: String(row.person_id), device: String(row.device) };
  }

  /** Sign this device out. */
  end(token: string): void {
    this.db.prepare("DELETE FROM device_session WHERE token_hash = ?").run(hashOf(token));
  }

  /** Sign someone out everywhere. */
  endAll(personId: string): void {
    this.db.prepare("DELETE FROM device_session WHERE person_id = ?").run(personId);
  }

  private keep(token: string, personId: string, device: string, expiresAt: number): void {
    this.db.prepare("INSERT OR IGNORE INTO device_session (token_hash, person_id, device, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(hashOf(token), personId, device, this.now(), expiresAt);
  }
}

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** What a session's cookie is called. A player that can't send a header sends this instead. */
const COOKIE = "ribbon.session_token";

/**
 * The token a request carries: in its `authorization` header as a bearer,
 * or else in a cookie whose name ends `session_token`.
 *
 * Tokens from the server that Better Auth ran came signed, as
 * `<token>.<signature>`, and a cookie's value arrives percent-encoded. The
 * token itself is the part before the dot, and it alone is looked up: it is
 * a long random secret, so a signature adds nothing to it. Tokens made here
 * have no dot in them.
 */
export function tokenFrom(headers: { authorization?: string | undefined; cookie?: string | undefined }): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "")?.[1];
  const presented = bearer ?? cookieEnding("session_token", headers.cookie ?? "");
  if (!presented) return null;
  return decoded(presented.trim()).split(".")[0] || null;
}

/** The `Set-Cookie` header that gives a browser or a player this session. Secure whenever the server is reached over HTTPS. */
export function sessionCookie(token: string, opts: { secure: boolean; days?: number }): { name: string; value: string; header: string } {
  const name = opts.secure ? `__Secure-${COOKIE}` : COOKIE;
  const header = `${name}=${token}; Max-Age=${(opts.days ?? 365) * 86_400}; Path=/; HttpOnly; SameSite=Lax${opts.secure ? "; Secure" : ""}`;
  return { name, value: token, header };
}

function cookieEnding(suffix: string, header: string): string | null {
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim().endsWith(suffix)) return part.slice(at + 1);
  }
  return null;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
