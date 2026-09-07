/**
 * The only seam between core and the outside world. Node implements it
 * for tests and the CLI; Tauri implements it over plugin-fs, plugin-shell
 * and a few Rust commands. Core never imports anything else that touches
 * I/O.
 */

import type { Source } from "@culvert/stream";
import type { Chapter } from "../core/types";

export interface DirEntry {
  name: string;
  isDir: boolean;
  isFile: boolean;
}

export interface FileStat {
  sizeBytes: number;
  mtimeMs: number;
  isDir: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Tool = "ffprobe" | "ffmpeg";

/** What the caller already knows about a file, so the scan can skip it. */
export interface KnownFile {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** One file from a library scan. Audio fields are set only when `fresh`. */
export interface ScannedFile {
  /** Library-relative, forward slashes. */
  path: string;
  name: string;
  kind: "audio" | "image";
  sizeBytes: number;
  mtimeMs: number;
  /** True when tags were read on this pass; false means "unchanged, reuse". */
  fresh: boolean;
  /**
   * True while the file has been found but not yet read. Appears only in
   * streamed batches; a scan's final result has no pending files.
   */
  pending: boolean;
  durationMs: number;
  /** Lower-cased tag names. */
  tags: Record<string, string>;
  hasCover: boolean;
  /** Library-relative path of a cover image the scanner wrote out of the
   *  file's tag, or empty when it did not. */
  cover: string;
  /** True when embedded chapter markers were actually read. */
  chaptersKnown: boolean;
  chapters: Chapter[];
}

export interface ScanProgress {
  /** Total files once the walk is complete; 0 while still walking. */
  walked: number;
  done: number;
  /** Files discovered so far while the walk is still running. */
  found?: number;
  /** What is happening after the tag read, for the progress line. */
  stage?: string;
}

export interface ScanOutput {
  files: ScannedFile[];
  walked: number;
  probed: number;
  reused: number;
  elapsedMs: number;
}

export interface TextFile {
  name: string;
  text: string;
}

export interface Host {
  readDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  /** Atomic: written to a sibling temp file and renamed into place. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Move a file or folder within the same volume. */
  rename(from: string, to: string): Promise<void>;
  /** Run ffprobe or ffmpeg to completion. Never throws on non-zero exit. */
  run(tool: Tool, args: string[], signal?: AbortSignal): Promise<RunResult>;
  /**
   * Run a tool and stream its stderr as lines while it runs, so a
   * parser can fold the output live and an abort ends the stream. ffmpeg
   * reports everything on stderr. Optional: hosts without it are given
   * the finished transcript from `run` instead.
   */
  stream?(tool: Tool, args: string[], signal?: AbortSignal): Source<string>;
  join(...parts: string[]): string;
  /** A stable, human-readable name for this machine. */
  deviceName(): Promise<string>;
  /**
   * Walk a library and read tags from every audio file not in `known`,
   * in one call. Implementations are free to do this in parallel and
   * without ffprobe. `onFiles` receives files as they are found and as
   * they are read: first the whole walk with unread audio marked
   * pending, then finished files, each replacing its pending entry.
   */
  scan(root: string, known: KnownFile[], onProgress?: (p: ScanProgress) => void, onFiles?: (files: ScannedFile[]) => void): Promise<ScanOutput>;
  /** Every small text file in a directory, in one call. */
  readTextDir(dir: string): Promise<TextFile[]>;
  /**
   * Copy the picture embedded in an audio file to `target`, reading only
   * the picture bytes. Resolves false when there is none the host can
   * find; the caller may then try ffmpeg. Optional: hosts without a
   * native tag reader leave it out.
   */
  extractCover?(src: string, target: string): Promise<boolean>;
  /**
   * Write several small text files in one call, each atomically (temp
   * file and rename) with parent folders created. Optional: hosts
   * without it get one `writeFile` per file.
   */
  writeTextFiles?(files: { path: string; text: string }[]): Promise<void>;
  /**
   * A local copy of a library's records (library.csv and files.csv as
   * text), kept beside the app so opening a library never waits on a
   * slow volume. The records beside the books remain the truth; this is
   * only what to paint first. Optional.
   */
  recordsMirror?: {
    read(root: string): Promise<{ dir: string; library: string; files: string; positions: string | null; covers: string[] } | null>;
    write(root: string, parts: { library?: string; files?: string; positions?: string }): Promise<void>;
    /** Copy covers in (skipping ones already there); resolves to every cover name present. */
    covers(root: string, covers: { name: string; src: string }[]): Promise<string[]>;
  };
}
