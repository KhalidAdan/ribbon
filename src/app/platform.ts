import type { Platform } from "./controller";
import type { SourceEntry } from "../core/sources";
import { browserFileUrl, browserHost, browserLibraryRoot } from "../host/browser";
import { log } from "./log";

/** Where the remembered library lived before the Ribbon folder existed. */
const LEGACY_ROOT_KEY = "ribbon.libraryRoot";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function legacyRoot(): string | null {
  try {
    return localStorage.getItem(LEGACY_ROOT_KEY);
  } catch {
    return null;
  }
}

function clearLegacyRoot(): void {
  try {
    localStorage.removeItem(LEGACY_ROOT_KEY);
  } catch {
    /* private mode */
  }
}

/** Settings that last for the session only, for the harness and tests. */
export function memorySettings(): NonNullable<Platform["appSettings"]> {
  let store: Record<string, unknown> = {};
  return { read: async () => ({ ...store }), write: async (s) => void (store = { ...s }) };
}

/** Sources that last for the session only, for the harness and tests. */
export function memorySources(): Platform["sources"] {
  let list: SourceEntry[] = [];
  return { load: async () => list.map((s) => ({ ...s })), save: async (next) => void (list = next.map((s) => ({ ...s }))) };
}

export async function detectPlatform(): Promise<Platform> {
  if (isTauri()) {
    const [{ tauriHost, allowLibrary, fileUrl, uptimeMs, envLibrary, homeInfo, sourcesRead, sourcesWrite, revealHome, resetHome, appSettingsRead, appSettingsWrite }, dialog] = await Promise.all([
      import("../host/tauri"),
      import("@tauri-apps/plugin-dialog"),
    ]);
    return {
      host: tauriHost(),
      async pickFolder(near) {
        // Open one level up so the current library is a folder you can
        // see and click, not a folder you are already inside.
        const parent = near ? near.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") : undefined;
        const picked = await dialog.open({ directory: true, multiple: false, title: "Add a folder of audiobooks", ...(parent ? { defaultPath: parent } : {}) });
        log.info("picked", picked);
        return typeof picked === "string" ? picked : null;
      },
      allowFolder: allowLibrary,
      fileUrl,
      // The sources live in the Ribbon folder. A root remembered by an
      // older build in the webview's storage becomes the first source once.
      sources: {
        async load() {
          const list = await sourcesRead();
          if (list.length > 0) {
            clearLegacyRoot();
            return list;
          }
          const legacy = legacyRoot();
          if (!legacy) return [];
          const seeded = [{ root: legacy, addedAt: new Date().toISOString() }];
          await sourcesWrite(seeded).catch(() => undefined);
          clearLegacyRoot();
          return seeded;
        },
        save: sourcesWrite,
      },
      defaultRoot: envLibrary,
      uptimeMs,
      appSettings: { read: appSettingsRead, write: appSettingsWrite },
      home: {
        path: async () => (await homeInfo()).path,
        reveal: revealHome,
        async reset() {
          const ok = await dialog.ask("Remove the local mirror, the list of folders and the covers Ribbon copied? Nothing beside your books is touched. You add your folders again next time.", {
            title: "Reset Ribbon",
            kind: "warning",
            okLabel: "Reset",
            cancelLabel: "Keep",
          });
          if (!ok) return false;
          await resetHome();
          return true;
        },
      },
    };
  }
  // Development harness: the Vite plugin serves one folder from this machine.
  return {
    host: browserHost(),
    pickFolder: () => browserLibraryRoot(),
    allowFolder: async () => undefined,
    fileUrl: browserFileUrl,
    sources: memorySources(),
    defaultRoot: () => browserLibraryRoot(),
    appSettings: memorySettings(),
  };
}
