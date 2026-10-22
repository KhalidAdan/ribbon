import { promises as fs } from "node:fs";
import { catalogUrl } from "../core/chapternames";
import type { Region } from "../core/audnexus";
import { renameWithRetry } from "./retry";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Source } from "@culvert/stream";
import type { DirEntry, FileStat, Host, RunResult, TextFile, Tool } from "./host";
import { scanWithFfprobe } from "./scan-with-ffprobe";

/**
 * Node implementation of Host. Used by tests and the CLI. Node cannot
 * read an EPUB's package itself; give it a reader (the dev server runs
 * the Rust one) and its scans read them too.
 */
export function nodeHost(opts: Pick<Host, "readEbookPackage" | "extractCover"> = {}): Host {
  const host: Host = {
    ...opts,
    async readDir(dir: string): Promise<DirEntry[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
    },
    async stat(p: string): Promise<FileStat> {
      const s = await fs.stat(p);
      return { sizeBytes: s.size, mtimeMs: Math.round(s.mtimeMs), isDir: s.isDirectory() };
    },
    async exists(p: string): Promise<boolean> {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    readFile(p: string): Promise<Uint8Array> {
      return fs.readFile(p);
    },
    async writeFile(p: string, data: Uint8Array): Promise<void> {
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, data);
      await renameWithRetry(() => fs.rename(tmp, p));
    },
    async appendFile(p: string, data: Uint8Array): Promise<void> {
      await fs.appendFile(p, data);
    },
    async mkdir(p: string): Promise<void> {
      await fs.mkdir(p, { recursive: true });
    },
    async remove(p: string): Promise<void> {
      await fs.rm(p, { force: true, recursive: true });
    },
    async rename(from: string, to: string): Promise<void> {
      await fs.rename(from, to);
    },
    run(tool: Tool, args: string[], signal?: AbortSignal): Promise<RunResult> {
      return new Promise((resolve) => {
        const opts = { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}) };
        execFile(tool, args, opts, (err, stdout, stderr) => {
          const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr ?? (err ? err.message : "")) });
        });
      });
    },
    stream(tool: Tool, args: string[], signal?: AbortSignal): Source<string> {
      return (async function* () {
        const child = spawn(tool, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        child.on("error", () => undefined);
        const onAbort = () => child.kill();
        signal?.addEventListener("abort", onAbort, { once: true });
        const rl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
        try {
          for await (const line of rl) yield line;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          rl.close();
          if (child.exitCode === null) child.kill();
        }
      })();
    },
    async serverDownload(url: string, token: string, target: string, size: number, onProgress: (done: number, total: number) => void): Promise<void> {
      // The same contract as the app's Rust download: a .part file, carried on from where it stopped.
      const part = `${target}.part`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      const have = await fs.stat(part).then((s) => s.size).catch(() => 0);
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (have > 0 && have < size) headers.range = `bytes=${have}-`;
      const r = await fetch(url, { headers });
      if (r.status !== 200 && r.status !== 206) throw new Error(`the server answered ${r.status}`);
      const file = await fs.open(part, r.status === 206 ? "a" : "w");
      let done = r.status === 206 ? have : 0;
      try {
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          await file.write(chunk);
          done += chunk.length;
          onProgress(done, size);
        }
      } finally {
        await file.close();
      }
      if (done !== size) throw new Error("the download was cut short; it will carry on from there");
      await fs.rename(part, target);
    },
    async freeSpace(at: string): Promise<number> {
      let dir = at;
      while (!(await fs.stat(dir).then(() => true, () => false))) dir = path.dirname(dir);
      const s = await fs.statfs(dir);
      return s.bavail * s.bsize;
    },
    join: (...parts: string[]) => path.join(...parts),
    async deviceName(): Promise<string> {
      return os.hostname();
    },
    scan: (root, known, onProgress, onFiles) => scanWithFfprobe(host, root, known, onProgress, onFiles),
    async catalogSearch(title: string, author: string, region: string): Promise<string> {
      const r = await fetch(catalogUrl(title, author, region as Region), { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`catalog answered ${r.status}`);
      return r.text();
    },
    async writeTextFiles(files) {
      for (const f of files) {
        await fs.mkdir(path.dirname(f.path), { recursive: true });
        await host.writeFile(f.path, new TextEncoder().encode(f.text));
      }
    },
    async readTextDir(dir: string): Promise<TextFile[]> {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return [];
      }
      const out: TextFile[] = [];
      for (const name of names) {
        const p = path.join(dir, name);
        try {
          const s = await fs.stat(p);
          if (!s.isFile() || s.size > 1_048_576) continue;
          out.push({ name, text: await fs.readFile(p, "utf8") });
        } catch {
          /* skip */
        }
      }
      return out;
    },
  };
  return host;
}
