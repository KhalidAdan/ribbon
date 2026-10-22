import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Host } from "../../../src/host/host.ts";
import { ensureChapters, scanLibrary, type ScannedBook } from "../../../src/core/scan/scan.ts";
import { BookIndex, bookDir, claimsOf, type StoredBook } from "./books.ts";
import { makeCovers } from "./covers.ts";
import { audioFingerprint, fileFingerprint } from "./fingerprint.ts";
import { neverWrites } from "./never-writes.ts";

/** How an import is going, as the admin pages show it. */
export interface ImportProgress {
  folder: string;
  /** Books the folder holds, once scanned. */
  found: number;
  added: number;
  /** Books already on the server, by their files or by an ISBN or ASIN. */
  skipped: number;
  failed: number;
  /** The book being copied now, if any. */
  current: string | null;
  /** One line per book skipped or failed, saying which and why. */
  notes: string[];
}

export interface ImportContext {
  /** Node's host, for reading the folder and running ffmpeg. */
  host: Host;
  dataDir: string;
  index: BookIndex;
  addedBy: string | null;
  now?: () => number;
}

/**
 * Add a folder of books to the server (docs/SERVER.md, sections 5 and 12):
 * scan it with Ribbon's own scanner, then for each book it finds, skip it
 * if it's here already, else copy its files in, read its chapters, make
 * its covers, and list it. The folder itself is only ever read.
 */
export async function importFolder(ctx: ImportContext, folder: string, report: (progress: ImportProgress) => void): Promise<ImportProgress> {
  const root = path.resolve(folder);
  const progress: ImportProgress = { folder: root, found: 0, added: 0, skipped: 0, failed: 0, current: null, notes: [] };
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`There's no folder at ${root}.`);
  const host = neverWrites(ctx.host, root);
  const scan = await scanLibrary(host, root, { write: false });
  const books = scan.books.filter((b) => !b.pending);
  progress.found = books.length;
  report(progress);

  for (const scanned of books) {
    progress.current = scanned.book.title;
    report(progress);
    try {
      const added = await importBook(ctx, host, root, scanned);
      if (added.added) progress.added++;
      else {
        progress.skipped++;
        progress.notes.push(`${scanned.book.title}: already on the server.`);
      }
    } catch (e) {
      progress.failed++;
      progress.notes.push(`${scanned.book.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
    report(progress);
  }
  progress.current = null;
  return progress;
}

/** One book: skipped if it's here already, else copied in whole or not at all. */
async function importBook(ctx: ImportContext, host: Host, root: string, scanned: ScannedBook): Promise<{ added: boolean; id: string }> {
  const abs = (rel: string) => path.join(root, ...rel.split("/"));
  const claims = claimsOf(scanned.book);
  const fingerprint =
    scanned.files.length > 0
      ? await audioFingerprint(scanned.files.map((f) => ({ absPath: abs(f.path), sizeBytes: f.sizeBytes })))
      : await fileFingerprint(abs(scanned.book.ebook!));
  const existing = ctx.index.find(fingerprint, claims);
  if (existing) return { added: false, id: existing };

  // Chapters the scan didn't read yet. Saving them beside the books is refused (the folder is read-only to us); they're kept all the same.
  const book = scanned.files.some((f) => !f.chaptersProbed) ? await ensureChapters(host, root, scanned, undefined, () => undefined) : scanned;

  const id = fingerprint.slice(0, 16);
  const final = bookDir(ctx.dataDir, id);
  // Built beside its final place and moved in when complete, so a book is never half there.
  const building = `${final}.adding-${randomBytes(4).toString("hex")}`;
  try {
    const inBook = (rel: string) => (rel === book.book.path ? path.posix.basename(rel) : path.posix.relative(book.book.path, rel));
    const files = [];
    for (const f of book.files) {
      const to = `audio/${inBook(f.path)}`;
      await copyIn(abs(f.path), path.join(building, ...to.split("/")), f.sizeBytes);
      files.push({ ...f, path: to, coverFile: "" });
    }
    const ebookBytes = book.book.ebook ? (await stat(abs(book.book.ebook))).size : undefined;
    if (book.book.ebook) await copyIn(abs(book.book.ebook), path.join(building, "book.epub"), ebookBytes);

    // The cover: a picture beside the book (or one Ribbon pulled out on a computer), else the one inside the first audio file that has one.
    const picture = book.book.cover ? abs(book.book.cover) : undefined;
    const withPicture = book.files.find((f) => f.hasCover);
    const cover = await makeCovers(ctx.host, { ...(picture ? { image: picture } : {}), ...(withPicture ? { audio: abs(withPicture.path) } : {}) }, path.join(building, "covers"));

    const stored: StoredBook = {
      book: { ...book.book, id, path: "", cover: cover ? `covers/${cover.hash}` : "", ...(book.book.ebook ? { ebook: "book.epub" } : {}) },
      files,
      chapters: book.chapters,
      parts: book.parts,
      cover,
      ...(ebookBytes !== undefined ? { ebookBytes } : {}),
    };
    await writeFile(path.join(building, "book.json"), JSON.stringify(stored, null, 2));
    await rename(building, final);
    ctx.index.add(id, fingerprint, stored, claims, ctx.addedBy, (ctx.now ?? Date.now)());
    return { added: true, id };
  } catch (e) {
    await rm(building, { recursive: true, force: true });
    throw e;
  }
}

/** Copy a file into the server, a clone where the disk can make one, and check it all arrived. */
async function copyIn(from: string, to: string, expectedBytes?: number): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to, constants.COPYFILE_FICLONE);
  if (expectedBytes !== undefined && (await stat(to)).size !== expectedBytes) throw new Error(`${path.basename(from)} didn't copy whole.`);
}
