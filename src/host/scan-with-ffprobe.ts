import { pipe, collect, flatMap, from } from "@culvert/stream";
import type { Host, KnownFile, ScanOutput, ScanProgress, ScannedFile } from "./host";
import { walk, isAudio, type FileEntry } from "../core/scan/walk";
import { probe } from "../core/scan/probe";

/**
 * The reference implementation of Host.scan, built from the walk source
 * and ffprobe. Slow but exact, and it reads chapter markers. Node and
 * the browser harness use it; Tauri uses the Rust scanner instead.
 */
export async function scanWithFfprobe(
  host: Host,
  root: string,
  known: KnownFile[],
  onProgress?: (p: ScanProgress) => void,
  onFiles?: (files: ScannedFile[]) => void,
  concurrency = 8,
): Promise<ScanOutput> {
  const started = Date.now();
  let rootStat;
  try {
    rootStat = await host.stat(root);
  } catch {
    throw new Error(`not a directory: ${root}`);
  }
  if (!rootStat.isDir) throw new Error(`not a directory: ${root}`);
  const entries = await pipe(walk(host, root), collect());
  const knownMap = new Map(known.map((k) => [k.path, k]));
  let probed = 0;
  let reused = 0;
  let done = 0;
  onProgress?.({ walked: entries.length, done: 0 });

  const isUnchanged = (entry: FileEntry) => {
    const k = knownMap.get(entry.relPath);
    return k !== undefined && k.sizeBytes === entry.sizeBytes && Math.abs(k.mtimeMs - entry.mtimeMs) <= 1000;
  };
  const baseOf = (entry: FileEntry): ScannedFile => ({
    path: entry.relPath,
    name: entry.name,
    kind: isAudio(entry.name) ? "audio" : "image",
    sizeBytes: entry.sizeBytes,
    mtimeMs: entry.mtimeMs,
    fresh: false,
    pending: false,
    durationMs: 0,
    tags: {},
    hasCover: false,
    cover: "",
    chaptersKnown: false,
    chapters: [],
  });
  // The walk, with unread audio marked pending, so a caller can show the
  // shelf before a single tag is read.
  onFiles?.(
    entries.map((entry) => {
      const base = baseOf(entry);
      base.pending = base.kind === "audio" && !isUnchanged(entry);
      return base;
    }),
  );

  const indexed = entries.map((entry, index) => ({ entry, index }));
  const unordered = await pipe(
    from(indexed),
    flatMap(
      ({ entry, index }: { entry: FileEntry; index: number }) =>
        (async function* () {
          const base = baseOf(entry);
          if (base.kind === "audio") {
            if (isUnchanged(entry)) {
              reused++;
            } else {
              try {
                const r = await probe(host, entry.absPath);
                Object.assign(base, { fresh: true, durationMs: r.durationMs, tags: r.tags, hasCover: r.hasCover, chaptersKnown: true, chapters: r.chapters });
              } catch {
                // Unreadable file: return it fresh with no duration so the
                // caller can skip it, the same as the Rust scanner does.
                base.fresh = true;
              }
              probed++;
              onFiles?.([base]);
            }
          }
          done++;
          if (done % 50 === 0) onProgress?.({ walked: entries.length, done });
          yield { index, file: base };
        })(),
      { concurrency },
    ),
    collect(),
  );
  // flatMap yields in completion order; the caller expects walk order.
  const files = unordered.sort((a, b) => a.index - b.index).map((x) => x.file);
  onProgress?.({ walked: entries.length, done: entries.length });
  return { files, walked: entries.length, probed, reused, elapsedMs: Date.now() - started };
}
