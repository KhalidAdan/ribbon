/**
 * Command-line harness so the scan is provable without the app.
 *
 *   npm run odio -- scan <folder>        scan and print the library
 *   npm run odio -- chapters <folder> <book-id>
 */
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { scanLibrary, loadLibrary } from "../src/core/scan/scan";
import { formatDuration } from "../src/core/speed";

async function main(argv: string[]): Promise<number> {
  const [cmd, folder, arg] = argv;
  if (!cmd || !folder) {
    console.error("usage: odio scan <folder> | odio chapters <folder> <book-id>");
    return 2;
  }
  const host = nodeHost();
  const root = path.resolve(folder);

  if (cmd === "scan") {
    const started = Date.now();
    const r = await scanLibrary(host, root, {
      concurrency: 6,
      onBook: (b, i, total) => console.log(`[${i + 1}/${total}] ${b.book.id}  ${b.book.title}  by ${b.book.author || "?"}  ${b.files.length} files  ${formatDuration(b.book.durationMs)}`),
      onError: (p, e) => console.error(`  ! ${p}: ${(e as Error).message}`),
    });
    console.log(`\n${r.books.length} books, ${r.probed} probed, ${r.reused} reused, ${r.errors.length} errors, ${Date.now() - started} ms`);
    return r.errors.length > 0 ? 1 : 0;
  }

  if (cmd === "chapters") {
    const lib = await loadLibrary(host, root);
    const b = lib?.find((x) => x.book.id === arg || x.book.title === arg);
    if (!b) {
      console.error("no such book; run scan first");
      return 1;
    }
    for (const [i, c] of b.chapters.entries()) console.log(`${String(i + 1).padStart(3)}  ${formatDuration(c.startMs).padStart(8)}  ${c.title}`);
    return 0;
  }

  console.error(`unknown command ${cmd}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
