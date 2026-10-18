/**
 * Build a demo library for looking at the interface: real titles,
 * authors, series and covers from the records Ribbon already mirrored on
 * this machine, with one tiny MP3 per book whose header claims the real
 * length. The shelf, the cards and the player look exactly as they would
 * with the real books; the audio is two seconds of silence.
 *
 *   npm run demo-library -- <out-dir> [mirror-dir ...]
 *
 * With no mirror dirs, every mirror under %LOCALAPPDATA%\Ribbon\mirror
 * (or RIBBON_HOME) is used. Nothing is read from or written to the share.
 * Some books get positions, so the shelf shows progress.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { bytesToRows } from "../src/core/csv";
import { nodeHost } from "../src/host/node";
import { loadLibrary, scanLibrary } from "../src/core/scan/scan";
import { serializePosition } from "../src/core/position";
import { sourceFrom } from "../src/core/sources";

interface Row {
  title: string;
  author: string;
  narrator: string;
  series: string;
  seriesIndex: string;
  year: string;
  durationMs: number;
  cover: string | null;
  group: string;
}

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(stderr)) : resolve()));
  });
}

/** Rewrite the Xing/Info frame count so the file claims `durationMs` at 22.05 kHz MPEG-2 layer III (576 samples a frame). */
async function claimDuration(file: string, durationMs: number): Promise<void> {
  const buf = await fs.readFile(file);
  for (const tag of ["Xing", "Info"]) {
    const at = buf.indexOf(tag, 0, "latin1");
    if (at < 0 || at > 4096) continue;
    const flags = buf.readUInt32BE(at + 4);
    if (!(flags & 1)) continue;
    const frames = Math.round((durationMs / 1000) * (22050 / 576));
    buf.writeUInt32BE(frames, at + 8);
    await fs.writeFile(file, buf);
    return;
  }
  throw new Error(`no Xing header in ${file}`);
}

function safe(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
}

async function readMirror(dir: string): Promise<Row[]> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path.join(dir, "library.csv"));
  } catch {
    return [];
  }
  const { rows } = await bytesToRows(bytes);
  const covers = new Set(await fs.readdir(path.join(dir, "covers")).catch(() => [] as string[]));
  return rows.map((r) => {
    const id = r.id ?? "";
    const coverName = [...covers].find((c) => c.startsWith(`${id}.`));
    const folder = (r.path ?? "").split("/")[0] ?? "";
    return {
      title: r.title || r.raw_title || "Untitled",
      author: r.author ?? "",
      narrator: r.narrator ?? "",
      series: r.series ?? "",
      seriesIndex: r.series_index ?? "",
      year: r.year ?? "",
      durationMs: Number(r.duration_ms) || 3_600_000,
      cover: coverName ? path.join(dir, "covers", coverName) : null,
      group: folder,
    };
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const historyOnly = args.includes("--history-only");
  const [outArg, ...mirrorArgs] = args.filter((a) => !a.startsWith("--"));
  if (!outArg) throw new Error("usage: make-demo-library <out-dir> [mirror-dir ...] [--history-only]");
  const out = path.resolve(outArg);
  if (historyOnly) {
    await writeHistory(out);
    return;
  }
  const home = process.env.RIBBON_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Ribbon");
  const mirrors = mirrorArgs.length > 0 ? mirrorArgs : (await fs.readdir(path.join(home, "mirror"))).map((d) => path.join(home, "mirror", d));
  // Name each mirror after the folder it mirrors, when this machine still lists it.
  const names = new Map<string, string>();
  for (const list of ["sources.tsv", "libraries.tsv"]) {
    const text = await fs.readFile(path.join(home, list), "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      const root = line.split("\t").pop()?.trim();
      if (root) names.set(sourceFrom({ root, addedAt: "" }).id, sourceFrom({ root, addedAt: "" }).name);
    }
  }
  const sources = await Promise.all(mirrors.map(async (m) => ({ m, rows: await readMirror(m) })));
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const silence = path.join(out, ".silence.mp3");
  await ff(["-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "2", "-c:a", "libmp3lame", "-b:a", "32k", silence]);
  let made = 0;
  for (const { m, rows } of sources) {
    if (rows.length === 0) continue;
    // A mirror is one source folder: keep its books together under a folder named for it.
    const numbered = rows.filter((r) => /^\d/.test(r.group));
    const loose = rows.filter((r) => !/^\d/.test(r.group));
    const seriesName = numbered.length > 1 ? (names.get(path.basename(m))?.replace(/^.* - /, "") ?? guessSeries(numbered, path.basename(m))) : null;
    for (const r of [...numbered, ...loose].slice(0, 40)) {
      const parent = seriesName && /^\d/.test(r.group) ? path.join(out, safe(seriesName)) : out;
      const folder = path.join(parent, safe(/^\d/.test(r.group) ? r.group : r.title));
      await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, `${safe(r.title)}.mp3`);
      const tags: Record<string, string> = { title: r.title, album: r.title, artist: r.author };
      if (r.narrator) tags.composer = r.narrator;
      if (r.year) tags.date = r.year;
      if (r.series) tags.grouping = r.series;
      await ff(["-i", silence, ...Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]), "-c", "copy", "-write_xing", "1", file]);
      await claimDuration(file, r.durationMs);
      if (r.cover) await fs.copyFile(r.cover, path.join(folder, `cover${path.extname(r.cover)}`));
      made++;
    }
  }
  await fs.rm(silence);
  console.log(`made ${made} books in ${out}; scanning`);
  const { books } = await scanLibrary(nodeHost(), out, {});
  // Progress on a few books, so the shelf has something to show.
  const now = Date.now();
  const positions = path.join(out, ".ribbon", "positions");
  await fs.mkdir(positions, { recursive: true });
  for (const [i, b] of books.entries()) {
    const kind = i % 5;
    if (kind > 2) continue;
    const fraction = kind === 0 ? 0.37 : kind === 1 ? 0.995 : 0.08;
    const p = { bookId: b.book.id, offsetMs: Math.round(b.book.durationMs * fraction), updatedAt: new Date(now - i * 3_600_000 * 7).toISOString(), device: "demo" };
    await fs.writeFile(path.join(positions, `${b.book.id}.csv`), await serializePosition(p));
  }
  console.log(`scanned ${books.length} books; positions on ${Math.ceil((books.length * 3) / 5)}`);
  await writeHistory(out);
}

/** "Warhammer 40K - The Horus Heresy" from the books' series tags, else the mirror name. */
function guessSeries(rows: Row[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.series) counts.set(r.series, (counts.get(r.series) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : `Series ${fallback.slice(0, 6)}`;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

/**
 * A year of listening in a log of a device of its own: sessions on most
 * days, more at weekends, a few books finished. Deterministic, so the
 * Stats page looks the same on every run.
 */
async function writeHistory(out: string): Promise<void> {
  const books = await loadLibrary(nodeHost(), out);
  if (!books || books.length === 0) return;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const dev = "urn:uuid:00000000-0000-4000-8000-00000000demo";
  const lines: string[] = [];
  let seq = 1;
  const now = Date.now();
  const day = 86_400_000;
  const listened = books.slice(0, 18);
  for (let d = 330; d >= 0; d--) {
    const date = new Date(now - d * day);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    if (rand() < (weekend ? 0.15 : 0.3)) continue;
    const sessions = 1 + Math.floor(rand() * (weekend ? 3 : 2));
    for (let i = 0; i < sessions; i++) {
      const b = listened[Math.floor(rand() * rand() * listened.length)]!;
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 7 + Math.floor(rand() * 14), Math.floor(rand() * 60)).getTime();
      const ms = Math.round((10 + rand() * (weekend ? 110 : 60)) * 60_000);
      const book = { ids: [`urn:ribbon:${b.book.id}`], dur_ms: b.book.durationMs };
      lines.push(JSON.stringify({ v: 1, k: "session", dev, seq: seq++, t: new Date(start + ms).toISOString(), book, start: new Date(start).toISOString(), end: new Date(start + ms).toISOString(), from_ms: 0, to_ms: ms, listened_ms: ms, speed: 1 }));
    }
  }
  for (let i = 0; i < 9; i++) {
    const b = listened[i]!;
    const finished = now - (i * 31 + 3) * day;
    const started = finished - (12 + i * 3) * day;
    lines.push(JSON.stringify({ v: 1, k: "read", dev, seq: seq++, t: new Date(finished).toISOString(), book: { ids: [`urn:ribbon:${b.book.id}`] }, id: `urn:uuid:demo-read-${i}`, started: new Date(started).toISOString(), finished: new Date(finished).toISOString() }));
  }
  const dir = path.join(out, ".ribbon", "positions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "00000000-0000-4000-8000-00000000demo.ndjson"), lines.join("\n") + "\n");
  await fs.writeFile(path.join(dir, "00000000-0000-4000-8000-00000000demo.json"), JSON.stringify({ id: dev, name: "Demo phone", app: "demo", format: "ribbon-position-log/1" }) + "\n");
  console.log(`history: ${lines.length} records`);
}
