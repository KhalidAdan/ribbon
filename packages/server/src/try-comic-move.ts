import { tryComicMove } from "./library/comic-move-trial.ts";

/**
 * Try the one-time move of comics' details on a copy of a server's data,
 * and say what it does to every comic, before the server does it for real
 * (library/comic-move-trial.ts):
 *
 *     npm run try-comic-move -- /path/to/ribbon-data /path/to/an/empty/folder
 *
 * (in the container: `node --import tsx src/try-comic-move.ts /data /tmp/comic-move`.)
 * The data folder is only read, so it's safe to run while the server is up;
 * the copy is made in the second folder, which must be new or empty.
 */
const [from, to] = process.argv.slice(2);

if (!from || !to) {
  console.error("Say where the server's data is, then a new folder for the copy: npm run try-comic-move -- <data folder> <new folder>");
  process.exitCode = 1;
} else {
  try {
    const trial = await tryComicMove(from, to);
    console.log(trial.lines.join("\n"));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
