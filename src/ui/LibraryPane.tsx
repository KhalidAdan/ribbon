import { BookOpenIcon, CheckIcon, FolderOpenIcon, FunnelIcon, MagnifyingGlassIcon, PlayIcon, PlusIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { memo, useMemo } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { formatLeft } from "../core/speed";
import { compareBooks } from "../core/order";
import { chapterAt } from "../core/scan/chapters";
import { hiddenBookIds, orderBySeries, type SeriesGroup, type SeriesRecord } from "../core/series";
import { howFar, lengthOf, progressOf, useShelfProgress, type Progress } from "./progress";
import { readerOnly } from "../core/ebook";
import { shallowEqual, useAppState, useController, useCovers } from "./store";
import { Button } from "./Button";
import { Cover, CoverStack } from "./Cover";
import { ScanProgress } from "./ScanProgress";
import { SearchField } from "./SearchField";
import { EmptyState, Menu, ProgressLine, SectionHeader, SegmentedProgress } from "./kit";
import { Downloads } from "./Servers";
import { describeFilter, useShelfFacts, ViewBar } from "./ShelfView";
import { applyView, filterCount, SORT_LABELS } from "../core/view";
import { seriesStanding } from "./SeriesPage";

/**
 * The library: what you are in the middle of, then each series as a card
 * that knows where you are in it, then every book outside a series.
 * A search replaces all of it with the matches, in rank order.
 */
export function LibraryPane({ query, onQuery, found }: { query: string; onQuery: (q: string) => void; found: ScannedBook[] | null }) {
  // Not the player's place: the shelf follows it by the minute (useShelfProgress).
  const state = useAppState((s) => ({ books: s.books, positions: s.positions, series: s.series, sources: s.sources, view: s.view, scanning: s.scanning, playing: s.player.playing, reading: s.reading !== null, canAddFolders: s.canAddFolders }));
  useCovers();
  const progress = useShelfProgress();
  const c = useController();
  const reading = (id: string) => c.readingProgress(id);
  const listenedAt = (b: ScannedBook) => {
    const p = state.positions[b.book.id];
    return p ? Date.parse(p.updatedAt) : 0;
  };
  const byShelf = useMemo(() => {
    const sorted = [...state.books].sort((a, b) => listenedAt(b) - listenedAt(a) || compareBooks(a.book, b.book));
    return orderBySeries(sorted, (b) => b.book.id, Object.values(state.series));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.books, state.positions, state.series]);
  const series = useMemo(() => c.detectedSeries(), [c, state.books, state.sources, state.series]);
  const inSeries = useMemo(() => new Set(series.flatMap((g) => g.bookIds)), [series]);
  const standalone = useMemo(() => byShelf.filter((b) => !inSeries.has(b.book.id)), [byShelf, inSeries]);
  const byId = useMemo(() => new Map(state.books.map((b) => [b.book.id, b])), [state.books]);
  const hidden = useMemo(() => hiddenBookIds(Object.values(state.series)), [state.series]);
  const current = progress.current?.book.book.id;
  const inProgress = useMemo(
    () =>
      [...state.books]
        .filter((b) => !hidden.has(b.book.id))
        .map((b) => ({ b, p: progressOf(b, progress, reading) }))
        .filter(({ p }) => p.started && !p.finished)
        .sort((x, y) => (current === y.b.book.id ? 1 : 0) - (current === x.b.book.id ? 1 : 0) || listenedAt(y.b) - listenedAt(x.b))
        .slice(0, 6),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Closing the reader may have moved a book along (`c.readingProgress` reads the kept reading places).
    [state.books, progress, hidden, state.reading],
  );

  const facts = useShelfFacts();
  const view = state.view;
  const viewing = filterCount(view.filter) > 0 || view.sort !== "shelf";
  // Search, filters and sort all combine; search keeps its rank unless a sort is chosen.
  const results = useMemo(() => (found ? applyView(found, view, facts) : null), [found, view, facts]);
  const shown = useMemo(() => (viewing && !found ? applyView(byShelf, view, facts) : null), [viewing, found, byShelf, view, facts]);
  const empty = state.books.length === 0;
  const folder = state.sources.length === 1 ? "this folder" : "these folders";

  return (
    <section className="h-full overflow-y-auto quiet-scroll" aria-label="Library">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 pt-8 pb-16 sm:px-8">
        <ReadOnlyNotice />
        <Downloads />
        {!empty && (
          <div className="sm:hidden">
            <SearchField value={query} onChange={onQuery} count={found ? found.length : null} onSubmit={() => found?.[0] && c.openReader(found[0].book.id)} />
          </div>
        )}

        {!empty && <ViewBar />}

        {empty && state.scanning ? (
          <ScanProgress status={state.scanning} />
        ) : empty ? (
          state.sources.some((s) => s.server) ? (
            <EmptyState icon={FolderOpenIcon} title="No books yet" action={state.canAddFolders ? <Button onClick={() => void c.pickLibrary()}>Add a folder</Button> : undefined}>
              {state.canAddFolders ? "Add the folder your books live in, and the server copies them in." : "The server's admin hasn't added any books yet."}
            </EmptyState>
          ) : (
            <EmptyState icon={FolderOpenIcon} title="No books here" action={<Button onClick={() => void c.pickLibrary()}>Add a folder</Button>}>
              Ribbon found no audiobooks or EPUBs in {folder}. Add the folder your books live in.
            </EmptyState>
          )
        ) : results ? (
          <section aria-labelledby="results-title" className="flex flex-col gap-5">
            <SectionHeader
              id="results-title"
              title={results.length === 0 ? "No matches" : `${results.length} ${results.length === 1 ? "book matches" : "books match"} “${query.trim()}”`}
              description={results.length === 0 ? (filterCount(view.filter) > 0 ? "Nothing matches with the filters on. Try clearing them." : "Try part of a title, an author, a narrator or a series.") : filterCount(view.filter) > 0 ? `${describeFilter(view.filter)}.` : undefined}
              actions={
                <Button size="sm" variant="ghost" onClick={() => onQuery("")}>
                  Clear search
                </Button>
              }
            />
            {results.length === 0 ? (
              <EmptyState icon={MagnifyingGlassIcon} title={`Nothing matches “${query.trim()}”`} />
            ) : (
              <BookGrid>
                {results.map((b) => (
                  <BookCard key={b.book.id} book={b} coverUrl={c.coverUrl(b)} progress={progressOf(b, progress, reading)} />
                ))}
              </BookGrid>
            )}
          </section>
        ) : shown ? (
          <section aria-labelledby="view-title" className="flex flex-col gap-5">
            <SectionHeader
              id="view-title"
              title={`${shown.length} ${shown.length === 1 ? "book" : "books"}`}
              description={[describeFilter(view.filter), view.sort !== "shelf" ? `${filterCount(view.filter) > 0 ? "sorted" : "Sorted"} by ${SORT_LABELS[view.sort].toLowerCase()}${view.reverse ? ", reversed" : ""}` : ""].filter(Boolean).join(", ") + "."}
            />
            {shown.length === 0 ? (
              <EmptyState icon={FunnelIcon} title="No book fits every filter" action={<Button onClick={() => c.setView({ ...view, filter: {} })}>Clear the filters</Button>}>
                Take a filter off, or choose another value of one.
              </EmptyState>
            ) : (
              <BookGrid>
                {shown.map((b) => (
                  <BookCard key={b.book.id} book={b} coverUrl={c.coverUrl(b)} progress={progressOf(b, progress, reading)} />
                ))}
              </BookGrid>
            )}
          </section>
        ) : (
          <>
            {inProgress.length > 0 && (
              <section aria-labelledby="continue-title" className="flex flex-col gap-4">
                <SectionHeader id="continue-title" title="Continue" description={inProgress.length === 1 ? "One book in progress." : `${inProgress.length} books in progress, most recent first.`} />
                <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
                  {inProgress.map(({ b, p }) => (
                    <ContinueCard key={b.book.id} book={b} progress={p} coverUrl={c.coverUrl(b)} playing={current === b.book.id && state.playing} />
                  ))}
                </ul>
              </section>
            )}

            {series.length > 0 && (
              <section aria-labelledby="series-title" className="flex flex-col gap-4">
                <SectionHeader
                  id="series-title"
                  title="Series"
                  description={`${series.length} ${series.length === 1 ? "series" : "series"}, in the order you listen.`}
                  actions={
                    <Button size="sm" variant="ghost" leading={PlusIcon} onClick={() => c.openNewSeries()}>
                      New series
                    </Button>
                  }
                />
                <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-3">
                  {series.map((g) => (
                    <SeriesCard key={g.key} group={g} record={state.series[g.key]} byId={byId} />
                  ))}
                </ul>
              </section>
            )}

            {standalone.length > 0 && (
              <section aria-labelledby="books-title" className="flex flex-col gap-5">
                <SectionHeader
                  id="books-title"
                  title={series.length > 0 ? "Books" : "All books"}
                  description={series.length > 0 ? `${standalone.length} ${standalone.length === 1 ? "book" : "books"} outside a series.` : `${standalone.length} ${standalone.length === 1 ? "book" : "books"}, most recently listened first.`}
                />
                <BookGrid>
                  {standalone.map((b) => (
                    <BookCard key={b.book.id} book={b} coverUrl={c.coverUrl(b)} progress={progressOf(b, progress, reading)} />
                  ))}
                </BookGrid>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Said once per folder: it turned out to be read-only from this device,
 * so the place in its books is kept here and nowhere else (read-only.ts).
 * Settings says it beside the folder for as long as it is so.
 */
function ReadOnlyNotice() {
  const c = useController();
  const names = useAppState((s) => s.readOnlyNotice.flatMap((id) => s.sources.find((x) => x.id === id)?.name ?? []));
  if (names.length === 0) return null;
  const one = names.length === 1;
  return (
    <div role="status" className="flex flex-col gap-3 rounded-[10px] bg-surface p-4 ring-1 ring-line sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-base/6 font-medium text-pretty text-ink sm:text-sm/5">{one ? `${names[0]} is read-only from ${c.here}` : `${names.length} folders are read-only from ${c.here}`}</p>
        <p className="mt-1 max-w-[65ch] text-base/6 text-pretty text-ink-2 sm:text-sm/5">
          {!one && `${names.join(", ")}. `}Ribbon reads {one ? "its" : "their"} books as usual but can’t write beside them, so your place is kept on {c.here}. Your other devices won’t see it until {one ? "the folder" : "they"} can be written from here.
        </p>
      </div>
      <Button onClick={() => c.dismissReadOnly()} className="self-start sm:self-center">
        Got it
      </Button>
    </div>
  );
}

function BookGrid({ children }: { children: React.ReactNode }) {
  return (
    <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-5 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]">
      {children}
    </ul>
  );
}

/** What a book's card says under its title: how far, or how long. */
function standing(book: ScannedBook, p: Progress): string {
  if (p.finished) return "Finished";
  if (p.started) return howFar(book, p);
  if (book.remote) return `On the server · ${readerOnly(book.book) ? "EPUB" : lengthOf(book)}`;
  return book.parts.length > 0 ? `${book.parts.length} stories · ${formatLeft(book.book.durationMs)}` : lengthOf(book);
}

/** A book: the cover, the title, the author, and how far along. Redrawn only when one of those changes. */
const BookCard = memo(BookCardView, (a, b) => a.book === b.book && a.coverUrl === b.coverUrl && shallowEqual(a.progress, b.progress));

function BookCardView({ book, coverUrl, progress }: { book: ScannedBook; coverUrl: string | null; progress: Progress }) {
  const c = useController();
  return (
    <li>
      <button type="button" onClick={() => c.openReader(book.book.id)} className="group flex w-full flex-col rounded-md text-left focus-ring">
        <span className="relative">
          <Cover url={coverUrl} title={book.book.title} className="w-full group-hover:opacity-85" />
          {progress.finished && (
            <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-canvas/80 ring-1 ring-line backdrop-blur-sm" title="Finished">
              <CheckIcon className="size-3.5 fill-ink" aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="mt-2.5 block truncate text-base/6 font-medium text-ink sm:text-sm/5">{book.book.title}</span>
        <span className="block truncate text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">{book.book.author || "Unknown author"}</span>
        <span className="block truncate text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{standing(book, progress)}</span>
        {progress.started && !progress.finished && <ProgressLine fraction={progress.fraction} className="mt-2" />}
      </button>
    </li>
  );
}

/** A book you are in the middle of: where, how long is left, and play; or, for a book that is only its EPUB, how far and read. */
function ContinueCard({ book, progress, coverUrl, playing }: { book: ScannedBook; progress: Progress; coverUrl: string | null; playing: boolean }) {
  const c = useController();
  const ch = book.chapters[chapterAt(book.chapters, progress.posMs)];
  const where = book.chapters.length > 1 && ch ? `Chapter ${book.chapters.indexOf(ch) + 1} of ${book.chapters.length}` : `${Math.round(progress.fraction * 100)}% in`;
  const toRead = readerOnly(book.book);
  return (
    <li className="relative flex items-center gap-3 rounded-[10px] bg-surface p-2 pr-3 ring-1 ring-line hover:ring-line-strong">
      <button type="button" onClick={() => c.openReader(book.book.id)} className="absolute inset-0 rounded-[10px] focus-ring" aria-label={`${book.book.title}: open its page`} />
      <Cover url={coverUrl} title={book.book.title} className="pointer-events-none size-16" />
      <div className="pointer-events-none min-w-0 flex-1">
        <p className="truncate text-base/6 font-medium text-ink sm:text-sm/5">{book.book.title}</p>
        <p className="truncate text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
          {toRead ? howFar(book, progress) : `${where} · ${formatLeft(book.book.durationMs - progress.posMs)} left`}
        </p>
        <ProgressLine fraction={progress.fraction} className="mt-2" />
      </div>
      <button
        type="button"
        onClick={() => (toRead ? void c.openReading(book.book.id) : playing ? c.pause() : void c.playBook(book))}
        aria-label={toRead ? `Continue reading ${book.book.title}` : playing ? `Pause ${book.book.title}` : `Continue ${book.book.title}`}
        className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink ring-1 ring-line focus-ring hover:bg-primary hover:text-on-primary hover:ring-primary"
      >
        <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />
        {toRead ? <BookOpenIcon className="size-4 fill-current" aria-hidden="true" /> : playing ? <PauseGlyph /> : <PlayIcon className="size-4 translate-x-px fill-current" aria-hidden="true" />}
      </button>
    </li>
  );
}

function PauseGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden="true">
      <rect x="4" y="3" width="3" height="10" rx="1" />
      <rect x="9" y="3" width="3" height="10" rx="1" />
    </svg>
  );
}

/** A series: the next book's cover on a small stack, where you are, and a mark per book. It opens the series' page; play goes on with the next book. */
function SeriesCard({ group, record, byId }: { group: SeriesGroup; record: SeriesRecord | undefined; byId: Map<string, ScannedBook> }) {
  const shelf = useShelfProgress();
  useCovers();
  const c = useController();
  const s = seriesStanding(group, record, byId, (b) => progressOf(b, shelf, (id) => c.readingProgress(id)));
  if (!s.next) return null;
  const { book: next, progress: nextProgress } = s.next;
  const title = group.titles?.[next.book.id] ?? next.book.title;
  return (
    <li className="relative flex gap-4 rounded-[10px] bg-surface p-3 ring-1 ring-line hover:ring-line-strong">
      <button type="button" onClick={() => c.openSeries(group.key)} className="absolute inset-0 rounded-[10px] focus-ring" aria-label={`${group.name}: open the series`} />
      <CoverStack url={c.coverUrl(next)} title={next.book.title} count={s.books.length} className="w-20" />
      <div className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <p className="truncate text-base/6 font-medium text-ink sm:text-sm/5">{group.name}</p>
        <p className="truncate text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
          {s.books.length} books · {s.allDone ? "all finished" : s.finished > 0 ? `${s.finished} finished · ${formatLeft(s.leftMs).replace(/ \d+m$/, "")} to go` : `${formatLeft(s.leftMs).replace(/ \d+m$/, "")}`}
        </p>
        <p className="mt-2 truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
          {s.allDone ? "Every book finished" : nextProgress.started ? `${readerOnly(next.book) ? "Reading" : "Listening to"} ${title}` : `Up next: ${title}`}
        </p>
        <div className="mt-auto pt-3">
          <SegmentedProgress parts={s.books.map((b) => (b.progress.finished ? 1 : b.progress.fraction))} />
        </div>
      </div>
      <div className="relative flex shrink-0 flex-col items-end justify-between gap-2">
        <Menu
          label={`${group.name}: more`}
          title={group.name}
          items={[
            { label: record ? "Change the series…" : "Set up the series…", onSelect: () => c.openSeriesSetup(group.key) },
            { label: `Open ${next.book.title}`, onSelect: () => c.openReader(next.book.id) },
          ]}
        />
        {!s.allDone && (
          <button
            type="button"
            onClick={() => void c.playBook(next)}
            aria-label={`Continue ${group.name}: ${next.book.title}`}
            className={clsx("relative flex size-9 items-center justify-center rounded-full bg-raised text-ink ring-1 ring-line focus-ring hover:bg-primary hover:text-on-primary hover:ring-primary")}
          >
            <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />
            {readerOnly(next.book) ? <BookOpenIcon className="size-4 fill-current" aria-hidden="true" /> : <PlayIcon className="size-4 translate-x-px fill-current" aria-hidden="true" />}
          </button>
        )}
      </div>
    </li>
  );
}
