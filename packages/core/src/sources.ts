/**
 * A source is a folder the library is populated from. The books stay
 * where they are; Ribbon reads them in place and keeps its records
 * beside them. A library is one or more sources, in the order they
 * were added.
 *
 * A Ribbon server is a source too (docs/SERVER.md, section 11): its
 * folder is one of Ribbon's own on this device, where the server's books
 * are downloaded before they play, and `server` says which server and
 * who's signed in to it.
 */
export interface Source {
  /** Stable id from the folder path: the same key the local mirror uses. */
  id: string;
  /** Absolute path of the folder, as the user gave it. */
  root: string;
  /** The folder's own name, for the shelf and the settings; for a server, its address. */
  name: string;
  /** ISO 8601. */
  addedAt: string;
  server?: ServerRef;
}

/** A Ribbon server, and who's signed in to it from this device. The sign-in token is kept apart, in the app's settings. */
export interface ServerRef {
  /** Its address, as people reach it: `https://ribbon.example`, no trailing slash. */
  url: string;
  /** The name signed in with. */
  person: string;
}

/** What the platform keeps on disk for each source. */
export interface SourceEntry {
  root: string;
  addedAt: string;
  server?: ServerRef;
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
  const source: Source = { id: sourceId(entry.root), root: entry.root, name: entry.server ? serverName(entry.server.url) : sourceName(entry.root), addedAt: entry.addedAt };
  if (entry.server) source.server = entry.server;
  return source;
}

/**
 * A server and who's signed in to it, as one key: it names the server's
 * folder on this device and its sign-in in the app's settings. Not the
 * folder's path, which on a phone moves when the app is updated.
 */
export function serverKey(s: ServerRef): string {
  return `${s.url}#${s.person.toLowerCase()}`;
}

/** A server as the settings name it: its host, without the scheme. */
export function serverName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
