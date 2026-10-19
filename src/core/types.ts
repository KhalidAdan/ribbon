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

export interface Book {
  id: string;
  /** Library-relative folder path, or the file path for a one-file book. */
  path: string;
  title: string;
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
  /** Library-relative path to the cover image, or empty. */
  cover: string;
  /** Library-relative path to the EPUB that goes with the audio, when there is one. */
  ebook?: string;
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
  /** Shorten recorded pauses during playback. Off unless the listener turns it on. */
  trimSilence: boolean;
}
