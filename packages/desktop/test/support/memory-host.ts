import * as path from "node:path";
import { pipe, collect } from "@culvert/stream";
import type { DirEntry, FileStat, Host, ScannedFile, TextFile } from "@ribbon/core/host";
import { walk, isAudio, isEbook } from "@ribbon/core/scan/walk";
import { isSideFileName } from "@ribbon/core/scan/sidefiles";
import type { Chapter } from "@ribbon/core/types";

/** One audio file as the fake scan reads it: how long it is and its chapters. */
export interface FakeAudio {
  durationMs: number;
  chapters?: Chapter[];
  tags?: Record<string, string>;
}

/**
 * A Host whose files are in memory, for tests that boot the controller
 * hundreds of times: every answer is a resolved promise, so with fake
 * timers a run is the same every time. Its scan reads no audio: each
 * audio file is what `audio` says it is, and each EPUB's package is
 * `packages`' entry for it.
 */
export class MemoryHost {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>(["/"]);
  private clock = 1_700_000_000_000;
  /** Calls that are still waiting, so a test can let everything that can run, run. */
  inFlight = 0;

  constructor(
    private readonly audio: Record<string, FakeAudio> = {},
    private readonly packages: Record<string, Record<string, string>> = {},
  ) {}

  /** A file, with its folders, as if it had always been there. */
  put(p: string, data: Uint8Array | string = "x"): void {
    this.mkdirs(path.posix.dirname(p));
    this.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  has(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p);
  }

  text(p: string): string | null {
    const f = this.files.get(p);
    return f ? new TextDecoder().decode(f) : null;
  }

  private mkdirs(p: string): void {
    for (let d = p; !this.dirs.has(d); d = path.posix.dirname(d)) this.dirs.add(d);
  }

  private missing(p: string, op: string): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${p}'`), { code: "ENOENT" });
  }

  private async track<T>(work: () => T): Promise<T> {
    this.inFlight++;
    try {
      await Promise.resolve();
      return work();
    } finally {
      this.inFlight--;
    }
  }

  /** The Host itself; the parts a test wants to change (opening EPUBs, the export, speech) are laid over it. */
  host(over: Partial<Host> = {}): Host {
    const h: Host = {
      readDir: (dir) =>
        this.track((): DirEntry[] => {
          if (!this.dirs.has(dir)) throw this.missing(dir, "scandir");
          const out = new Map<string, DirEntry>();
          for (const d of this.dirs) if (d !== dir && path.posix.dirname(d) === dir) out.set(d, { name: path.posix.basename(d), isDir: true, isFile: false });
          for (const f of this.files.keys()) if (path.posix.dirname(f) === dir) out.set(f, { name: path.posix.basename(f), isDir: false, isFile: true });
          return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
        }),
      stat: (p) =>
        this.track((): FileStat => {
          const f = this.files.get(p);
          if (f) return { sizeBytes: f.length, mtimeMs: this.clock, isDir: false };
          if (this.dirs.has(p)) return { sizeBytes: 0, mtimeMs: this.clock, isDir: true };
          throw this.missing(p, "stat");
        }),
      exists: (p) => this.track(() => this.has(p)),
      readFile: (p) =>
        this.track(() => {
          const f = this.files.get(p);
          if (!f) throw this.missing(p, "open");
          return f;
        }),
      writeFile: (p, data) =>
        this.track(() => {
          if (!this.dirs.has(path.posix.dirname(p))) throw this.missing(p, "open");
          this.files.set(p, new Uint8Array(data));
        }),
      appendFile: (p, data) =>
        this.track(() => {
          if (!this.dirs.has(path.posix.dirname(p))) throw this.missing(p, "open");
          const was = this.files.get(p) ?? new Uint8Array();
          const next = new Uint8Array(was.length + data.length);
          next.set(was);
          next.set(data, was.length);
          this.files.set(p, next);
        }),
      mkdir: (p) => this.track(() => this.mkdirs(p)),
      remove: (p) =>
        this.track(() => {
          this.files.delete(p);
          for (const f of [...this.files.keys()]) if (f.startsWith(`${p}/`)) this.files.delete(f);
          for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
        }),
      rename: (from, to) =>
        this.track(() => {
          const f = this.files.get(from);
          if (f) {
            this.files.delete(from);
            this.files.set(to, f);
            return;
          }
          if (!this.dirs.has(from)) throw this.missing(from, "rename");
          for (const [k, v] of [...this.files]) if (k.startsWith(`${from}/`)) (this.files.delete(k), this.files.set(to + k.slice(from.length), v));
          for (const d of [...this.dirs]) if (d === from || d.startsWith(`${from}/`)) (this.dirs.delete(d), this.dirs.add(to + d.slice(from.length)));
        }),
      // No ffmpeg here: loudness, silence and clips fail as they do where it's missing.
      tools: false,
      run: () => this.track(() => ({ code: 1, stdout: "", stderr: "no tools in memory" })),
      join: (...parts) => path.posix.join(...parts),
      deviceName: async () => "memory",
      readTextDir: (dir) =>
        this.track((): TextFile[] => {
          const out: TextFile[] = [];
          for (const [f, data] of this.files) if (path.posix.dirname(f) === dir) out.push({ name: path.posix.basename(f), text: new TextDecoder().decode(data) });
          return out.sort((a, b) => a.name.localeCompare(b.name));
        }),
      scan: async (root, _known, onProgress, onFiles) => {
        const entries = await pipe(walk(h, root), collect());
        const files = entries.map((e): ScannedFile => {
          const kind = isAudio(e.name) ? "audio" : isSideFileName(e.name) ? "text" : isEbook(e.name) ? "ebook" : "image";
          const a = this.audio[e.relPath];
          const pkg = this.packages[e.relPath];
          return {
            path: e.relPath,
            name: e.name,
            kind,
            sizeBytes: e.sizeBytes,
            mtimeMs: e.mtimeMs,
            fresh: kind === "audio" || (kind === "ebook" && !!pkg),
            pending: false,
            durationMs: kind === "audio" ? (a?.durationMs ?? 0) : 0,
            tags: kind === "ebook" ? (pkg ?? {}) : (a?.tags ?? {}),
            hasCover: false,
            cover: "",
            chaptersKnown: kind === "audio",
            chapters: a?.chapters ?? [],
          };
        });
        onProgress?.({ walked: files.length, done: files.length });
        onFiles?.(files);
        return { files, walked: files.length, probed: files.length, reused: 0, elapsedMs: 0 };
      },
      ...over,
    };
    return h;
  }
}

/** A promise a test settles when it chooses: work held back until then. */
export class Held<T> {
  private waiting: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];

  get count(): number {
    return this.waiting.length;
  }

  wait(): Promise<T> {
    return new Promise<T>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  resolveAll(value: T): void {
    for (const w of this.waiting.splice(0)) w.resolve(value);
  }

  rejectAll(e: unknown): void {
    for (const w of this.waiting.splice(0)) w.reject(e);
  }
}
