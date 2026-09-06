/**
 * Generate the fixture library described in docs/TEST-PLAN.md with
 * ffmpeg. Deterministic, small, never committed. Safe to re-run: a
 * version marker skips regeneration when nothing changed.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FIXTURE_VERSION = "8";
const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.resolve(here, "..", "test", "fixtures", "generated");

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(`ffmpeg ${args.join(" ")}\n${stderr}`));
      else resolve();
    });
  });
}

/** A tone source of `seconds` at 22.05 kHz. `volumeDb` sets level. */
function tone(seconds: number, volumeDb = -20, freq = 440): string[] {
  return [...toneInput(seconds, freq), ...vol(volumeDb)];
}

function toneInput(seconds: number, freq = 440): string[] {
  return ["-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=22050:duration=${seconds}`];
}

function vol(volumeDb: number): string[] {
  return ["-af", `volume=${volumeDb}dB`];
}

function meta(pairs: Record<string, string>): string[] {
  return Object.entries(pairs).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
}

async function mp3(file: string, seconds: number, tags: Record<string, string>, volumeDb = -20): Promise<void> {
  await ff([...tone(seconds, volumeDb), ...meta(tags), "-c:a", "libmp3lame", "-b:a", "48k", file]);
}

async function m4a(file: string, seconds: number, tags: Record<string, string>): Promise<void> {
  await ff([...tone(seconds), ...meta(tags), "-c:a", "aac", "-b:a", "48k", file]);
}

async function cover(file: string): Promise<void> {
  await ff(["-f", "lavfi", "-i", "color=c=0x3355aa:s=200x200:d=1", "-frames:v", "1", file]);
}

export async function makeFixtures(root = FIXTURE_ROOT): Promise<string> {
  const marker = path.join(root, ".version");
  try {
    if ((await fs.readFile(marker, "utf8")) === FIXTURE_VERSION) return root;
  } catch {
    /* regenerate */
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const at = (...p: string[]) => path.join(root, ...p);
  const mk = (...p: string[]) => fs.mkdir(at(...p), { recursive: true });

  // 1. Single M4B with three embedded chapters, cover, full tags.
  await mk("single-m4b");
  const coverPng = at("single-m4b", "cover-src.png");
  await cover(coverPng);
  const chapters = [
    ";FFMETADATA1",
    "title=The Single Book",
    "artist=Ada Author",
    "composer=Nora Narrator",
    "album=The Single Book",
    "date=2021-03-04",
    "grouping=Fixture Series",
    "genre=Audiobook",
    "",
    "[CHAPTER]",
    "TIMEBASE=1/1000",
    "START=0",
    "END=2000",
    "title=Opening",
    "[CHAPTER]",
    "TIMEBASE=1/1000",
    "START=2000",
    "END=4000",
    "title=Middle",
    "[CHAPTER]",
    "TIMEBASE=1/1000",
    "START=4000",
    "END=6000",
    "title=Closing",
    "",
  ].join("\n");
  const metaFile = at("single-m4b", "meta.txt");
  await fs.writeFile(metaFile, chapters);
  await ff([
    ...toneInput(6),
    "-i",
    metaFile,
    "-i",
    coverPng,
    ...vol(-20),
    "-map",
    "0:a",
    "-map",
    "2:v",
    "-map_metadata",
    "1",
    "-map_chapters",
    "1",
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    "-c:v",
    "mjpeg",
    "-disposition:v",
    "attached_pic",
    "-f",
    "ipod",
    at("single-m4b", "book.m4b"),
  ]);
  await fs.rm(metaFile);
  await fs.rm(coverPng);

  // 2. Multi MP3 where track tags reverse the filename order.
  await mk("multi-mp3");
  for (let i = 1; i <= 5; i++) {
    const track = 6 - i;
    await mp3(at("multi-mp3", `0${i}.mp3`), 2, {
      title: `Part ${track}`,
      artist: "Bea Author",
      album: "The Multi Book (Unabridged)",
      track: `${track}/5`,
      date: "1999",
      series: "Multi Series",
      "series-part": "2.5",
    });
  }
  await cover(at("multi-mp3", "cover.jpg"));

  // 3. Multi M4A with natural-sort names and no track tags.
  await mk("multi-m4a-natural");
  for (let i = 1; i <= 12; i++) {
    await m4a(at("multi-m4a-natural", `Chapter ${i}.m4a`), 1, { album: "Natural Book", artist: "Cal Author" });
  }

  // 4. Loose file at the root.
  await mp3(at("loose.mp3"), 3, { title: "Loose Episode", artist: "Dee Author" });

  // 5. Quiet and loud versions of the same tone.
  await mk("quiet");
  await mk("loud");
  await mp3(at("quiet", "quiet.mp3"), 4, { album: "Quiet Book" }, -27);
  await mp3(at("loud", "loud.mp3"), 4, { album: "Loud Book" }, -7);

  // 6. A file with three silences of 2, 3, and 5 seconds.
  await mk("gaps");
  await ff([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=22050:duration=18",
    "-af",
    "volume=-20dB,volume=enable='between(t,2,4)+between(t,6,9)+between(t,11,16)':volume=0",
    ...meta({ album: "Gaps Book" }),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "48k",
    at("gaps", "gaps.mp3"),
  ]);

  // 7. Opus and FLAC.
  await mk("opus");
  await mk("flac");
  await ff([...tone(2), ...meta({ album: "Opus Book" }), "-c:a", "libopus", "-b:a", "32k", at("opus", "tone.opus")]);
  await ff([...tone(2), ...meta({ album: "Flac Book" }), "-c:a", "flac", at("flac", "tone.flac")]);

  // 8. Nested series.
  await mk("nested", "Series", "Book One");
  await mk("nested", "Series", "Book Two");
  await mp3(at("nested", "Series", "Book One", "01.mp3"), 1, { album: "Book One", track: "1" });
  await mp3(at("nested", "Series", "Book One", "02.mp3"), 1, { album: "Book One", track: "2" });
  await mp3(at("nested", "Series", "Book Two", "01.mp3"), 1, { album: "Book Two", track: "1" });
  await fs.writeFile(at("nested", "Series", "Book One", "notes.txt"), "not audio");

  await fs.writeFile(marker, FIXTURE_VERSION);
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeFixtures().then((r) => console.log(`fixtures at ${r}`), (e) => {
    console.error(e);
    process.exit(1);
  });
}
