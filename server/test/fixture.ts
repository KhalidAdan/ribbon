import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer, type RibbonServer } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";

/** A few seconds of tone as an MP3, tagged, with a picture inside when asked. */
export function mp3(file: string, tags: { title: string; album: string; artist: string }, picture?: string, seconds = 3): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`];
  if (picture) args.push("-f", "lavfi", "-i", `color=c=${picture}:s=300x450:d=1`, "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-frames:v", "1");
  args.push("-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "3", "-metadata", `title=${tags.title}`, "-metadata", `album=${tags.album}`, "-metadata", `artist=${tags.artist}`, file);
  execFileSync("ffmpeg", args);
}

/**
 * Two small libraries, made with ffmpeg in `dir`: `shelf/` with a book that
 * has a red picture inside its MP3 and a book in two files, and `copies/`
 * with the first book again, byte for byte, in a folder of another name.
 */
export function makeLibraries(dir: string): { shelf: string; copies: string } {
  const shelf = path.join(dir, "shelf");
  const copies = path.join(dir, "copies");
  mp3(path.join(shelf, "Author One", "Red Book", "01.mp3"), { title: "Red Book", album: "Red Book", artist: "Author One" }, "red");
  mp3(path.join(shelf, "Author Two", "Long Book", "01.mp3"), { title: "Part one", album: "Long Book", artist: "Author Two" });
  mp3(path.join(shelf, "Author Two", "Long Book", "02.mp3"), { title: "Part two", album: "Long Book", artist: "Author Two" });
  mkdirSync(path.join(copies, "Red Book again"), { recursive: true });
  copyFileSync(path.join(shelf, "Author One", "Red Book", "01.mp3"), path.join(copies, "Red Book again", "01.mp3"));
  return { shelf, copies };
}

/**
 * An EPUB 3 of one chapter, made with `zip`: a heading, then a paragraph
 * of each sentence given in turn, joined by spaces.
 */
export function epub(file: string, heading: string, sentences: readonly string[]): void {
  epubOf(file, { title: heading, chapters: [{ heading, sentences }] });
}

/**
 * An EPUB 3, made with `zip`: each chapter a heading and a paragraph of its
 * sentences, and in its contents by its heading; the package's description
 * as given, already escaped for XML.
 */
export function epubOf(file: string, book: { title: string; description?: string; chapters: readonly { heading: string; sentences: readonly string[] }[] }): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ribbon-epub-"));
  const write = (name: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  const chapters = book.chapters.map((c, i) => ({ ...c, id: `c${i + 1}`, href: `chapter-${i + 1}.xhtml` }));
  write("mimetype", "application/epub+zip");
  write("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  write(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:5b0c0d5e-1c6a-4f39-9d0b-2a7f1c9e8a11</dc:identifier><dc:title>${book.title}</dc:title><dc:language>en</dc:language>${book.description ? `<dc:description>${book.description}</dc:description>` : ""}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((c) => `<itemref idref="${c.id}"/>`).join("")}</spine></package>`,
  );
  write("OEBPS/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${chapters.map((c) => `<li><a href="${c.href}">${c.heading}</a></li>`).join("")}</ol></nav></body></html>`);
  for (const c of chapters) write(`OEBPS/${c.href}`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${c.heading}</h1><p>${c.sentences.join(" ")}</p></body></html>`);
  mkdirSync(path.dirname(file), { recursive: true });
  // The mimetype first and stored, as EPUB asks; the rest compressed.
  execFileSync("zip", ["-X0q", file, "mimetype"], { cwd: dir });
  execFileSync("zip", ["-X9rq", file, "META-INF", "OEBPS"], { cwd: dir });
  rmSync(dir, { recursive: true, force: true });
}

/** A fresh server with its data in `dir/data`, and the admin's token from the first invite. */
export async function serverWithAdmin(dir: string, config: Partial<ServerConfig> = {}): Promise<{ server: RibbonServer; admin: string }> {
  const server = await buildServer({ dataDir: path.join(dir, "data"), host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!", ...config });
  const code = server.invites.firstAdmin().code;
  const joined = await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "admin", password: "a long password" } });
  return { server, admin: (joined.json() as { token: string }).token };
}

/** Add a folder as the admin and wait for the job to finish. */
export async function importAs(server: RibbonServer, token: string, folder: string) {
  const started = await server.app.inject({ method: "POST", url: "/api/library/import", payload: { folder }, headers: { authorization: `Bearer ${token}` } });
  const { job } = started.json() as { job: { id: string } };
  await server.jobs.idle("work");
  const done = await server.app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${token}` } });
  return { status: started.statusCode, job: (done.json() as { job: { state: string; progress: import("../src/library/importer.ts").ImportProgress; error: string | null } }).job };
}

/**
 * A stand-in for `ribbon-speech` in `dir`, answering a batch of clips a
 * line, as it does: for a clip starting at a moment in `said`, those
 * phrases, with times in milliseconds of the file; for any other, that
 * ffmpeg couldn't read it. It notes in `asked` what it was asked, one JSON
 * line each: how it was started, then each batch.
 */
export function speechStandIn(dir: string, said: Record<number, { startMs: number; endMs: number; words: string }[]>): { tool: string; asked: string } {
  const tool = path.join(dir, "ribbon-speech.cjs");
  const asked = path.join(dir, "asked.jsonl");
  writeFileSync(
    tool,
    `#!/usr/bin/env node
const fs = require("fs");
const said = ${JSON.stringify(said)};
const lines = require("readline").createInterface({ input: process.stdin });
fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
lines.on("line", (line) => {
  const clips = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify({ clips }) + "\\n");
  console.log(JSON.stringify(clips.map((c) => said[c.startMs] ?? { error: "ffmpeg could not read the audio" })));
});
`,
  );
  chmodSync(tool, 0o755);
  return { tool, asked };
}
