import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bookDir, type BookIndex, type StoredBook } from "./books.ts";
import { readStored } from "./prepare.ts";

const run = promisify(execFile);

/** How many moments' frames are remembered: a player asks for one file from one moment many times, a range at a time. */
const KEPT = 64;

/** Where a moment of an MP3 starts: the byte its frame starts at, and the moment that frame starts. */
export interface FrameStart {
  byte: number;
  ms: number;
}

/**
 * Exact places in a book's MP3s, for a player that would otherwise seek by
 * guess (Apple's on the TV; docs/SERVER.md, section 8): the frame a moment
 * falls in, found by the `ribbon-frames` command (src-tauri/frames), the
 * code the app plays its own MP3s with. Each file's frame index is made
 * once, reading the file whole, and kept in the book's folder (`frames/`).
 */
export class Mp3Frames {
  private readonly found = new Map<string, FrameStart>();

  constructor(
    private readonly dataDir: string,
    private readonly tool: string | null,
  ) {}

  /** Whether this server can find frames at all; without it, MP3s are sent whole and players seek as they can. */
  get available(): boolean {
    return this.tool !== null;
  }

  /**
   * Index every MP3 of every book that hasn't been yet, one at a time: a
   * 10-hour file takes seconds to read whole, and its first play from a
   * moment shouldn't wait on it. How many files it indexed.
   */
  async indexMissing(books: BookIndex): Promise<number> {
    if (!this.tool) return 0;
    let indexed = 0;
    for (const { id } of books.list()) {
      const stored = await readStored(this.dataDir, id);
      for (const file of stored?.files ?? []) {
        const kept = path.join(bookDir(this.dataDir, id), "frames", `${stored!.files.indexOf(file)}.bin`);
        if (!/\.mp3$/i.test(file.path) || (await stat(kept).catch(() => null))) continue;
        await this.start(id, stored!, file.path, 0).catch(() => undefined);
        indexed++;
      }
    }
    return indexed;
  }

  /** Where the moment `ms` of one of a book's audio files starts in it. */
  async start(id: string, stored: StoredBook, file: string, ms: number): Promise<FrameStart> {
    const key = `${id}/${file}@${ms}`;
    const kept = this.found.get(key);
    if (kept) return kept;
    const order = stored.files.findIndex((f) => f.path === file);
    const dir = bookDir(this.dataDir, id);
    const { stdout } = await run(this.tool!, [path.join(dir, file), path.join(dir, "frames", `${order}.bin`), String(ms)]);
    const start = JSON.parse(stdout) as FrameStart;
    this.found.set(key, start);
    if (this.found.size > KEPT) this.found.delete(this.found.keys().next().value!);
    return start;
  }
}
