import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { DirEntry, FileStat, Host, RunResult, Tool } from "./host";

/** Node implementation of Host. Used by tests and the CLI. */
export function nodeHost(): Host {
  return {
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
      await fs.rename(tmp, p);
    },
    async mkdir(p: string): Promise<void> {
      await fs.mkdir(p, { recursive: true });
    },
    async remove(p: string): Promise<void> {
      await fs.rm(p, { force: true, recursive: true });
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
    join: (...parts: string[]) => path.join(...parts),
    async deviceName(): Promise<string> {
      return os.hostname();
    },
  };
}
