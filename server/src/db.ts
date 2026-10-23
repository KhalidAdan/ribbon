import { mkdirSync } from "node:fs";
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
  mkdirSync(dataDir, { recursive: true });
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

-- Every book on the server, for listing it fast and adding it only once.
-- Its files and its full record are in books/<id>/.
CREATE TABLE IF NOT EXISTS book (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  narrator TEXT NOT NULL,
  series TEXT NOT NULL,
  series_index REAL,
  duration_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  has_audio INTEGER NOT NULL,
  has_ebook INTEGER NOT NULL,
  -- The EPUB's size: with the book's id, the id an app gives the book once it's downloaded.
  ebook_bytes INTEGER,
  cover_hash TEXT,
  cover_aspect REAL,
  cover_colour TEXT,
  added_at INTEGER NOT NULL,
  added_by TEXT
);

CREATE INDEX IF NOT EXISTS book_by_cover ON book (cover_hash);

-- What else names a book (urn:isbn:…, urn:asin:…): the same book from another folder is known by these too.
CREATE TABLE IF NOT EXISTS book_claim (
  claim TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES book (id) ON DELETE CASCADE
);

-- Work the server does in the background: adding a folder, and later transcribing.
-- Each person's places: every record their devices appended to the position
-- log (docs/POSITION-FORMAT.md), one row each, in the order the server took
-- them. A record sent twice is kept once, by its device and sequence number.
CREATE TABLE IF NOT EXISTS place (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  UNIQUE (person_id, device_id, seq)
);

CREATE INDEX IF NOT EXISTS place_by_person ON place (person_id, id);

-- Who each of a person's devices is: what it calls itself.
CREATE TABLE IF NOT EXISTS place_device (
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  app TEXT,
  PRIMARY KEY (person_id, device_id)
);

CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  progress TEXT NOT NULL,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
`;
