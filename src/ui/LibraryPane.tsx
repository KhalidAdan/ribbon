import { ArrowPathIcon, Cog6ToothIcon, PlayIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { memo, useEffect, useMemo, useState } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { formatLeft } from "../core/speed";
import { compareBooks } from "../core/order";
import { indexBooks, searchBooks, type BookIndex } from "../core/search";
import { hiddenBookIds, orderBySeries, type SeriesGroup, type SeriesRecord } from "../core/series";
import { progressOf } from "./progress";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { ScanProgress } from "./ScanProgress";
import { SearchField } from "./SearchField";

/**
 * The library as cards: a card per series, showing where you are in it
 * and where to continue, then a card per book outside any series. Search
 * cuts across everything and shows matching books flat, in rank order.
 */
export function LibraryPane() {
  const state = useAppState();
  const c = useController();
  const byShelf = useMemo(() => {
    const listenedAt = (b: ScannedBook) => {
      const p = state.positions[b.book.id];
      return p ? Date.parse(p.updatedAt) : 0;
    };
    const sorted = [...state.books].sort((a, b) => {
      const d = listenedAt(b) - listenedAt(a);
      if (d !== 0) return d;
      return compareBooks(a.book, b.book);
    });
    return orderBySeries(sorted, (b) => b.book.id, Object.values(state.series));
  }, [state.books, state.positions, state.series]);
  const series = useMemo(() => c.detectedSeries(), [c, state.books, state.root]);
  const inSeries = useMemo(() => new Set(series.flatMap((g) => g.bookIds)), [series]);
  const standalone = useMemo(() => byShelf.filter((b) => !inSeries.has(b.book.id)), [byShelf, inSeries]);
  const byId = useMemo(() => new Map(state.books.map((b) => [b.book.id, b])), [state.books]);

  // Search: the index follows the shelf, the match list follows the query.
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<BookIndex | null>(null);
  const [matches, setMatches] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void indexBooks(state.books.map((b) => b.book)).then((db) => live && setIndex(db));
    return () => {
      live = false;
    };
  }, [state.books]);
  useEffect(() => {
    if (!index || !query.trim()) {
      setMatches(null);
      return;
    }
    let live = true;
    void searchBooks(index, query).then((ids) => live && setMatches(ids));
    return () => {
      live = false;
    };
  }, [index, query]);
  const found = useMemo(() => {
    if (!matches) return null;
    const rank = new Map(matches.map((id, i) => [id, i]));
    return byShelf.filter((b) => rank.has(b.book.id)).sort((a, b) => rank.get(a.book.id)! - rank.get(b.book.id)!);
  }, [byShelf, matches]);

  const folderName = state.root ? state.root.split(/[\\/]/).filter(Boolean).pop() : "";
  const empty = state.books.length === 0;

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Library">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 sm:px-8">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-950 dark:text-white">Library</h1>
          <p className="truncate text-sm/6 text-neutral-500 dark:text-neutral-400" title={state.root ?? ""}>
            {folderName}
            {state.scanning
              ? state.scanning.stage
                ? ` · ${state.scanning.stage.replace(/…$/, "").toLowerCase()}`
                : state.scanning.walked > 0
                  ? ` · checking ${state.scanning.done.toLocaleString()} of ${state.scanning.walked.toLocaleString()} files`
                  : " · checking for changes"
              : ` · ${state.books.length.toLocaleString()} ${state.books.length === 1 ? "book" : "books"}`}
          </p>
        </div>
        {!empty && (
          <div className="w-72 max-sm:hidden">
            <SearchField value={query} onChange={setQuery} count={found ? found.length : null} onSubmit={() => found?.[0] && c.openReader(found[0].book.id)} />
          </div>
        )}
        <Button icon size="sm" variant="ghost" aria-label="Rescan library" title="Rescan library" onClick={() => void c.rescan()} disabled={state.scanning !== null}>
          <ArrowPathIcon className={clsx("size-4 fill-current", state.scanning && "animate-spin")} />
        </Button>
        <Button
          icon
          size="sm"
          variant="ghost"
          aria-label={state.problems.length > 0 ? `Settings, ${state.problems.length} ${state.problems.length === 1 ? "file" : "files"} could not be read` : "Settings"}
          title="Settings"
          onClick={() => c.showSettings()}
        >
          <Cog6ToothIcon className="size-4 fill-current" />
          {state.problems.length > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-amber-500 ring-2 ring-white dark:bg-amber-400 dark:ring-neutral-950" aria-hidden="true" />}
        </Button>
      </header>
      {!empty && (
        <div className="px-4 pb-3 sm:hidden">
          <SearchField value={query} onChange={setQuery} count={found ? found.length : null} onSubmit={() => found?.[0] && c.openReader(found[0].book.id)} />
        </div>
      )}

      {empty && state.scanning ? (
        <ScanProgress status={state.scanning} />
      ) : empty ? (
        <div className="px-5 py-10 text-center">
          <p className="text-base/7 text-neutral-500 sm:text-sm/6 dark:text-neutral-400">No audiobooks found in this folder.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 sm:px-8">
          {found ? (
            found.length === 0 ? (
              <p className="py-10 text-center text-base/7 text-neutral-500 sm:text-sm/6 dark:text-neutral-400">Nothing matches “{query.trim()}”.</p>
            ) : (
              <Grid>
                {found.map((b) => (
                  <BookCard key={b.book.id} book={b} coverUrl={c.coverUrl(b)} progress={progressOf(b, state).fraction} />
                ))}
              </Grid>
            )
          ) : (
            <>
              {series.length > 0 && (
                <>
                  <SectionTitle>Series</SectionTitle>
                  <Grid>
                    {series.map((g) => (
                      <SeriesCard key={g.key} group={g} record={state.series[g.key]} byId={byId} />
                    ))}
                  </Grid>
                </>
              )}
              {standalone.length > 0 && (
                <>
                  <SectionTitle>{series.length > 0 ? "Books" : "All books"}</SectionTitle>
                  <Grid>
                    {standalone.map((b) => (
                      <BookCard key={b.book.id} book={b} coverUrl={c.coverUrl(b)} progress={progressOf(b, state).fraction} />
                    ))}
                  </Grid>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-5 mb-3 text-[11px]/4 font-medium tracking-[0.08em] text-neutral-500 uppercase dark:text-neutral-400">{children}</h2>;
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-4 gap-y-6">
      {children}
    </ul>
  );
}

interface CardProps {
  book: ScannedBook;
  coverUrl: string | null;
  /** 0 to 1. */
  progress: number;
}

/** A book as a card: the cover, the title, the author and length, how far along. */
const BookCard = memo(function BookCard({ book, coverUrl, progress }: CardProps) {
  const c = useController();
  return (
    <li>
      <button type="button" onClick={() => c.openReader(book.book.id)} className="group block w-full rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500">
        <Cover url={coverUrl} title={book.book.title} className="w-full" />
        <p className="mt-2.5 truncate text-sm/5 font-medium text-neutral-950 group-hover:underline group-hover:underline-offset-2 dark:text-white">{book.book.title}</p>
        <p className="truncate text-xs/5 text-neutral-500 dark:text-neutral-400">
          {book.book.author || "Unknown author"} · {formatLeft(book.book.durationMs)}
        </p>
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-neutral-950/10 dark:bg-white/15" aria-hidden="true">
          <div className="h-full bg-amber-500 dark:bg-amber-400" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
        </div>
      </button>
    </li>
  );
});

/** A series as a card: three covers fanned, where you are, and Continue. */
function SeriesCard({ group, record, byId }: { group: SeriesGroup; record: SeriesRecord | undefined; byId: Map<string, ScannedBook> }) {
  const state = useAppState();
  const c = useController();
  const hidden = hiddenBookIds(record ? [record] : []);
  const ordered = orderBySeries(group.bookIds, (id) => id, record ? [record] : []).filter((id) => !hidden.has(id)).map((id) => byId.get(id)).filter((b): b is ScannedBook => !!b);
  const finished = ordered.filter((b) => progressOf(b, state).finished).length;
  const next = ordered.find((b) => !progressOf(b, state).finished) ?? ordered[0];
  const nextIndex = next ? ordered.indexOf(next) : -1;
  // Three covers around the next book, with the next one in front.
  const around = ordered.slice(Math.max(0, nextIndex - 1), Math.max(0, nextIndex - 1) + 3);
  const fan = next ? [...around.filter((b) => b !== next), next] : around;
  const leftOff = group.bookIds.length - ordered.length;
  return (
    <li className="col-span-2">
      <div className="grid grid-cols-[10.5rem_1fr] items-end gap-4">
        <button type="button" onClick={() => next && c.openReader(next.book.id)} className="relative block aspect-square w-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500" aria-label={`${group.name}: open`}>
          {fan.map((b, i) => (
            <div key={b.book.id} className={clsx("absolute inset-0", i === 0 && fan.length > 1 && "-translate-x-[8%] translate-y-[2%] -rotate-6", i === 1 && fan.length > 2 && "translate-x-[6%] -translate-y-[2%] rotate-3")}>
              <Cover url={c.coverUrl(b)} title={b.book.title} className="size-full" />
            </div>
          ))}
        </button>
        <div className="min-w-0">
          <button type="button" onClick={() => next && c.openReader(next.book.id)} className="block text-left text-base/6 font-medium text-neutral-950 hover:underline hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:text-white">
            {group.name}
          </button>
          <p className="text-sm/5 text-neutral-500 dark:text-neutral-400">
            {ordered.length} on the shelf · {finished} finished{leftOff > 0 ? ` · ${leftOff} left off` : ""}
          </p>
          {next && (
            <p className="mt-0.5 truncate text-sm/5 text-neutral-500 dark:text-neutral-400">
              {finished === ordered.length ? "All finished" : `Up next: ${next.book.title}`}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {next && finished < ordered.length && (
              <Button size="sm" variant="primary" onClick={() => void c.playBook(next)} className="py-1.5 pr-3 pl-2">
                <PlayIcon className="size-4 fill-current" />
                Continue
              </Button>
            )}
            {!record && (
              <Button size="sm" onClick={() => c.openSeriesSetup(group.key)}>
                Set up
              </Button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
