import type { Host } from "../../../src/host/host.ts";

/**
 * The host as an import sees a folder it copies from: anything inside the
 * folder can be read, nothing inside it can be written. A folder added to
 * the server may be someone's only copy of their books, on a share; the
 * server takes its own copies and leaves the folder exactly as it was
 * (docs/SERVER.md, section 5).
 */
export function neverWrites(host: Host, root: string): Host {
  const base = root.replace(/[\\/]+$/, "");
  const inside = (p: string) => p === base || (p.startsWith(base) && (p[base.length] === "/" || p[base.length] === "\\"));
  const refuse = (p: string) => {
    if (inside(p)) throw new Error(`The server never writes to a folder it imports from: ${p}`);
  };
  return {
    ...host,
    writeFile: async (p, data) => (refuse(p), host.writeFile(p, data)),
    mkdir: async (p) => (refuse(p), host.mkdir(p)),
    remove: async (p) => (refuse(p), host.remove(p)),
    rename: async (from, to) => (refuse(from), refuse(to), host.rename(from, to)),
    ...(host.appendFile ? { appendFile: async (p: string, data: Uint8Array) => (refuse(p), host.appendFile!(p, data)) } : {}),
    ...(host.writeTextFiles ? { writeTextFiles: async (files: { path: string; text: string }[]) => (files.forEach((f) => refuse(f.path)), host.writeTextFiles!(files)) } : {}),
    ...(host.extractCover ? { extractCover: async (src: string, target: string) => (refuse(target), host.extractCover!(src, target)) } : {}),
  };
}
