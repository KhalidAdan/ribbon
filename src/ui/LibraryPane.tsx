import { CheckIcon, FolderOpenIcon, MagnifyingGlassIcon, PlayIcon, PlusIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { memo, useMemo } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { formatLeft } from "../core/speed";
import { compareBooks } from "../core/order";
import { chapterAt } from "../core/scan/chapters";
import { hiddenBookIds, orderBySeries, type SeriesGroup, type SeriesRecord } from "../core/series";
import { progressOf, type Progress } from "./progress";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { ScanProgress } from "./ScanProgress";
import { SearchField } from "./SearchField";
import { EmptyState, Menu, ProgressLine, SectionHeader, SegmentedProgress } from "./kit";

/**
 * The library: what you are in the middle of, then each series as a card
 * that knows where you are in it, then every book outside a series.
 * A search replaces all of it with the matches, in rank order.
 */
export function LibraryPane({ query, onQuery, found }: { query: string; onQuery: (q: string) => void; found: ScannedBook[] | null }) {
  const state = useAppState();
  const c = useController();
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
  const inProgress = useMemo(
    () =>
      [...state.books]
        .filter((b) => !hidden.has(b.book.id))
        .map((b) => ({ b, p: progressOf(b, state) }))
        .filter(({ p }) => p.started && !p.finished)
        .sort((x, y) => (state.current?.book.book.id === y.b.book.id ? 1 : 0) - (state.current?.book.book.id === x.b.book.id ? 1 : 0) || listenedAt(y.b) - listenedAt(x.b))
        .slice(0, 6),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.books, state.positions, state.current, hidden],
  );

  const empty = state.books.length === 0;
  const folder = state.sources.length === 1 ? "this folder" : "these folders";

  return (
    <section className="h-full overflow-y-auto quiet-scroll" aria-label="Library">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 pt-8 pb-16 sm:px-8">
        {!empty && (
          <div className="sm:hidden">
            <SearchField value={query} onChange={onQuery} count={found ? found.length : null} onSubmit={() => found?.[0] && c.openReader(found[0].book.id)} />
          </div>
        )}

        {empty && state.scanning ? (
          <ScanProgress status={state.scanning} />
        ) : empty ? (
          <EmptyState icon={FolderOpenIcon} title="No audiobooks here" action={<Button onClick={() => void c.pickLibrary()}>Add a folder</Button>}>
            Ribbon found no audio files in {folder}. Add the folder your books live in.
          </EmptyState>
        ) : found ? (
          <section aria-labelledby="results-title" className="flex flex-col gap-5">
            <SectionHeader
              id="results-title"
              title={found.length === 0 ? "No matches" : `${found.length} ${found.length === 1 ? "book matches" : "books match"} “${query.trim()}”`}
              description={found.length === 0 ? "Try part of a title, an author, a narrator or a series." : undefined}
              actions={
                <Button size="sm" variant="ghost" onClick={() => onQuery("")}>
                  Clear search
                </Button>
              }
            />
            {found.length === 0 ? (
              <EmptyState icon={MagnifyingGlassIcon} title={`Nothing matches “${query.trim()}”`} />
            ) : (
              <BookGrid>
                {found.map((b) => (
                  <BookCard key={b.book.id} book={b} coverUrl={c.coverUrl(b)} progress={progressOf(b, state)} />
                ))}
              </BookGrid>
            )}
          </section>
        ) : (
          <>
            {inProgress.length > 0 && (
              <section aria-labelledby="continue-title" className="flex flex-col gap-4">
                <SectionHeader id="continue-title" title="Continue listening" description={inProgress.length === 1 ? "One book in progress." : `${inProgress.length} books in progress, most recent first.`} />
                <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
                  {inProgress.map(({ b, p }) => (
                    <ContinueCard key={b.book.id} book={b} progress={p} coverUrl={c.coverUrl(b)} playing={state.current?.book.book.id === b.book.id && state.player.playing} />
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
                    <BookCard key={b.book.id} book={b} coverUrl={c.coverUrl(b)} progress={progressOf(b, state)} />
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
  if (p.started) return `${Math.max(1, Math.round(p.fraction * 100))}% · ${formatLeft(book.book.durationMs - p.posMs)} left`;
  return book.parts.length > 0 ? `${book.parts.length} stories · ${formatLeft(book.book.durationMs)}` : formatLeft(book.book.durationMs);
}

/** A book: the cover, the title, the author, and how far along. */
const BookCard = memo(function BookCard({ book, coverUrl, progress }: { book: ScannedBook; coverUrl: string | null; progress: Progress }) {
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
});

/** A book you are in the middle of: where, how long is left, and play. */
function ContinueCard({ book, progress, coverUrl, playing }: { book: ScannedBook; progress: Progress; coverUrl: string | null; playing: boolean }) {
  const c = useController();
  const ch = book.chapters[chapterAt(book.chapters, progress.posMs)];
  const where = book.chapters.length > 1 && ch ? `Chapter ${book.chapters.indexOf(ch) + 1} of ${book.chapters.length}` : `${Math.round(progress.fraction * 100)}% in`;
  return (
    <li className="relative flex items-center gap-3 rounded-[10px] bg-surface p-2 pr-3 ring-1 ring-line hover:ring-line-strong">
      <button type="button" onClick={() => c.openReader(book.book.id)} className="absolute inset-0 rounded-[10px] focus-ring" aria-label={`${book.book.title}: open its page`} />
      <Cover url={coverUrl} title={book.book.title} className="pointer-events-none size-16" />
      <div className="pointer-events-none min-w-0 flex-1">
        <p className="truncate text-base/6 font-medium text-ink sm:text-sm/5">{book.book.title}</p>
        <p className="truncate text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
          {where} · {formatLeft(book.book.durationMs - progress.posMs)} left
        </p>
        <ProgressLine fraction={progress.fraction} className="mt-2" />
      </div>
      <button
        type="button"
        onClick={() => (playing ? c.pause() : void c.playBook(book))}
        aria-label={playing ? `Pause ${book.book.title}` : `Continue ${book.book.title}`}
        className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink ring-1 ring-line focus-ring hover:bg-primary hover:text-on-primary hover:ring-primary"
      >
        <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />
        {playing ? <PauseGlyph /> : <PlayIcon className="size-4 translate-x-px fill-current" aria-hidden="true" />}
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

/** A series: the next book's cover on a small stack, where you are, and a mark per book. */
function SeriesCard({ group, record, byId }: { group: SeriesGroup; record: SeriesRecord | undefined; byId: Map<string, ScannedBook> }) {
  const state = useAppState();
  const c = useController();
  const hidden = hiddenBookIds(record ? [record] : []);
  const ordered = orderBySeries(group.bookIds, (id) => id, record ? [record] : [])
    .filter((id) => !hidden.has(id))
    .map((id) => byId.get(id))
    .filter((b): b is ScannedBook => !!b);
  const progress = ordered.map((b) => progressOf(b, state));
  const finished = progress.filter((p) => p.finished).length;
  const nextIndex = progress.findIndex((p) => !p.finished);
  const next = ordered[nextIndex] ?? ordered[0];
  const allDone = ordered.length > 0 && finished === ordered.length;
  const nextProgress = nextIndex >= 0 ? progress[nextIndex]! : null;
  const left = ordered.reduce((s, b, i) => s + (progress[i]!.finished ? 0 : b.book.durationMs - progress[i]!.posMs), 0);
  if (!next) return null;
  return (
    <li className="relative flex gap-4 rounded-[10px] bg-surface p-3 ring-1 ring-line hover:ring-line-strong">
      <button type="button" onClick={() => c.openReader(next.book.id)} className="absolute inset-0 rounded-[10px] focus-ring" aria-label={`${group.name}: open ${next.book.title}`} />
      <div className="pointer-events-none relative w-20 shrink-0 self-start pr-2">
        {ordered.length > 2 && <span className="absolute inset-y-[10%] right-0 left-2 rounded-[4px] bg-raised ring-1 ring-line" aria-hidden="true" />}
        {ordered.length > 1 && <span className="absolute inset-y-[5%] right-1 left-1 rounded-[4px] bg-raised ring-1 ring-line" aria-hidden="true" />}
        <Cover url={c.coverUrl(next)} title={next.book.title} className="relative w-full" />
      </div>
      <div className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <p className="truncate text-base/6 font-medium text-ink sm:text-sm/5">{group.name}</p>
        <p className="truncate text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
          {ordered.length} books · {allDone ? "all finished" : finished > 0 ? `${finished} finished · ${formatLeft(left).replace(/ \d+m$/, "")} to go` : `${formatLeft(left).replace(/ \d+m$/, "")}`}
        </p>
        <p className="mt-2 truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
          {allDone ? "Every book finished" : nextProgress?.started ? `Listening to ${next.book.title}` : `Up next: ${next.book.title}`}
        </p>
        <div className="mt-auto pt-3">
          <SegmentedProgress parts={progress.map((p) => (p.finished ? 1 : p.fraction))} />
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
        {!allDone && (
          <button
            type="button"
            onClick={() => void c.playBook(next)}
            aria-label={`Continue ${group.name}: ${next.book.title}`}
            className={clsx("relative flex size-9 items-center justify-center rounded-full bg-raised text-ink ring-1 ring-line focus-ring hover:bg-primary hover:text-on-primary hover:ring-primary")}
          >
            <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />
            <PlayIcon className="size-4 translate-x-px fill-current" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}
