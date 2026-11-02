/**
 * Whether two checkouts built the same app, file for file. Vite's build is
 * repeatable, so a change meant to change nothing (moving folders, say) can
 * prove it: unlike a passing test run, this notices anything at all, such as
 * the styles Tailwind finds going missing. docs/RELEASING.md says when to use it.
 *
 *   node tools/same-app.mjs <checkout> <other checkout>
 *
 * Run `npm run build` in each first. Exits 1 and lists what differs.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where a checkout's build is. */
function builtApp(checkout) {
  const dist = ["packages/desktop/dist", "dist"].map((d) => path.join(checkout, d)).find((d) => existsSync(d));
  if (!dist) {
    console.error(`No build in ${checkout}: run npm run build there first.`);
    process.exit(2);
  }
  return dist;
}

/** Every file of a build, by its path in the build, as a hash of what's in it. */
function hashes(dist) {
  const files = readdirSync(dist, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
  return new Map(
    files.map((f) => {
      const file = path.join(f.parentPath, f.name);
      return [path.relative(dist, file).split(path.sep).join("/"), createHash("sha256").update(readFileSync(file)).digest("hex")];
    }),
  );
}

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  console.error("Usage: node tools/same-app.mjs <checkout> <other checkout>");
  process.exit(2);
}

const before = hashes(builtApp(first));
const after = hashes(builtApp(second));
const names = [...new Set([...before.keys(), ...after.keys()])].sort();
const differ = names.filter((name) => before.get(name) !== after.get(name));

if (differ.length === 0) {
  console.log(`The same app: all ${names.length} files are identical.`);
  process.exit(0);
}
console.log(`Not the same app: ${differ.length} of ${names.length} files differ.`);
for (const name of differ) console.log(`  ${before.has(name) ? (after.has(name) ? "changed" : "gone") : "new"}: ${name}`);
process.exit(1);
