/**
 * The speed report beside the baseline: each measurement next to the last
 * release's, so a change shows (speed.ts, docs/RELEASING.md). Not a pass or a
 * fail, as the report is not. A shared runner is noisy, so a number is marked
 * only when it moved by more than a quarter and more than 2 ms, and a marked
 * number is a question to look into, not a verdict.
 *
 *   npm run e2e:speed-compare -- .e2e/speed-1x.json .e2e/speed-6x.json
 *   npm run e2e:speed-compare -- --save .e2e/speed-1x.json .e2e/speed-6x.json   # these become the baseline
 *
 * Prints Markdown; on GitHub it also goes to the run's summary.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Stat } from "../../src/app/perf";
import type { SpeedPart, SpeedReport } from "./speed";

interface Baseline {
  about: string;
  version: string;
  commit: string;
  measured: string;
  /** Where it was measured, and on which book: numbers from another machine or book do not compare. */
  where: string;
  library: string;
  reports: SpeedReport[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const baselinePath = path.join(here, "speed-baseline.json");

const args = process.argv.slice(2);
const save = args.includes("--save");
const files = args.filter((a) => !a.startsWith("--"));

const cpu = (slow: number) => (slow === 1 ? "CPU as it is" : `CPU ${slow}x slower`);
const ms = (s: Stat | undefined, key: "p50" | "p95") => (s ? `${s[key]}` : "–");

/** Slower or faster by more than a quarter and more than 2 ms; else nothing worth a mark. */
function moved(before: number, after: number): "slower" | "faster" | null {
  const d = after - before;
  if (Math.abs(d) <= 2 || Math.abs(d) <= before / 4) return null;
  return d > 0 ? "slower" : "faster";
}

function mark(before: Stat | undefined, after: Stat | undefined): string {
  if (!before) return "new";
  if (!after) return "gone";
  const m = moved(before.p50, after.p50) ?? moved(before.p95, after.p95);
  return m === "slower" ? "**slower**" : m === "faster" ? "faster" : "";
}

interface Row {
  part: string;
  name: string;
  /** Missing on one side when a measurement is new, or gone. */
  before: Stat | undefined;
  after: Stat | undefined;
  mark: string;
}

function rows(then: SpeedReport | undefined, now: SpeedReport): Row[] {
  const out: Row[] = [];
  for (const p of now.parts) {
    const old: SpeedPart | undefined = then?.parts.find((q) => q.title === p.title);
    const names = [...new Set([...Object.keys(p.stats), ...Object.keys(old?.stats ?? {})])].sort();
    for (const name of names) {
      const before = old?.stats[name];
      const after = p.stats[name];
      out.push({ part: p.title, name, before, after, mark: then ? mark(before, after) : "" });
    }
  }
  return out;
}

function table(list: Row[], withPart: boolean): string {
  const head = withPart ? "| Part | Measurement | p50, then → now | p95, then → now | |\n|---|---|---|---|---|" : "| Measurement | p50, then → now | p95, then → now | |\n|---|---|---|---|";
  const lines = list.map((r) => {
    const cells = [r.name, `${ms(r.before, "p50")} → ${ms(r.after, "p50")}`, `${ms(r.before, "p95")} → ${ms(r.after, "p95")}`, r.mark];
    return `| ${(withPart ? [r.part, ...cells] : cells).join(" | ")} |`;
  });
  return [head, ...lines].join("\n");
}

function facts(then: SpeedReport | undefined, now: SpeedReport): string {
  const lines: string[] = [];
  for (const p of now.parts) {
    if (!p.facts) continue;
    const old = then?.parts.find((q) => q.title === p.title)?.facts;
    const said = Object.entries(p.facts).map(([k, v]) => (old && k in old ? `${k} ${old[k]} → ${v}` : `${k} ${v}`));
    lines.push(`- ${p.title}: ${said.join(", ")}`);
  }
  return lines.join("\n");
}

function compare(baseline: Baseline | null, reports: SpeedReport[]): string {
  const out: string[] = ["# Speed report"];
  const now = reports[0];
  if (now?.version) out.push(`Ribbon ${now.version} (${now.commit}), measured ${now.measured} on ${now.where}, with ${now.library}.`);
  out.push(
    baseline
      ? `Beside the baseline: Ribbon ${baseline.version} (${baseline.commit}), measured ${baseline.measured} on ${baseline.where}, with ${baseline.library}. Marked: moved by more than a quarter and more than 2 ms (p50, else p95). A shared runner is noisy; a mark is a question, not a verdict.`
      : "No baseline yet (tools/e2e/speed-baseline.json): the numbers alone.",
  );
  if (baseline && now && (now.where !== baseline.where || now.library !== baseline.library)) {
    out.push(`**Measured elsewhere than the baseline**, so the numbers do not compare: ${now.where} with ${now.library}, against ${baseline.where} with ${baseline.library}.`);
  }
  for (const now of reports) {
    const then = baseline?.reports.find((r) => r.slow === now.slow);
    const all = rows(then, now);
    const marked = all.filter((r) => r.mark === "**slower**" || r.mark === "faster");
    out.push(`\n## ${cpu(now.slow)}, display ${now.hz} Hz`);
    if (baseline) out.push(marked.length > 0 ? table(marked, true) : "Nothing moved past a quarter and 2 ms.");
    const seen = facts(then, now);
    if (seen) out.push(`\n${seen}`);
    for (const p of now.parts) {
      out.push(`\n<details><summary>${p.title}</summary>\n\n${table(all.filter((r) => r.part === p.title), false)}\n\n</details>`);
    }
  }
  return out.join("\n") + "\n";
}

async function main(): Promise<void> {
  if (files.length === 0) {
    console.error("usage: speed-compare [--save] <report.json> ...  (npm run e2e -- speed --json <report.json>)");
    process.exit(2);
  }
  const reports = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(f, "utf8")) as SpeedReport));
  if (save) {
    // What the reports say of themselves (run.ts writes it): a baseline saved here from a run on GitHub is still GitHub's.
    const first = reports[0]!;
    const baseline: Baseline = {
      about: "The speed report's numbers for the last release (speed-compare.ts): each run on GitHub is compared with them.",
      version: first.version ?? "unknown",
      commit: first.commit ?? "unknown",
      measured: first.measured ?? "unknown",
      where: first.where ?? "unknown",
      library: first.library ?? "unknown",
      reports,
    };
    await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`The baseline is now Ribbon ${baseline.version} (${baseline.commit}), measured on ${baseline.where}: ${path.relative(root, baselinePath)}`);
    return;
  }
  const baseline = await fs.readFile(baselinePath, "utf8").then((t) => JSON.parse(t) as Baseline, () => null);
  const text = compare(baseline, reports);
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
