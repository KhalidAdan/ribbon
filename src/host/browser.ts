import type { DirEntry, FileStat, Host, KnownFile, RunResult, ScanOutput, ScanProgress, TextFile, Tool } from "./host";

/**
 * Development-only Host that talks to the Vite plugin in
 * tools/vite-dev-library.ts. Lets the whole app, including real audio,
 * run in a plain browser tab against a library folder on this machine.
 * Never shipped: the Tauri build has no server behind it.
 */
export function browserHost(base = "/__ribbon"): Host {
  async function call<T>(op: string, body: unknown): Promise<T> {
    const r = await fetch(`${base}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${op}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
  return {
    readDir: (path) => call<DirEntry[]>("readDir", { path }),
    stat: (path) => call<FileStat>("stat", { path }),
    exists: (path) => call<boolean>("exists", { path }),
    async readFile(path: string): Promise<Uint8Array> {
      const r = await fetch(`${base}/file?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(`readFile ${path}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      const r = await fetch(`${base}/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: data as BodyInit });
      if (!r.ok) throw new Error(`writeFile ${path}: ${r.status}`);
    },
    mkdir: (path) => call<void>("mkdir", { path }),
    remove: (path) => call<void>("remove", { path }),
    rename: (from, to) => call<void>("rename", { from, to }),
    run: (tool: Tool, args: string[]) => call<RunResult>("run", { tool, args }),
    join: (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
    deviceName: async () => "browser-dev",
    async scan(root: string, known: KnownFile[], onProgress?: (p: ScanProgress) => void): Promise<ScanOutput> {
      // The dev server scans in one request; nothing streams back.
      onProgress?.({ walked: 0, done: 0 });
      return call<ScanOutput>("scan", { root, known });
    },
    readTextDir: (dir) => call<TextFile[]>("readTextDir", { dir }),
  };
}

export function browserFileUrl(absPath: string, base = "/__ribbon"): string {
  return `${base}/file?path=${encodeURIComponent(absPath)}`;
}

/** The library root the dev server was started with. */
export async function browserLibraryRoot(base = "/__ribbon"): Promise<string | null> {
  try {
    const r = await fetch(`${base}/root`);
    if (!r.ok) return null;
    return ((await r.json()) as { root: string | null }).root;
  } catch {
    return null;
  }
}
