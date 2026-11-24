import { open, mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { openZip, type OpenZipArchive } from "@culvert/zip";
import { collectBytes, pipe, type Source } from "@culvert/stream";
import type { ArchiveEntry } from "@ribbon/core/comic/pages";
import { isRar, openCbr } from "./cbr";

/**
 * A comic's archive on Node, read with Culvert (docs/COMICS.md, sections
 * 5 and 7): the list of entries from the end of the file, then any one
 * entry straight from where it sits. Nothing is unpacked to disk and
 * nothing is read that wasn't asked for. The server reads pages this
 * way; so do the tests and the reference scanner.
 */
export interface OpenComic {
  entries: ArchiveEntry[];
  /** One entry's bytes, as they are read. Throws when the archive has no such entry. */
  source(entry: string): Source<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Open a comic where it sits: a CBZ here, a CBR with Ribbon's RAR reader
 * (cbr.ts). Which it is, is told by its first bytes, not its name. Rejects
 * when it is neither, and in a sentence for a CBR Ribbon refuses.
 */
export async function openComic(file: string): Promise<OpenComic> {
  if (await isRar(file)) return openCbr(file);
  const handle = await open(file, "r");
  let archive: OpenZipArchive;
  try {
    const { size } = await handle.stat();
    archive = await openZip({
      size,
      read: async (offset, length) => {
        const buf = new Uint8Array(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      },
      close: () => handle.close(),
    });
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
  const byName = new Map(archive.entries.map((e) => [e.name, e]));
  return {
    entries: archive.entries.filter((e) => !e.name.endsWith("/")).map((e) => ({ name: e.name, size: e.uncompressedSize, packed: e.compressedSize })),
    source(entry) {
      const found = byName.get(entry);
      if (!found) throw new Error(`no such page: ${entry}`);
      return archive.source(found);
    },
    close: () => archive.close(),
  };
}

/** Every file in a comic's archive. */
export async function comicEntries(file: string): Promise<ArchiveEntry[]> {
  const comic = await openComic(file);
  try {
    return comic.entries;
  } finally {
    await comic.close();
  }
}

/** One entry of a comic's archive, whole. */
export async function comicEntry(file: string, entry: string): Promise<Uint8Array> {
  const comic = await openComic(file);
  try {
    return await pipe(comic.source(entry), collectBytes());
  } finally {
    await comic.close();
  }
}

/**
 * A comic's cover from one of its pages: the page is read out of the
 * archive, and ffmpeg makes a JPEG of it no wider than `width`. False
 * when ffmpeg can't read the page as a picture, or isn't there.
 */
export async function comicCover(file: string, entry: string, target: string, width: number): Promise<boolean> {
  const scratch = path.join(os.tmpdir(), `ribbon-page-${process.pid}-${Date.now()}${path.extname(entry) || ".jpg"}`);
  const made = `${target}.tmp.jpg`;
  try {
    await writeFile(scratch, await comicEntry(file, entry));
    await mkdir(path.dirname(target), { recursive: true });
    const ok = await new Promise<boolean>((resolve) => {
      // Never made wider than the page itself; the height follows, kept even for the encoder.
      const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i", scratch, "-vf", `scale='min(${width},iw)':-2`, "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", made];
      execFile("ffmpeg", args, { windowsHide: true }, (err) => resolve(!err));
    });
    if (!ok) return false;
    await rename(made, target);
    return true;
  } catch {
    return false;
  } finally {
    await rm(scratch, { force: true });
    await rm(made, { force: true });
  }
}
