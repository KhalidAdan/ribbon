/**
 * Plain data shared across core. No classes, no methods, so every value
 * round-trips through CSV and structured clone without ceremony.
 */

import type { Locator } from "./poslog";

export interface AudioFile {
  /** Library-relative path with forward slashes. */
  path: string;
  /** Position within the book, 0-based, after ordering. */
  order: number;
  durationMs: number;
  sizeBytes: number;
  mtimeMs: number;
  /** Title tag of this file, if any. Used to name inferred chapters. */
  title: string;
  /** The story of an anthology this file belongs to, or empty. Every file of a story carries the same name. */
  part: string;
  /** Who wrote that story, when the tags say; empty otherwise. */
  partAuthor: string;
  disc: number;
  track: number;
  hasCover: boolean;
  /** Library-relative path of a cover image extracted from this file, or empty. */
  coverFile: string;
  /** Embedded chapter markers, relative to this file. */
  chapters: Chapter[];
  /** True once ffprobe has been asked for markers. Fast scans leave it false. */
  chaptersProbed: boolean;
}

export interface Chapter {
  /** Offset from the start of the book timeline. */
  startMs: number;
  endMs: number;
  title: string;
}

/**
 * One story of an anthology on the book timeline: a run of the book's
 * files that share a part name. A book with no parts is one story.
 */
export interface Part {
  title: string;
  /** Empty when the tags do not say or the whole book is by one hand. */
  author: string;
  startMs: number;
  endMs: number;
}

/**
 * What a person did in making a book (docs/BOOK-DETAILS.md, section 2): a
 * comic's writers, its art (pencils), inks, colours, letters, cover,
 * editors and translators, and a text's translators. Not "cover": that is
 * the cover picture's edit already, so the cover's artists are
 * `coverArtists`.
 */
export const ROLES = ["writers", "pencils", "inks", "colours", "letters", "coverArtists", "editors", "translators"] as const;

export type Role = (typeof ROLES)[number];

/** People by what they did, each role a list of names in the order given. A role nobody is named for is left out. */
export type Credits = Partial<Record<Role, string[]>>;

export interface Book {
  id: string;
  /** Library-relative folder path, or the file path for a one-file book. */
  path: string;
  title: string;
  /**
   * The title before Ribbon names the book with it. An audiobook's is as
   * its tags have it, "(Unabridged)" and all. A comic's is the story's own
   * name ("Chapter Fourteen"), and empty when it has none: its `title` is
   * the name the shelf makes from this, its series and its number
   * (comic-name.ts), so a comic's title edit sets this one.
   */
  rawTitle: string;
  author: string;
  narrator: string;
  series: string;
  seriesIndex: number | null;
  year: number | null;
  /** What the files and the side files say beyond the basics. Empty when they say nothing. */
  subtitle?: string;
  genres?: string[];
  publisher?: string;
  description?: string;
  language?: string;
  isbn?: string;
  asin?: string;
  /**
   * Read-along turned off for this book by hand (edits.ts), because it will
   * never work: a different edition, a recording that strays from the text.
   * The book is listened to or read, with no sentence marked as the
   * narrator's, and its narration isn't transcribed. Absent, it reads along
   * when it can.
   */
  readAlong?: "off";
  /** Library-relative path to the cover image, or empty. */
  cover: string;
  /** Library-relative path to the EPUB that goes with the audio, when there is one. */
  ebook?: string;
  /**
   * Library-relative path to the CBZ, for a comic (docs/COMICS.md): a book
   * of pages already drawn, with no audio and no EPUB.
   */
  comic?: string;
  /** A comic's pages, once its archive has been read. */
  pages?: number;
  /** A comic read right to left, as its ComicInfo.xml says, or as an edit says over it. */
  rightToLeft?: boolean;
  /** The people who made it, by what they did: a comic's credits, and a text's translators. */
  credits?: Credits;
  /**
   * A comic's own details (docs/BOOK-DETAILS.md, section 2), each left out
   * when nothing says it. Its issue number as printed ("14", "½", "1.MU");
   * or, for a collection, its volume number ("1") and the issues it
   * collects ("1–6, Annual 1"). An issue number makes it an issue, a
   * volume or the issues it collects make it a collection, and with none
   * it is a comic on its own (comic-name.ts, `comicShape`).
   */
  issue?: string;
  volume?: string;
  collects?: string;
  imprint?: string;
  /** The month on its cover, "2024-07", or "2024" when only the year is known. A comic's `year` is this one's. */
  coverDate?: string;
  /** The day it went on sale, "2024-07-10". */
  onSale?: string;
  storyArcs?: string[];
  /** Its issue on ComicVine, "4000-1234567", from its file or a match. Never an edit (docs/BOOK-DETAILS.md, section 7). */
  comicvine?: string;
  durationMs: number;
  sizeBytes: number;
  fileCount: number;
}

export interface Position {
  bookId: string;
  offsetMs: number;
  /** ISO 8601 with milliseconds and a trailing Z. */
  updatedAt: string;
  device: string;
  /** What made the write: a pause, a seek, playing along (docs/POSITION-FORMAT.md). */
  why?: "pause" | "seek" | "periodic" | "end" | "close" | "open" | "import" | "remote";
}

export interface Bookmark {
  /** The `mark` record's id in the position log (docs/POSITION-FORMAT.md). */
  id: string;
  bookId: string;
  offsetMs: number;
  createdAt: string;
  /** When the note last changed, if it has. */
  modifiedAt?: string;
  note: string;
  /** Filename of the audio clip beside the bookmark row, or empty. */
  clip: string;
  /** The words it marks in the book's text, for a bookmark made from a highlight. */
  text?: HighlightText;
}

/**
 * Words marked in a text edition (docs/POSITION-FORMAT.md, section 3.4):
 * the edition's claims, Locators of where the words start and end, and
 * the words themselves.
 */
export interface HighlightText {
  ids: string[];
  start: Locator;
  end: Locator;
  quote: string;
}

/** A bookmark made from a highlight: in a book with no audio, it has no time. */
export interface Highlight extends Omit<Bookmark, "offsetMs" | "text"> {
  offsetMs: number | null;
  text: HighlightText;
}

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number | null;
}

export interface SilenceRange {
  startMs: number;
  endMs: number;
}

export interface BookSettings {
  bookId: string;
  speed: number;
  /** When the speed was last chosen on this device, if it ever was: a newer session elsewhere outranks an older choice. */
  speedAt?: string;
  /** Shorten recorded pauses during playback. Off unless the listener turns it on. */
  trimSilence: boolean;
}
