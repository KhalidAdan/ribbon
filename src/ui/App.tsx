import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { AppController } from "../app/controller";
import { detectPlatform } from "../app/platform";
import { ControllerContext, useAppState, useController } from "./store";
import { PickLibrary } from "./PickLibrary";
import { LibraryPane } from "./LibraryPane";
import { PlayerPane } from "./PlayerPane";
import { useKeys } from "./useKeys";

export function App() {
  const [controller, setController] = useState<AppController | null>(null);

  useEffect(() => {
    let live = true;
    let created: AppController | null = null;
    void detectPlatform().then((platform) => {
      if (!live) return;
      created = new AppController(platform);
      if (import.meta.env.DEV) (window as unknown as { __odio: AppController }).__odio = created;
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
      <main className="flex h-full items-center justify-center px-6">
        <p className="text-base/7 text-neutral-500 tabular-nums sm:text-sm/6 dark:text-neutral-400">
          {state.scanning && state.scanning.walked > 0 ? `Reading ${state.scanning.done.toLocaleString()} of ${state.scanning.walked.toLocaleString()} files…` : "Looking through your folder…"}
        </p>
      </main>
    );
  }

  return (
    <main className="flex h-full">
      <div className={clsx("h-full w-full shrink-0 lg:w-80 lg:border-r lg:border-neutral-950/10 dark:lg:border-white/10", state.pane === "player" && "max-lg:hidden")}>
        <LibraryPane />
      </div>
      <div className={clsx("h-full min-w-0 flex-1", state.pane === "library" && "max-lg:hidden")}>
        <PlayerPane />
      </div>
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
