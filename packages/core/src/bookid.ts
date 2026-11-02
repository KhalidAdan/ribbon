import { CRC32 } from "@culvert/crc32";

/**
 * A book id is CRC-32 over the library-relative path and the total
 * audio byte size, as eight lowercase hex characters. Same folder
 * layout and same files on another device gives the same id, which is
 * what lets a position file written there mean something here.
 */
export function bookId(relativePath: string, totalBytes: number): string {
  const path = normalizePath(relativePath);
  const crc = new CRC32();
  crc.update(new TextEncoder().encode(`${path}\n${totalBytes}`));
  return crc.digest().toString(16).padStart(8, "0");
}

/** Forward slashes, no leading "./", no trailing slash. Case preserved. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}
