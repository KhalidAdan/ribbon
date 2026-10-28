import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Host } from "../../../src/host/host.ts";
import { ensureChapters, scanLibrary, type ScannedBook } from "../../../src/core/scan/scan.ts";
import { BookIndex, bookDir, booksDir, claimsOf, type StoredBook } from "./books.ts";
import { makeCovers } from "./covers.ts";
import { analyzeStored, readStored, writeStored } from "./prepare.ts";
import { carriedAnalysis, carryRecords, findRecords } from "./records.ts";
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
  /** Bytes free on the disk that holds a folder (statfs); given in tests. */
  freeBytes?: (folder: string) => Promise<number>;
}

/** Room left on the server's disk after a book is copied in, so it never fills to the last byte. */
export const SPARE_BYTES = 1024 ** 3;

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
  if (existing) {
    await fillRecords(ctx, root, scanned, existing);
    return { added: false, id: existing };
  }

  // Checked before anything is copied: a book that won't fit is left out, said why, and the import goes on to smaller ones.
  // Measured where the book goes, the books folder, not the data folder above it: they can be different disks.
  const bytes = scanned.files.reduce((s, f) => s + f.sizeBytes, 0) + (scanned.book.ebook ? (await stat(abs(scanned.book.ebook))).size : 0);
  const books = booksDir(ctx.dataDir);
  await mkdir(books, { recursive: true });
  const free = await (ctx.freeBytes ?? freeBytes)(books);
  if (free < bytes + SPARE_BYTES) throw new Error(`there isn't room for it on the server's disk (${Math.round(bytes / 1024 ** 2)} MB, with ${Math.round(free / 1024 ** 2)} MB free).`);

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
    // What Ribbon already worked out about the book comes in with it, so no device works it out again.
    const found = await findRecords(root, scanned);
    if (found) {
      const records = await carryRecords(found, building, []);
      if (records.length > 0) stored.records = records;
    }
    // Its loudness and silences: as measured before, or measured once here, from the copy.
    const analysis = (found && (await carriedAnalysis(found))) ?? (files.length > 0 ? await analyzeStored(ctx.host, building, stored) : null);
    if (analysis) stored.analysis = analysis;
    await writeFile(path.join(building, "book.json"), JSON.stringify(stored, null, 2));
    await rename(building, final);
    ctx.index.add(id, fingerprint, stored, claims, ctx.addedBy, (ctx.now ?? Date.now)());
    return { added: true, id };
  } catch (e) {
    await rm(building, { recursive: true, force: true });
    throw e;
  }
}

/**
 * A book that's on the server already: whatever records its folder has
 * that the server hasn't yet are carried in, so adding a folder again fills
 * in what an earlier add, or an earlier server, left behind.
 */
async function fillRecords(ctx: ImportContext, root: string, scanned: ScannedBook, id: string): Promise<void> {
  const found = await findRecords(root, scanned);
  const stored = found && (await readStored(ctx.dataDir, id));
  if (!found || !stored) return;
  const records = await carryRecords(found, bookDir(ctx.dataDir, id), stored.records ?? []);
  const analysis = stored.analysis ?? (await carriedAnalysis(found)) ?? undefined;
  if (records.length === (stored.records ?? []).length && analysis === stored.analysis) return;
  await writeStored(ctx.dataDir, id, { ...stored, ...(records.length > 0 ? { records } : {}), ...(analysis ? { analysis } : {}) });
}

/** Bytes free on the disk that holds a folder. */
async function freeBytes(folder: string): Promise<number> {
  const disk = await statfs(folder);
  return disk.bavail * disk.bsize;
}

/** Copy a file into the server, a clone where the disk can make one, and check it all arrived. */
async function copyIn(from: string, to: string, expectedBytes?: number): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to, constants.COPYFILE_FICLONE);
  if (expectedBytes !== undefined && (await stat(to)).size !== expectedBytes) throw new Error(`${path.basename(from)} didn't copy whole.`);
}
