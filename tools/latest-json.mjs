/**
 * Writes latest.json: what every installed Ribbon asks GitHub for, to learn
 * of a new version (packages/desktop/src/app/updates.ts, docs/RELEASING.md,
 * section 6). The release workflow runs it once a tag's installers are on its
 * draft, with their signatures in a folder:
 *
 *   node tools/latest-json.mjs v0.30.0 <folder of .sig files> > latest.json
 *
 * Each system's entry names the file Tauri's updater fetches, and that file's
 * signature, made with the release key. The updater looks first for its
 * system and how it was installed (`windows-x86_64-msi`), then its system
 * alone (`windows-x86_64`), so a Ribbon installed from the setup and one
 * installed from the MSI each update from their own kind. A file missing is
 * an error: a manifest without one system would leave it on the old version
 * without a word.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASES = "https://github.com/KhalidAdan/ribbon/releases";

/** The files an update is made of, by how their names end after `Ribbon_<version>`, and the updater's names for the systems each is for. */
const FILES = [
  { ends: "_x64-setup.exe", platforms: ["windows-x86_64"] },
  { ends: "_x64_en-US.msi", platforms: ["windows-x86_64-msi"] },
  { ends: "_aarch64.app.tar.gz", platforms: ["darwin-aarch64"] },
];

/**
 * The manifest for a tag, from each file's signature by file name (the
 * contents of `<file>.sig`). Throws when one is missing.
 */
export function latestJson(tag, signatures, now = new Date()) {
  const version = tag.replace(/^v/, "");
  const platforms = {};
  for (const { ends, platforms: names } of FILES) {
    const file = `Ribbon_${version}${ends}`;
    const signature = signatures[file]?.trim();
    if (!signature) throw new Error(`No signature for ${file}: is it on the release, and was it built with TAURI_SIGNING_PRIVATE_KEY?`);
    for (const name of names) platforms[name] = { signature, url: `${RELEASES}/download/${tag}/${file}` };
  }
  return {
    version,
    notes: `What's new in Ribbon ${version}: ${RELEASES}/tag/${tag}`,
    pub_date: now.toISOString().replace(/\.\d+Z$/, "Z"),
    platforms,
  };
}

/** Every `<file>.sig` in a folder, as file name to signature. */
function signaturesIn(folder) {
  const found = {};
  for (const name of readdirSync(folder)) if (name.endsWith(".sig")) found[name.slice(0, -".sig".length)] = readFileSync(join(folder, name), "utf8");
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, folder] = process.argv.slice(2);
  if (!tag || !folder) {
    console.error("Usage: node tools/latest-json.mjs <vX.Y.Z> <folder of .sig files>");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(latestJson(tag, signaturesIn(folder)), null, 2)}\n`);
}
