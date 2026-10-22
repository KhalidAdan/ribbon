import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The server's database, `ribbon.db` in its data folder: Better Auth's
 * tables (people, sessions) and the server's own. Only what is metadata
 * lives here; the books and each person's places are files
 * (docs/SERVER.md, section 5). SQLite is the one built into Node, so there
 * is nothing native to compile on the machine that runs the server.
 */
export function openDatabase(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dataDir, "ribbon.db"));
  // One writer, many readers, and a wait rather than an error when two requests write at once.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** The server's own tables. Better Auth makes its own (`getMigrations` in app.ts). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS invite (
  code TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_by TEXT,
  reserved_at INTEGER,
  used_at INTEGER,
  used_by TEXT
);
`;
