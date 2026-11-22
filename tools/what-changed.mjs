/**
 * What a pull request can affect, so CI runs only the jobs that could notice.
 * It only ever skips what's known to be out of reach: a path it doesn't
 * recognise runs everything, and main always runs everything.
 *
 *   node tools/what-changed.mjs      # writes desktop=true, server=true and so on
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The parts of Ribbon a changed file can affect. */
function reaches(file) {
  // Words alone: nothing to build or run.
  if (file.endsWith(".md") || file.startsWith("docs/")) return [];
  if (file.startsWith("packages/apple/")) return ["apple"];
  // The server's tests run the desktop's own code, and its image builds these two crates.
  if (/^packages\/desktop\/src-tauri\/(ebook|frames)\//.test(file)) return ["desktop", "e2e", "server", "image"];
  if (file.startsWith("packages/desktop/")) return ["desktop", "e2e", "server"];
  if (file.startsWith("packages/server/")) return ["server", "image"];
  // Signing in (packages/auth, auth-accounts, auth-pocket-id) is the server's alone. The end-to-end
  // checks have always run for it all the same, and a change here may only add checks, never drop one.
  if (file.startsWith("packages/auth")) return ["server", "image", "e2e"];
  if (file.startsWith("packages/core/") || file.startsWith("packages/host-node/")) return ["desktop", "e2e", "server", "image"];
  return JOBS;
}

/**
 * The jobs a change can need. `e2e` is the end-to-end checks, which drive the
 * built desktop app (.github/workflows/e2e.yml); the rest are in checks.yml.
 */
const JOBS = ["desktop", "e2e", "server", "image", "apple"];

/** Which jobs to run for these changed files. */
export function jobsFor(files) {
  const reached = new Set(files.flatMap(reaches));
  return Object.fromEntries(JOBS.map((job) => [job, reached.has(job)]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A pull request is checked out merged onto its base, so the first parent is what it changes.
  const everything = process.env.GITHUB_EVENT_NAME !== "pull_request";
  const files = everything ? ["everything"] : execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const jobs = jobsFor(files);
  console.error(everything ? "Not a pull request: every job runs." : `${files.length} files changed.`);
  for (const [job, run] of Object.entries(jobs)) console.log(`${job}=${run}`);
}
