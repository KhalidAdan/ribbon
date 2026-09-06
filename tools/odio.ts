/**
 * Command-line harness so the scan is provable without the app.
 *
 *   npm run odio -- scan <folder>        scan and print the library
 *   npm run odio -- chapters <folder> <book-id-or-title>
 */
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { scanLibrary, loadLibrary, extractMissingCovers } from "../src/core/scan/scan";
import { formatDuration } from "../src/core/speed";

async function main(argv: string[]): Promise<number> {
  const [cmd, folder, arg] = argv;
  if (!cmd || !folder) {
    console.error("usage: odio scan <folder> | odio chapters <folder> <book-id-or-title>");
    return 2;
  }
  const host = nodeHost();
  const root = path.resolve(folder);

  if (cmd === "scan") {
    const started = Date.now();
    const r = await scanLibrary(host, root, {
      onProgress: (p) => {
        if (p.walked > 0 && (p.done % 500 === 0 || p.done === p.walked)) process.stderr.write(`  ${p.done}/${p.walked} files\r`);
      },
    });
    for (const b of r.books) console.log(`${b.book.id}  ${b.book.title}  by ${b.book.author || "?"}  ${b.files.length} files  ${formatDuration(b.book.durationMs)}`);
    for (const e of r.errors) console.error(`  ! ${e.path}: ${e.message}`);
    const covers = await extractMissingCovers(host, root, r.books);
    if (covers.length > 0) console.log(`${covers.length} covers extracted with ffmpeg`);
    console.log(`${r.books.length} books, ${r.probed} probed, ${r.reused} reused, ${r.rescued} rescued, ${r.errors.length} errors, ${Date.now() - started} ms`);
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
