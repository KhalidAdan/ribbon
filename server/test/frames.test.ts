import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import type { StoredBook } from "../src/library/books.ts";
import { importAs, serverWithAdmin } from "./fixture.ts";

/** Twenty seconds of noisy tone as a VBR MP3 with no seek table: the kind a player seeks in by guess. */
function vbrMp3(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=20", "-f", "lavfi", "-i", "anoisesrc=d=20:a=0.3", "-filter_complex", "[0][1]amix=inputs=2,volume=2", "-c:a", "libmp3lame", "-q:a", "4", "-write_xing", "0", "-metadata", "title=Noise", "-metadata", "album=Noise", "-metadata", "artist=An Author", file]);
}

/**
 * An MP3 from the exact moment, for a player that streams (the TV): the file
 * from the frame where the moment falls, as if it began there.
 */
describe("an MP3 from a moment", () => {
  let dir: string;
  let server: RibbonServer;
  let token = "";
  let id = "";
  let mp3 = "";
  let file = "";

  beforeAll(async () => {
    const tool = builtTool("ribbon-frames");
    expect(tool, "build the frames tool first: cargo build --manifest-path src-tauri/Cargo.toml -p ribbon-frames").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-frames-"));
    vbrMp3(path.join(dir, "library", "Noise", "01.mp3"));
    const made = await serverWithAdmin(dir, { framesTool: tool });
    server = made.server;
    token = made.admin;
    await importAs(server, token, path.join(dir, "library"));
    id = server.books.list()[0]!.id;
    const stored = JSON.parse(readFileSync(path.join(dir, "data", "books", id, "book.json"), "utf8")) as StoredBook;
    file = stored.files[0]!.path;
    mp3 = path.join(dir, "data", "books", id, file);
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...headers } });

  it("starts at the frame where the moment falls, the rest of the file as it is", async () => {
    const r = await get(`/api/books/${id}/files/${file}?ms=12500`);
    expect(r.statusCode).toBe(200);
    const body = r.rawPayload;
    const whole = readFileSync(mp3);
    expect(body.length).toBeLessThan(whole.length);
    // A frame begins it, and it's the end of the file, byte for byte.
    expect([body[0], body[1]! & 0xe0]).toEqual([0xff, 0xe0]);
    expect(body.equals(whole.subarray(whole.length - body.length))).toBe(true);
    // The frame holds the moment: a frame is 26 ms.
    const startsAt = Number(r.headers["x-ribbon-starts-at-ms"]);
    expect(12_500 - startsAt).toBeGreaterThanOrEqual(0);
    expect(12_500 - startsAt).toBeLessThan(27);
    // Kept beside the book, so the file is read whole once.
    expect(readFileSync(path.join(dir, "data", "books", id, "frames", "0.bin")).subarray(0, 8).toString()).toBe("RBFI0002");
  });

  it("answers ranges within what it sends, as a player asks for them", async () => {
    const whole = await get(`/api/books/${id}/files/${file}?ms=12500`);
    const part = await get(`/api/books/${id}/files/${file}?ms=12500`, { range: "bytes=100-199" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 100-199/${whole.rawPayload.length}`);
    expect(part.rawPayload.equals(whole.rawPayload.subarray(100, 200))).toBe(true);
  });

  it("sends the whole file without a moment, or for a moment at its start", async () => {
    const size = readFileSync(mp3).length;
    expect((await get(`/api/books/${id}/files/${file}`)).rawPayload.length).toBe(size);
    expect((await get(`/api/books/${id}/files/${file}?ms=0`)).rawPayload.length).toBe(size);
  });
});
