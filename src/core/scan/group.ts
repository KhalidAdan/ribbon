import { isAudio, isImage, type FileEntry } from "./walk";
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
 * with parts. Order of the returned groups follows the walk.
 */
export function groupBooks(files: readonly FileEntry[]): BookGroup[] {
  const byFolder = new Map<string, { audio: FileEntry[]; images: FileEntry[] }>();
  const folderOrder: string[] = [];
  const foldersWithAudio = new Set<string>();

  for (const f of files) {
    const folder = parentOf(f.relPath);
    let bucket = byFolder.get(folder);
    if (!bucket) {
      bucket = { audio: [], images: [] };
      byFolder.set(folder, bucket);
      folderOrder.push(folder);
    }
    if (isAudio(f.name)) {
      bucket.audio.push(f);
      foldersWithAudio.add(folder);
    } else if (isImage(f.name)) {
      bucket.images.push(f);
    }
  }

  const anthologies = findAnthologies(foldersWithAudio, byFolder);
  const anthologyOf = (folder: string) => [...anthologies].find((a) => folder === a || isUnder(folder, a));
  const sortedImages = (list: FileEntry[]) => [...list].sort((a, b) => coverRank(a.name) - coverRank(b.name));

  const groups: BookGroup[] = [];
  const anthologyGroups = new Map<string, BookGroup>();
  for (const folder of folderOrder) {
    const bucket = byFolder.get(folder)!;
    const anthology = anthologyOf(folder);
    if (anthology !== undefined) {
      let g = anthologyGroups.get(anthology);
      if (!g) {
        g = { path: anthology, name: baseName(anthology), audio: [], covers: sortedImages(byFolder.get(anthology)?.images ?? []), parts: [] };
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
        groups.push({ path: a.relPath, name: stem(a.name), audio: [a], covers: [] });
      }
    } else {
      groups.push({ path: folder, name: baseName(folder), audio: [...bucket.audio], covers: images });
    }
  }
  // Parts in their numbered order; the anthology's audio is the parts' audio in that order.
  for (const g of anthologyGroups.values()) {
    g.parts!.sort((a, b) => (parseNumbered(baseName(a.path))?.index ?? 0) - (parseNumbered(baseName(b.path))?.index ?? 0));
    g.audio = g.parts!.flatMap((p) => p.audio);
    if (g.covers.length === 0) g.covers = sortedImages(g.parts!.flatMap((p) => byFolder.get(p.path)?.images ?? []));
  }
  return groups.filter((g) => g.audio.length > 0);
}
