/**
 * The public test library for the end-to-end checks: The Wonderful Wizard of
 * Oz, Project Gutenberg's EPUB with LibriVox's recording read by Phil
 * Chenevert, both in the public domain, so the checks can run anywhere,
 * GitHub's runners included. The EPUB (library/) and the book's transcript
 * (records/, its `.ribbon/` from a read-along on the Mac) are kept here; the
 * recording, 118 MB, is fetched from archive.org and checked against
 * library.json. Files already there and whole are not fetched again.
 *
 *   npm run e2e:library                       # into .e2e/public-library
 *   npm run e2e:library -- --library <folder>
 *   npm run e2e:library -- --record           # write the fetched files' hashes into library.json
 *
 * Then: npm run e2e -- --library .e2e/public-library
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

interface Download {
  /** Where the file sits in the library: the book id is made from it (src/core/bookid.ts). */
  path: string;
  url: string;
  bytes: number;
  sha256: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const manifestPath = path.join(here, "library.json");

const args = process.argv.slice(2);
const at = args.indexOf("--library");
const library = path.resolve(at >= 0 && args[at + 1] ? args[at + 1]! : path.join(root, ".e2e", "public-library"));
const record = args.includes("--record");

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function whole(file: string, d: Download): Promise<boolean> {
  const size = await fs.stat(file).then((s) => s.size, () => -1);
  return size === d.bytes && (d.sha256 === null || (await sha256(file)) === d.sha256);
}

/** archive.org is now and then slow to answer: a few tries, a little apart. */
async function fetchTo(url: string, file: string): Promise<void> {
  const part = `${file}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part));
      await fs.rename(part, file);
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`could not fetch ${url}: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { about: string; files: Download[] };
  await fs.mkdir(library, { recursive: true });
  let fetched = 0;
  for (const d of manifest.files) {
    const file = path.join(library, ...d.path.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!(await whole(file, d))) {
      process.stdout.write(`fetching ${d.path}\n`);
      await fetchTo(d.url, file);
      fetched++;
    }
    const size = (await fs.stat(file)).size;
    if (size !== d.bytes) throw new Error(`${d.path}: ${size} bytes, expected ${d.bytes}`);
    const hash = await sha256(file);
    if (record) d.sha256 = hash;
    else if (hash !== d.sha256) throw new Error(`${d.path}: sha256 ${hash}, expected ${d.sha256}`);
  }
  if (record) await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  // The EPUB beside the recording, and the transcript where Ribbon keeps it.
  await fs.cp(path.join(here, "library"), library, { recursive: true });
  const records = path.join(here, "records");
  if (await fs.stat(records).then(() => true, () => false)) await fs.cp(records, path.join(library, ".ribbon"), { recursive: true });
  console.log(`${library}: ${manifest.files.length} files checked, ${fetched} fetched${record ? ", hashes written to library.json" : ""}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
