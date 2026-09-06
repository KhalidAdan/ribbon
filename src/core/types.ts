/**
 * Plain data shared across core. No classes, no methods, so every value
 * round-trips through CSV and structured clone without ceremony.
 */

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
  /** Library-relative path to the cover image, or empty. */
  cover: string;
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
}

export interface Bookmark {
  bookId: string;
  offsetMs: number;
  createdAt: string;
  note: string;
  /** Filename of the audio clip beside the bookmark row, or empty. */
  clip: string;
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
}
