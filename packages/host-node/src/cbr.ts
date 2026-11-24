import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import * as path from "node:path";
import { from } from "@culvert/stream";
import { startsAsRar } from "@ribbon/core/comic/cbr";
import type { ArchiveEntry } from "@ribbon/core/comic/pages";
import type { OpenComic } from "./comic";

/**
 * A CBR on Node (docs/COMICS.md, section 13): a comic in a RAR archive.
 * Node has no RAR reader of its own here. It runs Ribbon's, the one the
 * app reads a CBR with, as the `ribbon-cbr` command
 * (packages/desktop/src-tauri/cbr), the way the server runs `ribbon-ebook`
 * for an EPUB.
 *
 * The other way was tried and measured: the same reader as WebAssembly,
 * in this process. It holds the whole archive in memory, several times
 * over (1.9 GB at its peak for a 360 MB comic, against 4 MB for the
 * command), which a small server can't spare for an omnibus.
 */

/** The most the command may print: a page at its largest, or a list of every file in the largest archive. */
const MOST_OUTPUT = 160 * 1024 * 1024;

/**
 * Where the `ribbon-cbr` command is: where `RIBBON_CBR_TOOL` says (the
 * server's image sets it), else as cargo builds it in this repository
 * (`cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml -p
 * ribbon-cbr`), a release build before a debug one. Null when it isn't built.
 */
export function cbrTool(): string | null {
  if (process.env.RIBBON_CBR_TOOL) return process.env.RIBBON_CBR_TOOL;
  const target = path.resolve(import.meta.dirname, "..", "..", "..", "target");
  const exe = process.platform === "win32" ? "ribbon-cbr.exe" : "ribbon-cbr";
  return ["release", "debug"].map((profile) => path.join(target, profile, exe)).find((p) => existsSync(p)) ?? null;
}

/** Run the command. Rejects with what it said, which for a CBR it refuses is a sentence for people. */
function run(args: string[]): Promise<Buffer> {
  const tool = cbrTool();
  if (!tool) return Promise.reject(new Error("CBRs can't be opened here: Ribbon's RAR reader (ribbon-cbr) isn't built."));
  return new Promise((resolve, reject) => {
    execFile(tool, args, { encoding: "buffer", maxBuffer: MOST_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.toString("utf8").trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** True when the file starts as a RAR archive does, whatever it is called. */
export async function isRar(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const start = new Uint8Array(8);
    const { bytesRead } = await handle.read(start, 0, start.length, 0);
    return startsAsRar(start.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Open a CBR: its files are listed now, and each is read when asked for. Rejects, in a sentence, for one Ribbon refuses. */
export async function openCbr(file: string): Promise<OpenComic> {
  const listed = JSON.parse((await run(["list", file])).toString("utf8")) as { entries: ArchiveEntry[] };
  const names = new Set(listed.entries.map((e) => e.name));
  return {
    entries: listed.entries,
    source(entry) {
      if (!names.has(entry)) throw new Error(`no such page: ${entry}`);
      // Read when the first chunk is asked for, and whole: the command hands a page over in one piece.
      return from(
        (async function* () {
          yield new Uint8Array(await run(["entry", file, entry]));
        })(),
      );
    },
    // Nothing is held between one question and the next.
    close: async () => undefined,
  };
}

/**
 * Write a CBR out as a CBZ at `target`: the same files under the same
 * names, none squeezed, in one pass through the archive. Rejects, in a
 * sentence, for a CBR Ribbon refuses, and leaves nothing at `target`.
 */
export async function cbrToCbz(file: string, target: string): Promise<void> {
  await run(["cbz", file, target]);
}
