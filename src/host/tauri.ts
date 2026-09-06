import { readDir, stat, exists, readFile, writeFile, mkdir, remove, rename } from "@tauri-apps/plugin-fs";
import { Command } from "@tauri-apps/plugin-shell";
import { hostname } from "@tauri-apps/plugin-os";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { DirEntry, FileStat, Host, RunResult, Tool } from "./host";

/**
 * Tauri implementation of Host over plugin-fs and plugin-shell. Every
 * path must be inside a library folder that `allowLibrary` has opened;
 * the Rust side refuses anything else.
 */
export function tauriHost(): Host {
  return {
    async readDir(dir: string): Promise<DirEntry[]> {
      const entries = await readDir(dir);
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory, isFile: e.isFile }));
    },
    async stat(p: string): Promise<FileStat> {
      const s = await stat(p);
      return { sizeBytes: Number(s.size), mtimeMs: s.mtime ? Math.round(s.mtime.getTime()) : 0, isDir: s.isDirectory };
    },
    exists: (p: string) => exists(p),
    readFile: (p: string) => readFile(p),
    async writeFile(p: string, data: Uint8Array): Promise<void> {
      const tmp = `${p}.${Date.now()}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, p);
    },
    async mkdir(p: string): Promise<void> {
      if (!(await exists(p))) await mkdir(p, { recursive: true });
    },
    async remove(p: string): Promise<void> {
      if (await exists(p)) await remove(p, { recursive: true });
    },
    run(tool: Tool, args: string[], signal?: AbortSignal): Promise<RunResult> {
      return new Promise((resolve) => {
        const cmd = Command.create(tool, args, { encoding: "utf-8" });
        let stdout = "";
        let stderr = "";
        cmd.stdout.on("data", (line: string) => (stdout += line + "\n"));
        cmd.stderr.on("data", (line: string) => (stderr += line + "\n"));
        cmd.on("error", (e: string) => resolve({ code: 127, stdout, stderr: stderr + e }));
        cmd.on("close", (s: { code: number | null }) => resolve({ code: s.code ?? 1, stdout, stderr }));
        cmd
          .spawn()
          .then((child) => {
            signal?.addEventListener("abort", () => child.kill().catch(() => undefined), { once: true });
          })
          .catch((e: unknown) => resolve({ code: 127, stdout, stderr: String(e) }));
      });
    },
    join: (...parts: string[]) => joinPath(parts),
    deviceName: async () => (await hostname()) ?? "this device",
  };
}

const WINDOWS = /^[A-Za-z]:[\\/]/;

/** Synchronous join with the separator the root already uses. */
export function joinPath(parts: readonly string[]): string {
  const first = parts.find((p) => p.length > 0) ?? "";
  const sep = WINDOWS.test(first) || first.includes("\\") ? "\\" : "/";
  const out: string[] = [];
  parts.forEach((p, i) => {
    if (!p) return;
    let s = p.replace(/[\\/]+/g, sep);
    if (i > 0) s = s.replace(new RegExp(`^\\${sep}+`), "");
    s = s.replace(new RegExp(`\\${sep}+$`), "");
    if (s) out.push(s);
  });
  return out.join(sep);
}

/** Widen the scoped filesystem and asset protocol to a library folder. */
export function allowLibrary(path: string): Promise<void> {
  return invoke("allow_library", { path });
}

/** A URL the webview can stream a file from, with range support. */
export function fileUrl(absPath: string): string {
  return convertFileSrc(absPath);
}
