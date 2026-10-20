import { Profiler, useEffect, useState } from "react";
import { AppController } from "../app/controller";
import { detectPlatform } from "../app/platform";
import { attachTauriLog, log } from "../app/log";
import { ControllerContext, useAppState, useController, useCovers } from "./store";
import { PickLibrary } from "./PickLibrary";
import { LibraryPane } from "./LibraryPane";
import { PlayerPane } from "./PlayerPane";
import { PlayerBar } from "./PlayerBar";
import { PlayerSheet } from "./PlayerSheet";
import { ReaderPage } from "./ReaderPage";
import { SettingsPane } from "./SettingsPane";
import { SeriesSetup } from "./SeriesSetup";
import { NewSeries } from "./NewSeries";
import { useKeys } from "./useKeys";
import { ScanProgress } from "./ScanProgress";
import { TopBar, Tabs, type Crumb } from "./Shell";
import { Button } from "./Button";
import { useSearch } from "./useSearch";
import { EditBook } from "./EditBook";
import { StatsPane } from "./StatsPane";
import { ReadingView } from "../reader/ReadingView";
import { onRender, startPerf } from "../app/perf";
import { preloadFaces } from "../reader/typeset";

export function App() {
  const [controller, setController] = useState<AppController | null>(null);
  useEffect(() => startPerf(), []);
  // The reader's faces load at start, so the first book opened does not wait for them.
  useEffect(() => void preloadFaces(), []);

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
      <Profiler id="app" onRender={onRender}>
        <Screen />
      </Profiler>
    </ControllerContext.Provider>
  );
}

/** Everything under the controller's context; the tests render it with a controller of their own. */
export function Screen() {
  return (
    <div className="isolate h-full bg-canvas font-sans text-ink antialiased">
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
  // What the shell draws; not the player, which redraws on its own five times a second.
  const state = useAppState((s) => ({
    phase: s.phase,
    books: s.books,
    sources: s.sources,
    series: s.series,
    pane: s.pane,
    readerBookId: s.readerBookId,
    problems: s.problems,
    playerExpanded: s.playerExpanded,
    error: s.error,
    reading: s.reading !== null,
  }));
  const c = useController();
  useKeys(c);
  useEffect(() => c.installLifecycle(), [c]);
  const { query, setQuery, found } = useSearch(state.books);

  if (state.phase === "boot") return null;
  if (state.phase === "pick") return <PickLibrary />;

  const reader = state.pane === "reader" ? (state.books.find((b) => b.book.id === state.readerBookId) ?? null) : null;
  const series = reader ? c.detectedSeries().find((g) => g.bookIds.includes(reader.book.id)) : undefined;
  const folders = state.sources.length === 1 ? state.sources[0]!.name : `${state.sources.length} folders`;
  const crumbs: Crumb[] =
    state.pane === "settings"
      ? [{ label: "Settings" }]
      : state.pane === "stats"
        ? [{ label: "Stats" }]
      : reader
        ? [{ label: "Library", onClick: () => c.showLibrary() }, ...(series ? [{ label: series.name }] : []), { label: reader.book.title }]
        : [{ label: folders }];
  const onQuery = (q: string) => {
    setQuery(q);
    if (q && state.pane !== "library") c.showLibrary();
  };

  // The reader covers the window: nothing under it is drawn, so a page turn never waits on the shelf.
  if (state.reading) return <ReadingView />;

  return (
    <main className="flex h-full flex-col">
      <SeriesSetup />
      <NewSeries />
      <EditBookHost />
      <TopBar crumbs={crumbs} query={query} onQuery={onQuery} count={found ? found.length : null} onSubmit={() => found?.[0] && c.openReader(found[0].book.id)} />
      <Tabs
        current={state.pane === "settings" ? "settings" : state.pane === "stats" ? "stats" : "library"}
        onSelect={(t) => (t === "settings" ? c.showSettings() : t === "stats" ? c.showStats() : c.showLibrary())}
        badges={state.problems.length > 0 ? { settings: <span className="size-1.5 rounded-full bg-place" aria-label={`${state.problems.length} files could not be read`} /> } : {}}
      />
      <div className="min-h-0 flex-1">
        {state.phase === "loading" ? (
          <Loading />
        ) : state.pane === "settings" ? (
          <SettingsPane />
        ) : state.pane === "stats" ? (
          <StatsPane />
        ) : state.pane === "reader" ? (
          <ReaderPage />
        ) : (
          <LibraryPane query={query} onQuery={onQuery} found={found} />
        )}
      </div>
      <PlayerBar />
      <PlayerSheet open={state.playerExpanded} onClose={() => c.collapsePlayer()}>
        <PlayerPane />
      </PlayerSheet>

      {state.error && (
        <div role="alert" className="fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-lg items-start gap-3 rounded-[10px] bg-surface p-3 pl-4 shadow-lg ring-1 ring-line dark:shadow-none dark:ring-line-strong">
          <p className="min-w-0 flex-1 py-0.5 text-base/6 text-pretty text-ink sm:text-sm/5">{state.error}</p>
          <Button size="sm" variant="ghost" onClick={() => c.clearError()}>
            Dismiss
          </Button>
        </div>
      )}
    </main>
  );
}

function Loading() {
  const scanning = useAppState((s) => s.scanning);
  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-16 sm:px-6">
      {scanning ? <ScanProgress status={scanning} /> : <p className="text-base/6 text-ink-2 sm:text-sm/5">Opening your library…</p>}
    </div>
  );
}

/** The edit dialog for whichever book asked for it. */
function EditBookHost() {
  const book = useAppState((s) => (s.editBook ? s.books.find((b) => b.book.id === s.editBook) : undefined));
  useCovers();
  const c = useController();
  if (!book) return null;
  return <EditBook book={book} open onClose={() => c.closeEditBook()} />;
}
