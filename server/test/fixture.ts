import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildServer, type RibbonServer } from "../src/app.ts";

/** A few seconds of tone as an MP3, tagged, with a picture inside when asked. */
export function mp3(file: string, tags: { title: string; album: string; artist: string }, picture?: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
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

/** A fresh server with its data in `dir/data`, and the admin's token from the first invite. */
export async function serverWithAdmin(dir: string): Promise<{ server: RibbonServer; admin: string }> {
  const server = await buildServer({ dataDir: path.join(dir, "data"), host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" });
  const code = server.invites.firstAdmin().code;
  const joined = await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "admin", password: "a long password" } });
  return { server, admin: (joined.json() as { token: string }).token };
}

/** Add a folder as the admin and wait for the job to finish. */
export async function importAs(server: RibbonServer, token: string, folder: string) {
  const started = await server.app.inject({ method: "POST", url: "/api/library/import", payload: { folder }, headers: { authorization: `Bearer ${token}` } });
  const { job } = started.json() as { job: { id: string } };
  await server.jobs.idle();
  const done = await server.app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${token}` } });
  return { status: started.statusCode, job: (done.json() as { job: { state: string; progress: import("../src/library/importer.ts").ImportProgress; error: string | null } }).job };
}
