import { pipe, collect, flatMap, from } from "@culvert/stream";
import type { Host, KnownFile, ScanOutput, ScanProgress, ScannedFile } from "@ribbon/core/host";
import { walk, isAudio, isComic, isEbook, isPdf, type FileEntry } from "@ribbon/core/scan/walk";
import { comicInfoEntry, isPage } from "@ribbon/core/comic/pages";
import { isSideFileName } from "@ribbon/core/scan/sidefiles";
import { probe } from "@ribbon/core/scan/probe";

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
    kind: isAudio(entry.name) ? "audio" : isSideFileName(entry.name) ? "text" : isEbook(entry.name) ? "ebook" : isComic(entry.name) ? "comic" : isPdf(entry.name) ? "pdf" : "image",
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
  // An EPUB's package is read when the host can and it changed.
  const readsEbook = (base: ScannedFile, entry: FileEntry) => base.kind === "ebook" && !!host.readEbookPackage && !isUnchanged(entry);
  // A comic's archive is listed when the host can and it changed.
  const readsComic = (base: ScannedFile, entry: FileEntry) => base.kind === "comic" && !!host.comicEntries && !isUnchanged(entry);
  // A PDF's pages are counted when the host can and it changed.
  const readsPdf = (base: ScannedFile, entry: FileEntry) => base.kind === "pdf" && !!host.pdfPages && !isUnchanged(entry);
  // The walk, with unread audio and EPUBs marked pending, so a caller can
  // show the shelf before a single tag is read.
  onFiles?.(
    entries.map((entry) => {
      const base = baseOf(entry);
      base.pending = (base.kind === "audio" && !isUnchanged(entry)) || readsEbook(base, entry) || readsComic(base, entry) || readsPdf(base, entry);
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
          if (base.kind === "text" && entry.sizeBytes <= 256 * 1024) {
            try {
              base.tags = { text: new TextDecoder().decode(await host.readFile(entry.absPath)) };
              base.fresh = true;
            } catch {
              /* a side file that cannot be read is no side file */
            }
          }
          if (readsEbook(base, entry)) {
            // Not read stays unread, to be tried again next time.
            const p = await host.readEbookPackage!(entry.absPath).catch(() => null);
            if (p) Object.assign(base, { fresh: true, tags: p.tags, hasCover: p.hasCover });
            onFiles?.([base]);
          }
          if (readsComic(base, entry)) {
            // How many pages its archive lists, and what its ComicInfo.xml says; one that can't be opened has no pages.
            const tags: Record<string, string> = { pages: "0" };
            try {
              const names = (await host.comicEntries!(entry.absPath)).map((e) => e.name);
              tags.pages = String(names.filter(isPage).length);
              const info = comicInfoEntry(names);
              if (info && host.comicEntry) tags.comicinfo = new TextDecoder().decode(await host.comicEntry(entry.absPath, info));
            } catch {
              /* not a zip: a comic with no pages */
            }
            Object.assign(base, { fresh: true, tags, hasCover: tags.pages !== "0" });
            probed++;
            onFiles?.([base]);
          }
          if (readsPdf(base, entry)) {
            // A file that isn't a PDF after all, or is locked, is one with no pages.
            const pages = await host.pdfPages!(entry.absPath).catch(() => 0);
            Object.assign(base, { fresh: true, tags: { pages: String(pages) }, hasCover: pages > 0 });
            probed++;
            onFiles?.([base]);
          }
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
