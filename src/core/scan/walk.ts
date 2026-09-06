import type { Source } from "@culvert/stream";
import type { Host } from "../../host/host";
import { normalizePath } from "../bookid";

export interface FileEntry {
  /** Library-relative, forward slashes. */
  relPath: string;
  /** Absolute path for the host. */
  absPath: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export const AUDIO_EXTENSIONS = new Set(["m4b", "m4a", "mp3", "opus", "ogg", "oga", "flac", "wav", "aac", "mp4", "wma"]);
export const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
export const ODIO_DIR = ".odio";

export function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function isAudio(name: string): boolean {
  return AUDIO_EXTENSIONS.has(extension(name));
}

export function isImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extension(name));
}

/**
 * Depth-first walk of the library as a pull source. Hidden entries and
 * the .odio folder are skipped. Directory order is by name so two runs
 * over the same tree emit the same sequence.
 */
export function walk(host: Host, root: string): Source<FileEntry> {
  return (async function* () {
    const stack: string[] = [""];
    while (stack.length > 0) {
      const rel = stack.pop()!;
      const abs = rel === "" ? root : host.join(root, ...rel.split("/"));
      let entries;
      try {
        entries = await host.readDir(abs);
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const dirs: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === ODIO_DIR) continue;
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDir) {
          dirs.push(childRel);
        } else if (e.isFile) {
          const childAbs = host.join(abs, e.name);
          let stat;
          try {
            stat = await host.stat(childAbs);
          } catch {
            continue;
          }
          yield { relPath: normalizePath(childRel), absPath: childAbs, name: e.name, sizeBytes: stat.sizeBytes, mtimeMs: stat.mtimeMs };
        }
      }
      // Push in reverse so the smallest name is processed first.
      for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]!);
    }
  })();
}
