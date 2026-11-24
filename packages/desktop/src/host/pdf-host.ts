import type { Host, KnownFile, ScannedFile } from "@ribbon/core/host";

/**
 * What a web view adds to a host for PDFs (docs/COMICS.md, section 12):
 * it is the web view that can read one, with pdf.js, so counting a PDF's
 * pages and drawing its cover happen here, on top of whatever host walks
 * the folders. pdf.js is fetched when the first PDF is met, not at start.
 */
const pdf = () => import("../comic/pdf");

/** How many PDFs are counted at once: each is a few small reads, and a share is asked gently. */
const AT_ONCE = 3;

/**
 * A PDF's pages, counted once the file can be fetched. The app is given
 * leave to serve a folder's files while its scan is already running, so
 * the first PDFs may be asked for a moment too soon: those are tried
 * again for a while. Null when the file never came; 0 when it came and
 * isn't a PDF that can be opened.
 */
async function pagesOf(url: string, length: number): Promise<number | null> {
  const { webPdfPages, NotReached } = await pdf();
  for (let tries = 0; ; tries++) {
    try {
      return await webPdfPages(url, length);
    } catch (e) {
      if (!(e instanceof NotReached) && !(e instanceof TypeError)) return 0;
      if (tries >= 40) return null;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** `host`, reading PDFs with the web view's pdf.js; `urlOf` is where the web view fetches a file from. */
export function withPdfs(host: Host, urlOf: (absPath: string) => string): Host {
  return {
    ...host,
    async pdfPages(path) {
      const pages = await pagesOf(urlOf(path), (await host.stat(path)).sizeBytes);
      if (pages === null) throw new Error("the file could not be reached");
      return pages;
    },
    async pdfCover(path, target, width) {
      try {
        const { webPdfCover } = await pdf();
        await host.writeFile(target, await webPdfCover(urlOf(path), (await host.stat(path)).sizeBytes, width));
        return true;
      } catch {
        return false;
      }
    },
    async scan(root, known, onProgress, onFiles) {
      const out = await host.scan(root, known, onProgress, onFiles);
      // The PDFs the walk found and nobody has counted: new ones, and ones that changed.
      const had = new Map(known.map((k: KnownFile) => [k.path, k]));
      const unchanged = (f: ScannedFile) => {
        const k = had.get(f.path);
        return !!k && k.sizeBytes === f.sizeBytes && Math.abs(k.mtimeMs - f.mtimeMs) <= 1000;
      };
      const todo = out.files.filter((f) => f.kind === "pdf" && !f.fresh && !unchanged(f));
      let next = 0;
      const work = async () => {
        while (next < todo.length) {
          const file = todo[next++]!;
          const pages = await pagesOf(urlOf(host.join(root, ...file.path.split("/"))), file.sizeBytes);
          // Never reached: left as found, to be counted at the next scan.
          if (pages === null) continue;
          Object.assign(file, { fresh: true, pending: false, tags: { pages: String(pages) }, hasCover: pages > 0 });
          onFiles?.([file]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, work));
      return { ...out, probed: out.probed + todo.filter((f) => f.fresh).length };
    },
  };
}
