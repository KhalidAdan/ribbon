import type { Platform } from "./controller";
import type { SourceEntry } from "../core/sources";
import { browserFileUrl, browserHome, browserHost, browserLibraryRoot } from "../host/browser";
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

/**
 * iOS: open the remembered folders again before anything reads them, and
 * follow any that are somewhere else now. One out of reach (a share with its
 * network off) stays as it was, and its library says it cannot be opened.
 */
export async function reopenedOnIos(
  list: SourceEntry[],
  restore: () => Promise<{ was: string; now: string | null }[]>,
  write: (list: SourceEntry[]) => Promise<void>,
): Promise<SourceEntry[]> {
  const moved = await restore().catch((e: unknown) => {
    log.warn("could not open the remembered folders again:", String(e));
    return [];
  });
  for (const m of moved) log.info(m.now ? `a folder moved: ${m.was} is now ${m.now}` : `a folder is out of reach: ${m.was}`);
  const now = new Map(moved.flatMap((m) => (m.now ? [[m.was, m.now] as const] : [])));
  if (now.size === 0) return list;
  const next = list.map((s) => ({ ...s, root: now.get(s.root) ?? s.root }));
  await write(next).catch((e: unknown) => log.warn("could not save the moved folders:", String(e)));
  return next;
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
    const [{ tauriHost, allowLibrary, fileUrl, exactAudioUrl, uptimeMs, envLibrary, homeInfo, sourcesRead, sourcesWrite, revealHome, resetHome, appSettingsRead, appSettingsWrite, onIos, pickFolderOnIos, restoreFoldersOnIos, keepFoldersOnIos, onQuitAsked }, dialog] = await Promise.all([
      import("../host/tauri"),
      import("@tauri-apps/plugin-dialog"),
    ]);
    const ios = onIos();
    return {
      host: tauriHost(),
      phone: ios,
      async pickFolder(near) {
        if (ios) {
          const picked = await pickFolderOnIos();
          log.info("picked", picked);
          return picked;
        }
        // Open one level up so the current library is a folder you can
        // see and click, not a folder you are already inside.
        const parent = near ? near.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") : undefined;
        const picked = await dialog.open({ directory: true, multiple: false, title: "Add a folder of books", ...(parent ? { defaultPath: parent } : {}) });
        log.info("picked", picked);
        return typeof picked === "string" ? picked : null;
      },
      async pickFile(title, filters) {
        const picked = await dialog.open({ directory: false, multiple: false, title, filters });
        return typeof picked === "string" ? picked : null;
      },
      allowFolder: allowLibrary,
      fileUrl,
      exactAudioUrl,
      // The sources live in the Ribbon folder. A root remembered by an
      // older build in the webview's storage becomes the first source once.
      sources: {
        async load() {
          const read = await sourcesRead();
          const list = ios ? await reopenedOnIos(read, restoreFoldersOnIos, sourcesWrite) : read;
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
        async save(list) {
          await sourcesWrite(list);
          if (ios) await keepFoldersOnIos(list.map((s) => s.root)).catch((e: unknown) => log.warn("could not let go of removed folders:", String(e)));
        },
      },
      defaultRoot: envLibrary,
      uptimeMs,
      onWindowClose(flush, mayClose) {
        // Tauri waits for this handler, then closes the window: the
        // position is on disk before the webview goes away. Ribbon's own
        // Quit comes the same way. Either first asks whether to close.
        const leave = async (): Promise<boolean> => {
          // Asking can't keep Ribbon open by failing: only a "no" does.
          if (!(await mayClose().catch(() => true))) return false;
          log.info("window closing; keeping positions");
          await flush().catch((e: unknown) => log.warn("could not flush positions on close:", String(e)));
          return true;
        };
        const unlisten: (() => void)[] = [];
        let gone = false;
        const keep = (u: () => void) => {
          if (gone) u();
          else unlisten.push(u);
        };
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
          getCurrentWindow()
            .onCloseRequested(async (event) => {
              if (!(await leave())) event.preventDefault();
            })
            .then(keep),
        );
        void onQuitAsked(leave).then(keep);
        return () => {
          gone = true;
          unlisten.forEach((u) => u());
        };
      },
      askToClose: (why) => dialog.ask(why, { title: "Ribbon is transcribing", kind: "warning", okLabel: "Close anyway", cancelLabel: "Keep transcribing" }),
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
    home: { path: () => browserHome(), reveal: async () => undefined, reset: async () => false },
  };
}
