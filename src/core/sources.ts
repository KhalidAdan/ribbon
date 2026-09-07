/**
 * A source is a folder the library is populated from. The books stay
 * where they are; Ribbon reads them in place and keeps its records
 * beside them. A library is one or more sources, in the order they
 * were added.
 */
export interface Source {
  /** Stable id from the folder path: the same key the local mirror uses. */
  id: string;
  /** Absolute path of the folder, as the user gave it. */
  root: string;
  /** The folder's own name, for the shelf and the settings. */
  name: string;
  /** ISO 8601. */
  addedAt: string;
}

/** What the platform keeps on disk for each source. */
export interface SourceEntry {
  root: string;
  addedAt: string;
}

/** Slashes one way, no trailing slash, case folded: how two paths are compared. */
export function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function sameRoot(a: string, b: string): boolean {
  return normalizeRoot(a) === normalizeRoot(b);
}

/**
 * FNV-1a, 64 bit, of the normalised root, as sixteen hex characters.
 * The host side derives the mirror folder name the same way, so a
 * source's id names its mirror.
 */
export function sourceId(root: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(normalizeRoot(root))) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** The last path segment: the folder's own name. */
export function sourceName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

export function sourceFrom(entry: SourceEntry): Source {
  return { id: sourceId(entry.root), root: entry.root, name: sourceName(entry.root), addedAt: entry.addedAt };
}
