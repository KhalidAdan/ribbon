import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** What an account may do: an admin invites people and manages the server; a user listens and reads. Better Auth's admin plugin uses the same two names. */
export type Role = "admin" | "user";

export interface Invite {
  code: string;
  role: Role;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

const DAY_MS = 86_400_000;
/** A code held by a sign-up that never finished (the server stopped mid-way) is free again after this. */
const RESERVED_MS = 5 * 60_000;

/**
 * Invites, the one way into a Ribbon server (docs/SERVER.md, section 6).
 * The admin makes one; it is a code that is good once, for a few days.
 * Signing up holds the code first, so two people can't spend the same one
 * at once, and spends it when the account exists; a sign-up that fails
 * (a name already taken) gives it back.
 */
export class Invites {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  create(role: Role, createdBy: string | null, days = 7): Invite {
    const code = randomBytes(18).toString("base64url");
    const at = this.now();
    const expiresAt = at + days * DAY_MS;
    this.db.prepare("INSERT INTO invite (code, role, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?)").run(code, role, at, expiresAt, createdBy);
    return { code, role, expiresAt };
  }

  /** Whether the code can be used now: known, not spent, not held by a sign-up in progress, not expired. */
  usable(code: string): boolean {
    const at = this.now();
    return !!this.db.prepare("SELECT 1 FROM invite WHERE code = ? AND used_at IS NULL AND (reserved_at IS NULL OR reserved_at < ?) AND expires_at > ?").get(code, at - RESERVED_MS, at);
  }

  /** Hold the code for one sign-up. Its role, or null when it can't be used. */
  reserve(code: string): Role | null {
    const at = this.now();
    const row = this.db
      .prepare("UPDATE invite SET reserved_at = ? WHERE code = ? AND used_at IS NULL AND (reserved_at IS NULL OR reserved_at < ?) AND expires_at > ? RETURNING role")
      .get(at, code, at - RESERVED_MS, at);
    return row ? (row.role as Role) : null;
  }

  /** The sign-up didn't happen: the code is good again. */
  release(code: string): void {
    this.db.prepare("UPDATE invite SET reserved_at = NULL WHERE code = ? AND used_at IS NULL").run(code);
  }

  /** The account exists: the code is spent, and remembers who spent it. */
  spend(code: string, userId: string): void {
    this.db.prepare("UPDATE invite SET used_at = ?, used_by = ? WHERE code = ?").run(this.now(), userId, code);
  }

  /**
   * The first invite, for a server nobody can sign in to yet: it makes the
   * admin. Each start reuses the one already made, until it is spent.
   */
  firstAdmin(): Invite {
    const at = this.now();
    const row = this.db
      .prepare("SELECT code, expires_at FROM invite WHERE role = 'admin' AND created_by IS NULL AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
      .get(at);
    if (row) return { code: String(row.code), role: "admin", expiresAt: Number(row.expires_at) };
    return this.create("admin", null);
  }
}
