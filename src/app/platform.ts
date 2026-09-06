import type { Platform } from "./controller";
import { browserFileUrl, browserHost, browserLibraryRoot } from "../host/browser";

const ROOT_KEY = "odio.libraryRoot";

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
    const [{ tauriHost, allowLibrary, fileUrl }, dialog] = await Promise.all([import("../host/tauri"), import("@tauri-apps/plugin-dialog")]);
    return {
      host: tauriHost(),
      async pickFolder() {
        const picked = await dialog.open({ directory: true, multiple: false, title: "Choose your audiobook folder" });
        console.info("odio: picked", picked);
        return typeof picked === "string" ? picked : null;
      },
      allowFolder: allowLibrary,
      fileUrl,
      loadRoot,
      saveRoot,
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
