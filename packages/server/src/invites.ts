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

/**
 * Where an invite stands. A code is fresh until a sign-up holds it, held
 * while that sign-up makes the account, and used once the account exists; a
 * sign-up that fails gives it back. A fresh code whose days have passed has
 * expired. A held one hasn't: whoever holds it started in time, and finishes.
 *
 *     fresh ──hold──▶ held ──spend──▶ used
 *       ▲               │
 *       └───release─────┘   (and every hold, when the server starts again)
 *
 *     fresh ──its days pass──▶ expired
 *
 * A hold lasts until its sign-up ends, however long that takes, so nobody
 * else can take the code meanwhile; only a sign-up the server stopped in
 * the middle of never ends, and the server lets its hold go when it starts.
 */
export type InviteStatus = "fresh" | "held" | "used" | "expired";

/** What happens to an invite: a sign-up holds it, gives it back, or spends it. */
export type InviteEvent = "hold" | "release" | "spend";

/** Where each event takes an invite from where it stands. An event with no answer changes nothing. */
const NEXT: Record<InviteStatus, Partial<Record<InviteEvent, InviteStatus>>> = {
  fresh: { hold: "held" },
  held: { release: "fresh", spend: "used" },
  used: {},
  expired: {},
};

/** The columns of an invite's row that say where it stands. */
interface Standing {
  reserved_at: number | null;
  used_at: number | null;
  expires_at: number;
}

/** Where an invite stands now, from its row: the one place its columns are read that way. */
export function statusOf(row: Standing, now: number): InviteStatus {
  if (row.used_at !== null) return "used";
  if (row.reserved_at !== null) return "held";
  return row.expires_at > now ? "fresh" : "expired";
}

/**
 * Invites, the one way into a Ribbon server (docs/SERVER.md, section 6).
 * The admin makes one; it is a code that is good once, for a few days.
 * Signing up holds the code first, so two people can't spend the same one
 * at once, and spends it when the account exists; a sign-up that fails
 * (a name already taken) gives it back (`InviteStatus`).
 */
export class Invites {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    // A hold is a sign-up under way. One from before the server started never finished: its code is fresh again.
    db.prepare("UPDATE invite SET reserved_at = NULL WHERE reserved_at IS NOT NULL AND used_at IS NULL").run();
  }

  create(role: Role, createdBy: string | null, days = 7): Invite {
    const code = randomBytes(18).toString("base64url");
    const at = this.now();
    const expiresAt = at + days * DAY_MS;
    this.db.prepare("INSERT INTO invite (code, role, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?)").run(code, role, at, expiresAt, createdBy);
    return { code, role, expiresAt };
  }

  /** Where the code stands now; null when there's no such invite. */
  private status(code: string): InviteStatus | null {
    const row = this.db.prepare("SELECT reserved_at, used_at, expires_at FROM invite WHERE code = ?").get(code);
    return row ? statusOf(row as unknown as Standing, this.now()) : null;
  }

  /** Whether a sign-up can use the code now: it's fresh. */
  usable(code: string): boolean {
    return this.status(code) === "fresh";
  }

  /** Hold the code for one sign-up. Its role, or null when it can't be used. */
  reserve(code: string): Role | null {
    return this.move(code, "hold");
  }

  /** The sign-up holding the code didn't happen: it's good again. */
  release(code: string): void {
    this.move(code, "release");
  }

  /** The sign-up holding the code made its account: the code is spent, and remembers who spent it. */
  spend(code: string, userId: string): void {
    this.move(code, "spend", userId);
  }

  /**
   * The first invite, for a server nobody can sign in to yet: it makes the
   * admin. Each start reuses the one already made, until it is spent.
   */
  firstAdmin(): Invite {
    const rows = this.db.prepare("SELECT code, expires_at, reserved_at, used_at FROM invite WHERE role = 'admin' AND created_by IS NULL ORDER BY created_at DESC").all();
    const row = rows.find((r) => ["fresh", "held"].includes(statusOf(r as unknown as Standing, this.now())));
    if (row) return { code: String(row.code), role: "admin", expiresAt: Number(row.expires_at) };
    return this.create("admin", null);
  }

  /**
   * Move an invite on by `event`, when where it stands allows it (`NEXT`):
   * the one place its row is changed. Read and written with nothing in
   * between (the database is used synchronously), so two sign-ups can't
   * both move it. Its role; null, and nothing changed, when it can't move.
   */
  private move(code: string, event: InviteEvent, userId: string | null = null): Role | null {
    const row = this.db.prepare("SELECT role, reserved_at, used_at, expires_at FROM invite WHERE code = ?").get(code);
    const at = this.now();
    const next = row && NEXT[statusOf(row as unknown as Standing, at)][event];
    if (!next) return null;
    // The columns as the status it moves to has them.
    this.db.prepare("UPDATE invite SET reserved_at = ?, used_at = ?, used_by = ? WHERE code = ?").run(next === "held" ? at : null, next === "used" ? at : null, next === "used" ? userId : null, code);
    return row.role as Role;
  }
}
