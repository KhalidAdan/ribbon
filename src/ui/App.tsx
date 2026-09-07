import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { AppController } from "../app/controller";
import { detectPlatform } from "../app/platform";
import { attachTauriLog, log } from "../app/log";
import { ControllerContext, useAppState, useController } from "./store";
import { PickLibrary } from "./PickLibrary";
import { LibraryPane } from "./LibraryPane";
import { PlayerPane } from "./PlayerPane";
import { PlayerBar } from "./PlayerBar";
import { PlayerSheet } from "./PlayerSheet";
import { ReaderPage } from "./ReaderPage";
import { SettingsPane } from "./SettingsPane";
import { SeriesSetup } from "./SeriesSetup";
import { useKeys } from "./useKeys";
import { ScanProgress } from "./ScanProgress";

export function App() {
  const [controller, setController] = useState<AppController | null>(null);

  useEffect(() => {
    let live = true;
    let created: AppController | null = null;
    void detectPlatform().then(async (platform) => {
      if (!live) return;
      await attachTauriLog();
      log.info("web side up");
      created = new AppController(platform);
      if (import.meta.env.DEV) (window as unknown as { __ribbon: AppController }).__ribbon = created;
      setController(created);
      void created.boot();
    });
    return () => {
      live = false;
      created?.destroy();
    };
  }, []);

  if (!controller) return <Screen />;
  return (
    <ControllerContext.Provider value={controller}>
      <Screen />
    </ControllerContext.Provider>
  );
}

function Screen() {
  return (
    <div className="isolate h-full bg-white text-neutral-950 antialiased dark:bg-neutral-950 dark:text-white">
      <Routed />
    </div>
  );
}

function Routed() {
  let controller: AppController | null = null;
  try {
    controller = useController();
  } catch {
    controller = null;
  }
  if (!controller) return null;
  return <Ready />;
}

function Ready() {
  const state = useAppState();
  const c = useController();
  useKeys(c);

  useEffect(() => {
    const onUnload = () => {
      if (c.getState().player.playing) c.pause();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [c]);

  if (state.phase === "boot") return null;
  if (state.phase === "pick") return <PickLibrary />;
  if (state.phase === "loading") {
    return (
      <main className="flex h-full">
        <div className="h-full w-full shrink-0 pt-6 lg:w-80 lg:border-r lg:border-neutral-950/10 dark:lg:border-white/10">
          <h1 className="px-4 pb-3 text-xl font-semibold tracking-tight text-neutral-950 sm:px-5 dark:text-white">Library</h1>
          {state.scanning ? (
            <ScanProgress status={state.scanning} />
          ) : (
            <p className="px-4 text-base/7 text-neutral-500 sm:px-5 sm:text-sm/6 dark:text-neutral-400">Opening your library…</p>
          )}
        </div>
        <div className="hidden min-w-0 flex-1 lg:block" />
      </main>
    );
  }

  return (
    <main className="flex h-full flex-col">
      <SeriesSetup />
      <div className="min-h-0 flex-1">
        {state.pane === "settings" ? (
          <SettingsPane />
        ) : state.pane === "reader" ? (
          <ReaderPage />
        ) : (
          <div className={clsx("mx-auto h-full w-full", "max-w-6xl")}>
            <LibraryPane />
          </div>
        )}
      </div>
      <PlayerBar />
      <PlayerSheet open={state.playerExpanded} onClose={() => c.collapsePlayer()}>
        <PlayerPane />
      </PlayerSheet>
      {state.error && (
        <div role="alert" className="fixed inset-x-4 bottom-4 mx-auto flex max-w-lg items-center gap-3 rounded-lg bg-neutral-950 px-4 py-3 text-white shadow-lg ring-1 ring-black/10 dark:bg-white dark:text-neutral-950 dark:shadow-none">
          <p className="min-w-0 flex-1 text-sm/6">{state.error}</p>
          <button type="button" onClick={() => c.clearError()} className="text-sm/6 underline underline-offset-2">
            Dismiss
          </button>
        </div>
      )}
    </main>
  );
}
