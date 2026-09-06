import type { Platform } from "./controller";
import { browserFileUrl, browserHost, browserLibraryRoot } from "../host/browser";
import { log } from "./log";

const ROOT_KEY = "ribbon.libraryRoot";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function loadRoot(): string | null {
  try {
    return localStorage.getItem(ROOT_KEY);
  } catch {
    return null;
  }
}

function saveRoot(root: string | null): void {
  try {
    if (root) localStorage.setItem(ROOT_KEY, root);
    else localStorage.removeItem(ROOT_KEY);
  } catch {
    /* private mode */
  }
}

export async function detectPlatform(): Promise<Platform> {
  if (isTauri()) {
    const [{ tauriHost, allowLibrary, fileUrl, uptimeMs, envLibrary }, dialog] = await Promise.all([import("../host/tauri"), import("@tauri-apps/plugin-dialog")]);
    return {
      host: tauriHost(),
      async pickFolder(near) {
        // Open one level up so the current library is a folder you can
        // see and click, not a folder you are already inside.
        const parent = near ? near.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") : undefined;
        const picked = await dialog.open({ directory: true, multiple: false, title: "Choose your audiobook folder", ...(parent ? { defaultPath: parent } : {}) });
        log.info("picked", picked);
        return typeof picked === "string" ? picked : null;
      },
      allowFolder: allowLibrary,
      fileUrl,
      loadRoot,
      saveRoot,
      defaultRoot: envLibrary,
      uptimeMs,
    };
  }
  // Development harness: the Vite plugin serves one folder from this machine.
  return {
    host: browserHost(),
    pickFolder: () => browserLibraryRoot(),
    allowFolder: async () => undefined,
    fileUrl: browserFileUrl,
    loadRoot: () => null,
    saveRoot: () => undefined,
    defaultRoot: () => browserLibraryRoot(),
  };
}
