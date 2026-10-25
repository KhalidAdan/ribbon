import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Where a folder the admin picked on another computer is on this one. An app
 * sends the path the folder has where it was picked: `/Volumes/media/Books/Dune`
 * on a Mac, `M:\Books\Dune` or `\\nas\media\Books\Dune` on Windows. The server
 * tries that path as it is, then looks for the same folders under each of the
 * folders it reads books from (RIBBON_FOLDERS): `Books/Dune` under `/mnt/media`,
 * say. The longest stretch of the path that's there wins, so a folder deep in
 * the share is never mistaken for a shorter one of the same name. Null when
 * it's nowhere.
 */
export async function findFolder(picked: string, folders: readonly string[]): Promise<string | null> {
  if (path.isAbsolute(picked) && (await isFolder(picked))) return picked;
  // The folders' names, split on either system's separators, without a Windows drive.
  const names = picked.split(/[\\/]+/).filter((name) => name !== "" && !/^[a-z]:$/i.test(name));
  // A path that climbs (`..`) could reach beside the folders the server was given: it's only ever taken as it is.
  if (names.some((name) => name === "." || name === "..")) return null;
  for (let from = 0; from < names.length; from++) {
    for (const folder of folders) {
      const there = path.join(folder, ...names.slice(from));
      if (await isFolder(there)) return there;
    }
  }
  return null;
}

async function isFolder(at: string): Promise<boolean> {
  return (await stat(at).catch(() => null))?.isDirectory() ?? false;
}
