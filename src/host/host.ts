/**
 * The only seam between core and the outside world. Node implements it
 * for tests and the CLI; Tauri implements it over plugin-fs and
 * plugin-shell. Core never imports anything else that touches I/O.
 */

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
}
