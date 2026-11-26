import type { DirEntry, FileStat, Host, KnownFile, RunResult, ScanOutput, ScanProgress, TextFile, Tool } from "@ribbon/core/host";

/**
 * Development-only Host that talks to the Vite plugin in
 * packages/desktop/tools/vite-dev-library.ts. Lets the whole app, including real audio,
 * run in a plain browser tab against a library folder on this machine.
 * Never shipped: the Tauri build has no server behind it.
 */
export function browserHost(base = "/__ribbon"): Host {
  async function call<T>(op: string, body: unknown): Promise<T> {
    const r = await fetch(`${base}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      const text = await r.text();
      // The ebook op answers errors in the app's own words ("drm: …"); pass those through as they are.
      const said = (() => {
        try {
          return (JSON.parse(text) as { error?: string }).error;
        } catch {
          return undefined;
        }
      })();
      throw new Error(said && /^(drm|unreadable):/.test(said) ? said : `${op}: ${r.status} ${text}`);
    }
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
    async appendFile(path: string, data: Uint8Array): Promise<void> {
      const r = await fetch(`${base}/file?path=${encodeURIComponent(path)}&append=1`, { method: "PUT", body: data as BodyInit });
      if (!r.ok) throw new Error(`appendFile ${path}: ${r.status}`);
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
    catalogSearch: (title, author, region) => call<string>("catalog", { title, author, region }),
    // The harness asks a stand-in for ComicVine, never the real one (packages/desktop/tools/vite-dev-library.ts).
    comicVineAsk: (key, request) => call<{ status: number; body: string }>("comicvine", { key, request }),
    async comicVinePicture(url) {
      const r = await fetch(`${base}/comicvinePicture?url=${encodeURIComponent(url)}`);
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    comicVineOpen: async (url) => void window.open(url, "_blank", "noopener"),
    openEbook: (path) => call<string>("ebook", { path }),
    comicEntries: (path) => call<{ name: string; size?: number; packed?: number }[]>("comicEntries", { path }),
    comicCover: (path, entry, target, width) => call<boolean>("comicCover", { path, entry, target, width }),
    // EPUB covers only; audio covers fall back to ffmpeg, as before.
    extractCover: (src, target) => call<boolean>("cover", { src, target }),
    // In one request: the progress shows only at the end.
    async serverDownload(url, token, target, size, onProgress) {
      await call<boolean>("serverDownload", { url, token, target, size });
      onProgress(size, size);
    },
    freeSpace: (path) => call<number>("freeSpace", { path }),
  };
}

export function browserFileUrl(absPath: string, base = "/__ribbon"): string {
  return `${base}/file?path=${encodeURIComponent(absPath)}`;
}

/** One page of a comic, read out of its archive by the dev server (packages/host-node/src/comic.ts). */
export function browserComicPageUrl(absPath: string, entry: string, version: string, small = false, base = "/__ribbon"): string {
  return `${base}/comicPage?path=${encodeURIComponent(absPath)}&entry=${encodeURIComponent(entry)}&v=${encodeURIComponent(version)}${small ? "&small=1" : ""}`;
}

/** Keep a PDF's page drawn small, as the app keeps one in its own folder. */
export async function browserKeepSmallPage(absPath: string, entry: string, jpeg: Uint8Array, base = "/__ribbon"): Promise<void> {
  const r = await fetch(`${base}/comicSmall?path=${encodeURIComponent(absPath)}&entry=${encodeURIComponent(entry)}`, { method: "PUT", body: jpeg as BodyInit });
  if (!r.ok) throw new Error(`the small page wasn't kept: ${r.status}`);
}

/** The harness's stand-in for Ribbon's own folder, inside the library's records. */
export function browserHome(base = "/__ribbon"): Promise<string> {
  return fetch(`${base}/home`, { method: "POST", body: "{}" }).then((r) => r.json() as Promise<string>);
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
