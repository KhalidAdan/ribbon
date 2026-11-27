import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The server's database, `ribbon.db` in its data folder: the people who
 * sign in and the server's own tables: what is metadata, the
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
  letBooksIntoManySeries(db);
  countWordsToo(db);
  clothsToo(db);
  comicsToo(db);
  return db;
}

/**
 * A database from before covers had cloths gets the columns for them, empty: each is worked out from its cover, once,
 * at start (library/covers.ts, `listCloths`).
 */
function clothsToo(db: DatabaseSync): void {
  const has = (table: string, column: string) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().some((c) => c.name === column);
  if (!has("book", "cover_cloth")) db.exec("ALTER TABLE book ADD COLUMN cover_cloth TEXT");
  if (!has("book_cover", "cloth")) db.exec("ALTER TABLE book_cover ADD COLUMN cloth TEXT");
}

/** A database from before comics gets the columns that say a book is one, how many pages it has, and what else it says of itself: no book in it is a comic. */
function comicsToo(db: DatabaseSync): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('book')").all();
  if (!columns.some((c) => c.name === "has_comic")) db.exec("ALTER TABLE book ADD COLUMN has_comic INTEGER NOT NULL DEFAULT 0; ALTER TABLE book ADD COLUMN pages INTEGER");
  // And whether its pages are a PDF's, which are drawn, not handed out (docs/COMICS.md, section 12).
  if (!columns.some((c) => c.name === "is_pdf")) db.exec("ALTER TABLE book ADD COLUMN is_pdf INTEGER NOT NULL DEFAULT 0");
  // And whether a comic reads right to left, as its file says (docs/COMICS.md, section 15): null for a comic added before the
  // library listed it, until its record is read, once, at start (book-folder.ts, `listDirections`).
  if (!columns.some((c) => c.name === "right_to_left")) db.exec("ALTER TABLE book ADD COLUMN right_to_left INTEGER");
  // And a comic's own details as its files say them (docs/BOOK-DETAILS.md, section 4), so the listing names it without
  // opening its book.json: null for a comic added before comics had details of their own, until its file is read again,
  // once, at start (library/comic-details.ts).
  if (!columns.some((c) => c.name === "details")) db.exec("ALTER TABLE book ADD COLUMN details TEXT");
  // A comic's edits as they were before that start moved them into its own details (docs/BOOK-DETAILS.md, section 6):
  // kept for a release, so the move can be undone by hand.
  const edits = db.prepare("SELECT name FROM pragma_table_info('book_edit')").all();
  if (!edits.some((c) => c.name === "edits_before_move")) db.exec("ALTER TABLE book_edit ADD COLUMN edits_before_move TEXT");
}

/**
 * A database from before books' words were counted gets the column for them, empty: the books indexed then are
 * counted from their sentences at start (SearchIndex, `countMissing`).
 */
function countWordsToo(db: DatabaseSync): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('sentence_index')").all();
  if (!columns.some((c) => c.name === "words")) db.exec("ALTER TABLE sentence_index ADD COLUMN words INTEGER");
}

/**
 * A series' books, in order: one row for each series a book is in, and a
 * book can be in any number of them (The Horus Heresy, and a White Scars
 * reading list made by hand). A function of the table's name so the
 * upgrade below can make it anew.
 */
function seriesBookTable(name: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  series_id TEXT NOT NULL REFERENCES series (id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES book (id) ON DELETE CASCADE,
  -- Its place in the order: between two others is anything between their positions.
  position REAL NOT NULL,
  -- Its number in the series where one is known: 8 for "Book 8, Part 2", 2.5 between 2 and 3.
  number REAL,
  -- Its title as a list of the series shows it, without the series' name; null to show its own.
  title TEXT,
  -- 0 leaves it off the shelf: a novella nobody listens to.
  shelved INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (series_id, book_id)
);`;
}

/**
 * A database from when a book could be in one series at most has its books'
 * table made again without that rule, once. Back then putting a book in a
 * series took it out of the one it was in, for good (a `series_left` row),
 * so making a reading list emptied the series its books came from. The
 * books that left a series only because they went into another are let
 * back: the next time series are found, at start, each goes back where its
 * tags or its title put it. SQLite can't drop a column's UNIQUE, hence a new
 * table. All of it happens, or none.
 */
function letBooksIntoManySeries(db: DatabaseSync): void {
  if (!bookInOneSeriesAtMost(db)) return;
  db.exec("BEGIN");
  try {
    db.exec(seriesBookTable("series_book_new"));
    db.exec("INSERT INTO series_book_new (series_id, book_id, position, number, title, shelved) SELECT series_id, book_id, position, number, title, shelved FROM series_book");
    db.exec("DROP TABLE series_book");
    db.exec("ALTER TABLE series_book_new RENAME TO series_book");
    db.exec("CREATE INDEX IF NOT EXISTS series_book_by_book ON series_book (book_id)");
    db.exec("DELETE FROM series_left WHERE EXISTS (SELECT 1 FROM series_book b WHERE b.book_id = series_left.book_id AND b.series_id <> series_left.series_id)");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Whether `series_book.book_id` is UNIQUE on its own, as it was when a book could be in one series at most. */
function bookInOneSeriesAtMost(db: DatabaseSync): boolean {
  const unique = db.prepare("SELECT name FROM pragma_index_list('series_book') WHERE \"unique\" = 1 AND origin = 'u'").all();
  return unique.some((index) => {
    const columns = db.prepare("SELECT name FROM pragma_index_info(?)").all(String(index.name));
    return columns.length === 1 && columns[0]!.name === "book_id";
  });
}

/** The server's own tables. Sessions and the accounts with passwords make theirs (packages/auth, packages/auth-accounts). */
const SCHEMA = `
-- Everyone who reads and listens here, whoever vouches for them (auth.ts). Their places, goals and devices are
-- kept against the id, which never changes; the rest follows what their sign-in last said.
CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  -- What they sign in as.
  name TEXT NOT NULL,
  -- What to call them.
  display_name TEXT NOT NULL,
  -- Where their picture is, when their sign-in gives one.
  picture TEXT,
  -- What they may do here: 'admin' or 'user'. Ribbon's own to decide, whoever signs them in.
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);

-- Who each person is to a provider: the provider's own id for them, which never changes.
CREATE TABLE IF NOT EXISTS person_identity (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  PRIMARY KEY (provider, subject)
);

-- Someone already here who is expected under a username at a provider they haven't signed in with yet
-- (src/link.ts): their first sign-in there becomes theirs, rather than a stranger's.
CREATE TABLE IF NOT EXISTS person_link (
  provider TEXT NOT NULL,
  username TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  -- When it was said: someone is expected for two weeks, not for ever.
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, username)
);

-- Things done once to a database from an older server, so they aren't done twice.
CREATE TABLE IF NOT EXISTS brought_over (
  what TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

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
  cover_cloth TEXT,
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

${seriesBookTable("series_book")}
CREATE INDEX IF NOT EXISTS series_book_by_book ON series_book (book_id);

-- A book's details as a person corrected them (packages/core/src/edits.ts), laid over
-- what its files say wherever it's listed or served. Taken back, the row goes.
CREATE TABLE IF NOT EXISTS book_edit (
  book_id TEXT PRIMARY KEY REFERENCES book (id) ON DELETE CASCADE,
  -- The fields as edited, as JSON: {"title": "War Without End"}.
  edits TEXT NOT NULL,
  -- When the server took them, ISO.
  updated_at TEXT NOT NULL,
  edited_by TEXT
);

-- A cover a person chose for a book, in place of its files' (packages/core/src/edits.ts):
-- its sizes are in the book's covers folder, as its own are.
CREATE TABLE IF NOT EXISTS book_cover (
  book_id TEXT PRIMARY KEY REFERENCES book (id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  aspect REAL NOT NULL,
  colour TEXT NOT NULL,
  cloth TEXT,
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

-- A person's daily goal (packages/core/src/goal.ts): minutes a day with their books, the same on every
-- device; the one chosen later stands.
CREATE TABLE IF NOT EXISTS person_goal (
  person_id TEXT PRIMARY KEY,
  minutes INTEGER NOT NULL,
  -- When it was chosen, ISO, on whichever device chose it.
  chosen_at TEXT NOT NULL
);

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

-- Which read-along each book's sentences were indexed from (its stamp), so a changed one is indexed again,
-- and how many sentences and words it has: the words are how thick the book stands on the bookcase.
CREATE TABLE IF NOT EXISTS sentence_index (
  book_id TEXT PRIMARY KEY,
  stamp TEXT NOT NULL,
  sentences INTEGER NOT NULL,
  words INTEGER
);

-- A comic's panels (library/panels.ts): one row for each page that has been divided, its panels in reading order
-- as JSON, each a rectangle in fractions of the page. The page is its name in the comic's archive.
CREATE TABLE IF NOT EXISTS comic_panels (
  book_id TEXT NOT NULL,
  page TEXT NOT NULL,
  panels TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, page)
);

-- A comic's ComicVine match (docs/BOOK-DETAILS.md, section 7): what ComicVine said of it, laid between what its files
-- say and a person's edits wherever it's listed or served (library/books.ts). Kept when a person presses "Use these", or
-- when the server matched it by itself by the address in its file; forgotten, the row goes.
CREATE TABLE IF NOT EXISTS book_match (
  book_id TEXT PRIMARY KEY REFERENCES book (id) ON DELETE CASCADE,
  -- The issue's page on ComicVine, linked back to wherever its details show.
  address TEXT NOT NULL,
  -- How its issue number was read: 'issue', 'collection' (its volume), or 'alone' (neither).
  matched_as TEXT NOT NULL,
  -- What it said for each field, as the edits are kept: {"series": "Saga (2012)", "issue": "14"}.
  said TEXT NOT NULL,
  -- Its whole answer, the issue and its run, as ComicVine gave them.
  answer TEXT NOT NULL,
  -- When it was kept, ISO, and by whom: null when the server matched it by itself.
  matched_at TEXT NOT NULL,
  matched_by TEXT
);

-- The comics the server looked up by itself, by the ComicVine address in their files, found or not; and the ones whose
-- match a person forgot: neither is looked up by itself again (library/comic-match.ts).
CREATE TABLE IF NOT EXISTS comicvine_asked (
  book_id TEXT PRIMARY KEY REFERENCES book (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  asked_at INTEGER NOT NULL
);

-- ComicVine's answers, kept for a day, as its terms ask (library/comicvine.ts): by the request, without the key.
CREATE TABLE IF NOT EXISTS comicvine_cache (
  key TEXT PRIMARY KEY,
  answer TEXT NOT NULL,
  asked_at INTEGER NOT NULL
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
