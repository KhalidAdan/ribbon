import type { Host } from "../host/host";

/**
 * A library folder that cannot be written from this device. On the
 * iPhone, a share the Files app reaches read-only (docs/MAC.md, the
 * phone); anywhere, a volume mounted read-only. Ribbon reads it as usual
 * and keeps what it would have written beside the books on this device.
 */
export class ReadOnlyFolder extends Error {
  constructor(readonly root: string) {
    super(`${root} is read-only from this device`);
    this.name = "ReadOnlyFolder";
  }
}

/**
 * Whether a write failed because the folder cannot be written from here,
 * rather than because the share was away for a moment: worth trying again
 * only in the second case.
 */
export function isReadOnly(e: unknown): boolean {
  if (e instanceof ReadOnlyFolder) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /read-only file system|\bEROFS\b|os error 30\b|write[- ]protected/i.test(message);
}

/**
 * The host as one library folder writes through it. The first write
 * inside the folder that fails because the folder is read-only calls
 * `onReadOnly`, and from then on every write inside it fails at once with
 * ReadOnlyFolder, without a round trip to the share. Reads, and writes
 * elsewhere (this device's mirror of the records), go straight through.
 * Until the folder is opened again: a share fixed in the meantime is
 * written to from the next start.
 */
export function guardWrites(host: Host, root: string, onReadOnly: () => void): Host {
  const base = root.replace(/[\\/]+$/, "");
  const inside = (path: string) => path === base || (path.startsWith(base) && (path[base.length] === "/" || path[base.length] === "\\"));
  let readOnly = false;
  const guarded =
    <A extends unknown[], R>(write: (...args: A) => Promise<R>, paths: (...args: A) => string[]) =>
    async (...args: A): Promise<R> => {
      if (!paths(...args).some(inside)) return write(...args);
      if (readOnly) throw new ReadOnlyFolder(root);
      try {
        return await write(...args);
      } catch (e) {
        if (!isReadOnly(e)) throw e;
        if (!readOnly) {
          readOnly = true;
          onReadOnly();
        }
        throw new ReadOnlyFolder(root);
      }
    };
  return {
    ...host,
    writeFile: guarded(host.writeFile.bind(host), (path) => [path]),
    mkdir: guarded(host.mkdir.bind(host), (path) => [path]),
    remove: guarded(host.remove.bind(host), (path) => [path]),
    rename: guarded(host.rename.bind(host), (from, to) => [from, to]),
    ...(host.appendFile ? { appendFile: guarded(host.appendFile.bind(host), (path) => [path]) } : {}),
    ...(host.writeTextFiles ? { writeTextFiles: guarded(host.writeTextFiles.bind(host), (files) => files.map((f) => f.path)) } : {}),
    ...(host.extractCover ? { extractCover: guarded(host.extractCover.bind(host), (_src, target) => [target]) } : {}),
  };
}
