/**
 * The only seam between core and the outside world. Node implements it
 * for tests and the CLI; Tauri implements it over plugin-fs, plugin-shell
 * and two Rust commands. Core never imports anything else that touches
 * I/O.
 */

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
  durationMs: number;
  /** Lower-cased tag names. */
  tags: Record<string, string>;
  hasCover: boolean;
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
  /** Run ffprobe or ffmpeg to completion. Never throws on non-zero exit. */
  run(tool: Tool, args: string[], signal?: AbortSignal): Promise<RunResult>;
  join(...parts: string[]): string;
  /** A stable, human-readable name for this machine. */
  deviceName(): Promise<string>;
  /**
   * Walk a library and read tags from every audio file not in `known`,
   * in one call. Implementations are free to do this in parallel and
   * without ffprobe.
   */
  scan(root: string, known: KnownFile[], onProgress?: (p: ScanProgress) => void): Promise<ScanOutput>;
  /** Every small text file in a directory, in one call. */
  readTextDir(dir: string): Promise<TextFile[]>;
}
