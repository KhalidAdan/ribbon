import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The server's database, `ribbon.db` in its data folder: Better Auth's
 * tables (people, sessions) and the server's own: what is metadata, the
 * library's series, each person's places, and every book's sentences for
 * search. The books themselves are files (docs/SERVER.md, section 5).
 * SQLite is the one built into Node, so there is nothing native to compile
 * on the machine that runs the server.
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

-- Books the admin deleted, so each device that downloaded one takes it off too.
-- Devices go by this list, never by a book missing from the library: a server
-- that lost its list mustn't empty every device. Adding the book again takes
-- it off here.
CREATE TABLE IF NOT EXISTS deleted_book (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL,
  deleted_by TEXT
);

-- The library's series (src/library/series.ts): the same for every device and
-- every person. The server finds them as books arrive; after that a series is
-- what people make of it.
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  -- Who last changed it; null while it's as the server found it.
  changed_by TEXT
);

-- A series' books, in order. A book is in one series at most.
CREATE TABLE IF NOT EXISTS series_book (
  series_id TEXT NOT NULL REFERENCES series (id) ON DELETE CASCADE,
  book_id TEXT NOT NULL UNIQUE REFERENCES book (id) ON DELETE CASCADE,
  -- Its place in the order: between two others is anything between their positions.
  position REAL NOT NULL,
  -- Its number in the series where one is known: 8 for "Book 8, Part 2", 2.5 between 2 and 3.
  number REAL,
  -- Its title as a list of the series shows it, without the series' name; null to show its own.
  title TEXT,
  -- 0 leaves it off the shelf: a novella nobody listens to.
  shelved INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (series_id, book_id)
);

-- A book's details as a person corrected them (src/core/edits.ts), laid over
-- what its files say wherever it's listed or served. Taken back, the row goes.
CREATE TABLE IF NOT EXISTS book_edit (
  book_id TEXT PRIMARY KEY REFERENCES book (id) ON DELETE CASCADE,
  -- The fields as edited, as JSON: {"title": "War Without End"}.
  edits TEXT NOT NULL,
  -- When the server took them, ISO.
  updated_at TEXT NOT NULL,
  edited_by TEXT
);

-- A cover a person chose for a book, in place of its files' (src/core/edits.ts):
-- its sizes are in the book's covers folder, as its own are.
CREATE TABLE IF NOT EXISTS book_cover (
  book_id TEXT PRIMARY KEY REFERENCES book (id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  aspect REAL NOT NULL,
  colour TEXT NOT NULL,
  chosen_at TEXT NOT NULL,
  chosen_by TEXT
);

-- What people took apart, so finding series again never puts it back: series
-- deleted, and books taken out of a series.
CREATE TABLE IF NOT EXISTS series_dropped (
  id TEXT PRIMARY KEY,
  dropped_at INTEGER NOT NULL,
  dropped_by TEXT
);

CREATE TABLE IF NOT EXISTS series_left (
  series_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  PRIMARY KEY (series_id, book_id)
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

-- Every book's sentences, for search (src/library/search.ts): SQLite's full-text search, words stemmed.
CREATE VIRTUAL TABLE IF NOT EXISTS sentence_text USING fts5(
  text,
  book_id UNINDEXED,
  n UNINDEXED,
  ms UNINDEXED,
  chapter UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Which read-along each book's sentences were indexed from (its stamp), so a changed one is indexed again.
CREATE TABLE IF NOT EXISTS sentence_index (
  book_id TEXT PRIMARY KEY,
  stamp TEXT NOT NULL,
  sentences INTEGER NOT NULL
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
