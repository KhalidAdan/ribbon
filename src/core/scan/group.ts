import { isAudio, isEbook, isImage, type FileEntry } from "./walk";
import { isSideFileName } from "./sidefiles";
import { parseNumbered } from "./metadata";

export interface BookPart {
  /** Library-relative folder of the part. */
  path: string;
  /** The part folder's name without its leading number. */
  name: string;
  audio: FileEntry[];
}

export interface BookGroup {
  /** Library-relative folder path, or the file path for a one-file book. */
  path: string;
  /** Folder name, or file name without extension for loose files. */
  name: string;
  audio: FileEntry[];
  /** Image files in the folder, best candidate first. */
  covers: FileEntry[];
  /** metadata.opf, desc.txt, reader.txt beside the book. */
  side?: FileEntry[];
  /** Library-relative path of the EPUB that goes with the audio (docs/READING.md, section 2). */
  ebook?: string;
  /**
   * Set when the book is an anthology: a numbered folder holding only
   * numbered subfolders, one per part. Parts are in their numbered order
   * and together hold every file in `audio`.
   */
  parts?: BookPart[];
}

const COVER_NAMES = ["cover", "folder", "front", "album", "artwork"];

function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
}

function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? name : name.slice(0, i);
}

function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? relPath : relPath.slice(i + 1);
}

/** Letters and digits only, lower case: how a file name is compared with another. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function sharedStart(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** The fewest letters two names must start with alike to be taken as one book. */
const MIN_SHARED = 6;

function coverRank(name: string): number {
  const s = stem(name).toLowerCase();
  const i = COVER_NAMES.indexOf(s);
  return i < 0 ? COVER_NAMES.length : i;
}

function isUnder(path: string, folder: string): boolean {
  return folder === "" ? path !== "" : path.startsWith(folder + "/");
}

/** The segment of `path` directly below `folder`. */
function childOf(path: string, folder: string): string {
  const rest = folder === "" ? path : path.slice(folder.length + 1);
  const i = rest.indexOf("/");
  return i < 0 ? rest : rest.slice(0, i);
}

/**
 * Anthologies: a numbered folder, not the library root, with no audio of
 * its own, whose audio-bearing children are all numbered folders. The
 * listener numbered the folder because it is one book in the series;
 * the parts inside are its novellas. Returns the outermost such folders.
 */
function findAnthologies(foldersWithAudio: Set<string>, byFolder: Map<string, { audio: FileEntry[] }>): Set<string> {
  const candidates = new Set<string>();
  for (const folder of foldersWithAudio) {
    let p = parentOf(folder);
    while (p !== "") {
      candidates.add(p);
      p = parentOf(p);
    }
  }
  const out = new Set<string>();
  for (const c of [...candidates].sort((a, b) => a.split("/").length - b.split("/").length)) {
    if ([...out].some((a) => isUnder(c, a))) continue;
    if (!parseNumbered(baseName(c))) continue;
    if ((byFolder.get(c)?.audio.length ?? 0) > 0) continue;
    const children = new Set<string>();
    for (const f of foldersWithAudio) if (isUnder(f, c)) children.add(childOf(f, c));
    if (children.size > 0 && [...children].every((ch) => parseNumbered(ch))) out.add(c);
  }
  return out;
}

/**
 * A folder that directly contains audio is one book. Audio files at the
 * library root, or in a folder that also has book subfolders, are each
 * their own book. A numbered folder of numbered subfolders is one book
 * with parts. An EPUB with no audio to pair with is a book with no
 * audio, after the rest. Order of the returned groups follows the walk.
 */
export function groupBooks(files: readonly FileEntry[]): BookGroup[] {
  const byFolder = new Map<string, { audio: FileEntry[]; images: FileEntry[]; side: FileEntry[]; ebooks: FileEntry[] }>();
  const folderOrder: string[] = [];
  const foldersWithAudio = new Set<string>();

  for (const f of files) {
    const folder = parentOf(f.relPath);
    let bucket = byFolder.get(folder);
    if (!bucket) {
      bucket = { audio: [], images: [], side: [], ebooks: [] };
      byFolder.set(folder, bucket);
      folderOrder.push(folder);
    }
    if (isAudio(f.name)) {
      bucket.audio.push(f);
      foldersWithAudio.add(folder);
    } else if (isImage(f.name)) {
      bucket.images.push(f);
    } else if (isSideFileName(f.name)) {
      bucket.side.push(f);
    } else if (isEbook(f.name)) {
      bucket.ebooks.push(f);
    }
  }

  const anthologies = findAnthologies(foldersWithAudio, byFolder);
  const anthologyOf = (folder: string) => [...anthologies].find((a) => folder === a || isUnder(folder, a));
  const sortedImages = (list: FileEntry[]) => [...list].sort((a, b) => coverRank(a.name) - coverRank(b.name));
  // A folder's EPUB: the first by name when there are several.
  const ebookIn = (folder: string) => [...(byFolder.get(folder)?.ebooks ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0]?.relPath;
  // A loose file's EPUB, among the loose files of its folder: the one with
  // the same name, else the one whose name starts most like the file's,
  // when that is clear both ways. Store names rarely match
  // ("VoidscarredWarhammer40000_ep7.mp3" beside
  // "Voidscarred -- Mike Brooks -- 2025 -- Black Library.epub").
  const ebookBeside = (a: FileEntry, loose: readonly FileEntry[]): string | undefined => {
    const ebooks = byFolder.get(parentOf(a.relPath))?.ebooks ?? [];
    const named = (x: FileEntry, y: FileEntry) => stem(x.name).toLowerCase() === stem(y.name).toLowerCase();
    const same = ebooks.find((e) => named(e, a));
    if (same) return same.relPath;
    const free = ebooks.filter((e) => !loose.some((o) => named(e, o)));
    const freeAudio = loose.filter((o) => !ebooks.some((e) => named(e, o)));
    const closeness = (x: FileEntry, y: FileEntry) => sharedStart(squash(stem(x.name)), squash(stem(y.name)));
    const ranked = free.map((e) => ({ e, n: closeness(e, a) })).sort((x, y) => y.n - x.n);
    const best = ranked[0];
    if (!best || best.n < MIN_SHARED || (ranked[1]?.n ?? 0) === best.n) return undefined;
    // And no other loose file is as close to that EPUB.
    if (freeAudio.some((o) => o !== a && closeness(best.e, o) >= best.n)) return undefined;
    return best.e.relPath;
  };
  const withEbook = (g: BookGroup, ebook: string | undefined): BookGroup => (ebook ? { ...g, ebook } : g);

  const groups: BookGroup[] = [];
  const anthologyGroups = new Map<string, BookGroup>();
  for (const folder of folderOrder) {
    const bucket = byFolder.get(folder)!;
    const anthology = anthologyOf(folder);
    if (anthology !== undefined) {
      let g = anthologyGroups.get(anthology);
      if (!g) {
        g = withEbook({ path: anthology, name: baseName(anthology), audio: [], covers: sortedImages(byFolder.get(anthology)?.images ?? []), side: byFolder.get(anthology)?.side ?? [], parts: [] }, ebookIn(anthology));
        anthologyGroups.set(anthology, g);
        groups.push(g);
      }
      if (folder === anthology || bucket.audio.length === 0) continue;
      const child = childOf(folder, anthology);
      const partPath = `${anthology}/${child}`;
      let part = g.parts!.find((p) => p.path === partPath);
      if (!part) {
        part = { path: partPath, name: parseNumbered(child)?.name ?? child, audio: [] };
        g.parts!.push(part);
      }
      part.audio.push(...bucket.audio);
      continue;
    }
    if (bucket.audio.length === 0) continue;
    const images = sortedImages(bucket.images);
    const isRoot = folder === "";
    const hasBookChildren = [...foldersWithAudio].some((other) => other !== folder && other.startsWith(folder === "" ? "" : folder + "/"));
    if (isRoot || hasBookChildren) {
      for (const a of bucket.audio) {
        groups.push(withEbook({ path: a.relPath, name: stem(a.name), audio: [a], covers: [] }, ebookBeside(a, bucket.audio)));
      }
    } else {
      groups.push(withEbook({ path: folder, name: baseName(folder), audio: [...bucket.audio], covers: images, side: bucket.side }, ebookIn(folder)));
    }
  }
  // Parts in their numbered order; the anthology's audio is the parts' audio in that order.
  for (const g of anthologyGroups.values()) {
    g.parts!.sort((a, b) => (parseNumbered(baseName(a.path))?.index ?? 0) - (parseNumbered(baseName(b.path))?.index ?? 0));
    g.audio = g.parts!.flatMap((p) => p.audio);
    if (g.covers.length === 0) g.covers = sortedImages(g.parts!.flatMap((p) => byFolder.get(p.path)?.images ?? []));
  }
  const books = groups.filter((g) => g.audio.length > 0);

  // An EPUB folder pairing left alone is a book of its own, to read: one
  // not in an audiobook's folder and not beside a loose file it pairs
  // with. The scan may still pair it with an audiobook elsewhere by its
  // metadata. The other EPUBs of a book's folder stay with that book.
  const taken = new Set(books.map((g) => g.ebook).filter((e): e is string => !!e));
  const bookFolders = new Set<string>();
  for (const g of books) {
    if (g.audio.length === 1 && g.path === g.audio[0]!.relPath) continue;
    bookFolders.add(g.path);
    for (const p of g.parts ?? []) bookFolders.add(p.path);
  }
  for (const folder of folderOrder) {
    if (bookFolders.has(folder)) continue;
    for (const e of byFolder.get(folder)!.ebooks) {
      if (taken.has(e.relPath)) continue;
      books.push({ path: e.relPath, name: stem(e.name), audio: [], covers: [], ebook: e.relPath });
    }
  }
  return books;
}

/** A group that is only an EPUB: a book to read, with no audio. */
export function isReaderOnlyGroup(g: BookGroup): boolean {
  return g.audio.length === 0 && !!g.ebook;
}
