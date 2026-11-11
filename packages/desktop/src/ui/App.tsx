import { lazy, Profiler, Suspense, useEffect, useState } from "react";
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
import { SeriesPage } from "./SeriesPage";
import { useKeys } from "./useKeys";
import { ScanProgress } from "./ScanProgress";
import { TopBar, Tabs, type Crumb } from "./Shell";
import { useSearch } from "./useSearch";
import { EditBook } from "./EditBook";
import { useKept } from "./modal";
import { MoveToServer, SpaceShort } from "./Servers";
import { StatsPane } from "./StatsPane";
import { TheEnd } from "./TheEnd";
import { Notices } from "./Notices";
import { ReadingView } from "../reader/ReadingView";
import { onRender, startPerf } from "../app/perf";
import { preloadFaces } from "../reader/typeset";

// The lamp-lit bookcase brings the 3D library with it, so it is fetched when the page is first opened, not at launch.
const BookcasePage = lazy(() => import("./BookcasePage"));

declare const __RIBBON_MEASURE__: boolean;

export function App() {
  const [controller, setController] = useState<AppController | null>(null);
  useEffect(() => startPerf(), []);
  // The reader's faces load at start, so the first book opened does not wait for them.
  useEffect(() => void preloadFaces(), []);

  useEffect(() => {
    let live = true;
    let created: AppController | null = null;
    // No updating itself while developing, where there's no installed Ribbon to replace, nor in the measurement build, which only measures.
    void detectPlatform({ updates: !(import.meta.env.DEV || __RIBBON_MEASURE__) }).then(async (platform) => {
      if (!live) return;
      await attachTauriLog();
      log.info("web side up");
      created = new AppController(platform);
      // For the browser harness and tools, and the end-to-end suite in the measurement build (packages/desktop/tools/e2e).
      if (import.meta.env.DEV || __RIBBON_MEASURE__) (window as unknown as { __ribbon: AppController }).__ribbon = created;
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
    screen: s.screen,
    seriesKey: s.seriesKey,
    problems: s.problems,
    playerOpen: s.fullPlayer !== null,
    reading: s.reading !== null,
  }));
  const c = useController();
  useKeys(c);
  useEffect(() => c.installLifecycle(), [c]);
  const { query, setQuery, found, lines } = useSearch(state.books);
  // The lines found for the words as they stand, not for words since changed.
  const foundLines = lines && lines.for === query.trim() ? lines.found : null;
  const matchCount = found || foundLines ? (found?.length ?? 0) + (foundLines?.length ?? 0) : null;
  // Enter opens the first book that matches, or else the first line found.
  const openFirst = () => (found?.[0] ? c.openReader(found[0].book.id) : foundLines?.[0] && void c.readLine(foundLines[0]));

  if (state.phase === "boot") return null;
  if (state.phase === "pick") return <PickLibrary />;

  const at = state.screen;
  const pane = at.pane;
  const reader = at.pane === "reader" ? (state.books.find((b) => b.book.id === at.bookId) ?? null) : null;
  // A book in several series is under the one you came from.
  const series = reader ? c.seriesOfBook(reader.book.id)[0] : at.pane === "series" ? c.detectedSeries().find((g) => g.key === at.key) : undefined;
  const servers = state.sources.filter((s) => s.server).length;
  const counted = (n: number, one: string) => (n === 0 ? "" : `${n} ${one}${n === 1 ? "" : "s"}`);
  const folders = state.sources.length === 1 ? state.sources[0]!.name : [counted(state.sources.length - servers, "folder"), counted(servers, "server")].filter(Boolean).join(" and ");
  const crumbs: Crumb[] =
    pane === "settings"
      ? [{ label: "Settings" }]
      : pane === "stats"
        ? [{ label: "Stats" }]
      : reader
        ? at.pane === "reader" && at.fromBookcase
          ? [{ label: "Library", onClick: () => c.showLibrary() }, { label: "Bookcase", onClick: () => c.openBookcase() }, { label: reader.book.title }]
          : [{ label: "Library", onClick: () => c.showLibrary() }, ...(series ? [{ label: series.name, onClick: () => c.openSeries(series.key) }] : []), { label: series?.titles?.[reader.book.id] ?? reader.book.title }]
        : pane === "series"
          ? [{ label: "Library", onClick: () => c.showLibrary() }, { label: series?.name ?? "Series" }]
          : pane === "bookcase"
            ? [{ label: "Library", onClick: () => c.showLibrary() }, { label: "Bookcase" }]
          : [{ label: folders }];
  const onQuery = (q: string) => {
    setQuery(q);
    if (q && pane !== "library") c.showLibrary();
  };

  // The reader covers the window: nothing under it is drawn, so a page turn never waits on the shelf.
  // The full player opens over it from the dock on a phone; closed, it draws nothing.
  const screen = state.reading ? (
    <>
      <ReadingView />
      <PlayerSheet open={state.playerOpen} onClose={() => c.collapsePlayer()}>
        <PlayerPane />
      </PlayerSheet>
      <TheEnd />
    </>
  ) : (
    <main className="flex h-full flex-col">
      <SeriesSetup />
      <NewSeries />
      <EditBookHost />
      <SpaceShort />
      <MoveToServer />
      <TheEnd />
      <TopBar crumbs={crumbs} query={query} onQuery={onQuery} count={matchCount} onSubmit={openFirst} />
      <Tabs
        current={pane === "settings" ? "settings" : pane === "stats" ? "stats" : "library"}
        onSelect={(t) => (t === "settings" ? c.showSettings() : t === "stats" ? c.showStats() : c.showLibrary())}
        badges={state.problems.length > 0 ? { settings: <span className="size-1.5 rounded-full bg-place" aria-label={`${state.problems.length} files could not be read`} /> } : {}}
      />
      <div className="min-h-0 flex-1">
        {state.phase === "loading" ? (
          <Loading />
        ) : pane === "settings" ? (
          <SettingsPane />
        ) : pane === "stats" ? (
          <StatsPane />
        ) : pane === "reader" ? (
          <ReaderPage />
        ) : pane === "series" ? (
          <SeriesPage />
        ) : pane === "bookcase" ? (
          <Suspense fallback={<div className="lamplit h-full bg-canvas" />}>
            <BookcasePage />
          </Suspense>
        ) : (
          <LibraryPane query={query} onQuery={onQuery} found={found} lines={foundLines} count={matchCount} onSubmit={openFirst} />
        )}
      </div>
      <PlayerBar />
      <PlayerSheet open={state.playerOpen} onClose={() => c.collapsePlayer()}>
        <PlayerPane />
      </PlayerSheet>
    </main>
  );

  // One set of notes over either, so a note keeps its place and its time as the reader opens and closes.
  return (
    <>
      {screen}
      <Notices />
    </>
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
  const live = useAppState((s) => (s.editBook ? s.books.find((b) => b.book.id === s.editBook) : undefined));
  useCovers();
  const c = useController();
  // The book as it was when the dialog opened, until the dialog is gone: Save changes it as the dialog leaves.
  const [book, closed] = useKept(live ?? null);
  if (!book) return null;
  return <EditBook book={book} open={live !== undefined} onClose={() => c.closeEditBook()} onClosed={closed} />;
}
