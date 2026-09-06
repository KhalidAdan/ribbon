import { isAudio, isImage, type FileEntry } from "./walk";

export interface BookGroup {
  /** Library-relative folder, or the file path for a one-file book. */
  path: string;
  /** Folder name, or file name without extension for loose files. */
  name: string;
  audio: FileEntry[];
  /** Image files in the folder, best candidate first. */
  covers: FileEntry[];
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

/**
 * A folder that directly contains audio is one book. Audio files at the
 * library root, or in a folder that also has book subfolders, are each
 * their own book. Order of the returned groups follows the walk.
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

  const groups: BookGroup[] = [];
  for (const folder of folderOrder) {
    const bucket = byFolder.get(folder)!;
    if (bucket.audio.length === 0) continue;
    const images = [...bucket.images].sort((a, b) => coverRank(a.name) - coverRank(b.name));
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
  return groups;
}
