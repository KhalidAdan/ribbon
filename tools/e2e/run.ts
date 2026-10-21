/**
 * Ribbon's end-to-end checks, run against the built app before every
 * release (docs/RELEASING.md). They cover what unit tests cannot see: a
 * window resized, a page swiped, a book opened from cold, the narrator
 * followed for real. The 0.12.0 resize regression is why they exist.
 *
 *   npm run e2e -- --build          # build the measurement build, then run every check
 *   npm run e2e                     # every check, against the last build
 *   npm run e2e -- swipe resize     # some checks
 *   npm run e2e -- --slow 6         # with the CPU six times slower, as a slow machine
 *   npm run e2e -- speed            # the speed report instead (see speed.ts)
 *
 * Options: --library <folder> (default .e2e/library, or RIBBON_E2E_LIBRARY),
 * --exe <path>, --attach (an app already running with the debugging port),
 * --json <file> (the speed report's numbers, for speed-compare.ts).
 * Exits non-zero, listing what failed, when any check fails.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { launch, type Ribbon } from "./app";
import { Tally } from "./tally";
import { openCheck } from "./checks/open";
import { swipeCheck } from "./checks/swipe";
import { resizeCheck } from "./checks/resize";
import { readAlongCheck } from "./checks/readalong";
import { scrollCheck } from "./checks/scroll";
import { speedReport } from "./speed";

export interface Check {
  name: string;
  /** What it covers, for the listing. */
  about: string;
  run(r: Ribbon, t: Tally): Promise<void>;
}

const CHECKS: Check[] = [openCheck, swipeCheck, resizeCheck, readAlongCheck, scrollCheck];

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const named = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(slow|library|exe|port|json)$/));
const slow = Number(option("slow") ?? 1);

if (flag("build")) {
  console.log("Building the measurement build (RIBBON_PROFILE=1)…");
  const built = spawnSync("npm run tauri build -- --no-bundle", { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, RIBBON_PROFILE: "1" } });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const unknown = named.filter((n) => n !== "speed" && !CHECKS.some((c) => c.name === n));
if (unknown.length > 0) {
  console.error(`No check called ${unknown.join(", ")}. The checks: ${CHECKS.map((c) => c.name).join(", ")}, and speed.`);
  process.exit(2);
}

// Cargo builds into target/ at the root (.cargo/config.toml) unless CARGO_TARGET_DIR says otherwise, as on GitHub's Windows runner.
const target = process.env.CARGO_TARGET_DIR || path.join(root, "target");

const library = option("library") ?? process.env.RIBBON_E2E_LIBRARY ?? path.join(root, ".e2e", "library");

const r = await launch({
  exe: option("exe") ?? path.join(target, "release", process.platform === "win32" ? "ribbon.exe" : "ribbon"),
  library,
  work: path.join(root, ".e2e", "run"),
  port: Number(option("port") ?? 9222),
  attach: flag("attach"),
});

let failures: string[] = [];
try {
  if (named.includes("speed")) {
    const report = await speedReport(r, slow);
    const json = option("json");
    if (json) {
      const version = (JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string }).version;
      const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).stdout?.toString().trim();
      const where = process.env.GITHUB_ACTIONS ? `GitHub Actions (${process.env.ImageOS ?? process.env.RUNNER_OS})` : `by hand (${process.platform})`;
      const measured = new Date().toISOString().slice(0, 10);
      await fs.writeFile(json, JSON.stringify({ ...report, version, commit, measured, where, library: path.basename(library) }, null, 2) + "\n");
    }
  } else {
    const chosen = named.length > 0 ? CHECKS.filter((c) => named.includes(c.name)) : CHECKS;
    await r.slow(slow);
    console.log(`CPU ${slow === 1 ? "as it is" : `${slow}x slower`}`);
    for (const check of chosen) {
      console.log(`\n${check.name}: ${check.about}`);
      const t = new Tally(check.name);
      try {
        await check.run(r, t);
      } catch (e) {
        t.expect(false, "ran to the end", e instanceof Error ? e.message.split("\n")[0]! : String(e));
      }
      console.log(`  ${t.summary}`);
      failures = failures.concat(t.failures);
    }
  }
} finally {
  await r.close();
}

if (failures.length > 0) {
  console.log(`\nFailed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nEvery check passed.");
