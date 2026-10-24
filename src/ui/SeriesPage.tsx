import { BookOpenIcon, CheckIcon, PauseIcon, PlayIcon, RectangleStackIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { splitPeople } from "../core/scan/sidefiles";
import { hiddenBookIds, orderBySeries, seriesNumber, type SeriesGroup, type SeriesRecord } from "../core/series";
import { formatLeft } from "../core/speed";
import { readerOnly } from "../core/ebook";
import { howFar, lengthOf, progressOf, useShelfProgress, type Progress } from "./progress";
import { useAppState, useController, useCovers } from "./store";
import { Button } from "./Button";
import { Cover, CoverStack } from "./Cover";
import { EmptyState, SegmentedProgress, Short } from "./kit";

/** Where you are in a series: its books in the listener's order, how far along each is, and what comes next. */
export interface SeriesStanding {
  /** Every member in order, the ones left off the shelf included. */
  ids: string[];
  /** Members left off the shelf. */
  hidden: Set<string>;
  /** The members on the shelf, in order, with how far along each is. */
  books: { book: ScannedBook; progress: Progress }[];
  finished: number;
  /** The first book on the shelf not finished, or the first when every one is. */
  next: { book: ScannedBook; progress: Progress } | null;
  allDone: boolean;
  /** Listening left in the books not finished. */
  leftMs: number;
}

export function seriesStanding(group: SeriesGroup, record: SeriesRecord | undefined, byId: ReadonlyMap<string, ScannedBook>, progressOf: (b: ScannedBook) => Progress): SeriesStanding {
  const records = record ? [record] : [];
  const ids = orderBySeries(group.bookIds, (id) => id, records);
  const hidden = hiddenBookIds(records);
  const books = ids.flatMap((id) => {
    const book = hidden.has(id) ? undefined : byId.get(id);
    return book ? [{ book, progress: progressOf(book) }] : [];
  });
  const finished = books.filter((b) => b.progress.finished).length;
  const next = books.find((b) => !b.progress.finished) ?? books[0] ?? null;
  const leftMs = books.reduce((s, b) => s + (b.progress.finished ? 0 : b.book.book.durationMs - b.progress.posMs), 0);
  return { ids, hidden, books, finished, next, allDone: books.length > 0 && finished === books.length, leftMs };
}

/** Hours for a whole series: "48h", not "48h 12m". */
function hoursOf(ms: number): string {
  return formatLeft(ms).replace(/ \d+m$/, "");
}

/**
 * One series: how far through it you are, the one thing to do next, and
 * every book in order under its number. Reached from the series card on
 * the shelf and from the series line on a book's page. Escape goes back
 * to the library.
 */
export function SeriesPage() {
  const state = useAppState((s) => ({ books: s.books, sources: s.sources, series: s.series, seriesKey: s.seriesKey, current: s.current, playing: s.player.playing, downloads: s.downloads }));
  const shelf = useShelfProgress();
  useCovers();
  const c = useController();
  const group = useMemo(() => c.detectedSeries().find((g) => g.key === state.seriesKey) ?? null, [c, state.seriesKey, state.books, state.sources, state.series]);
  const record = group ? state.series[group.key] : undefined;
  const byId = useMemo(() => new Map(state.books.map((b) => [b.book.id, b])), [state.books]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") c.showLibrary();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);

  if (!group) {
    return (
      <EmptyState icon={RectangleStackIcon} title="This series isn’t on the shelf any more" action={<Button onClick={() => c.showLibrary()}>Back to the library</Button>}>
        Its books may have left the shelf, or the series was forgotten.
      </EmptyState>
    );
  }

  const s = seriesStanding(group, record, byId, (b) => progressOf(b, shelf, (id) => c.readingProgress(id)));
  const next = s.next;
  const numberOf = (id: string) => seriesNumber(record, id, s.ids.indexOf(id) + 1, group.numbers);
  const titleOf = (b: ScannedBook) => group.titles?.[b.book.id] ?? b.book.title;
  const nextToRead = next ? readerOnly(next.book.book) : false;
  const playingNext = !!next && state.current?.book.book.id === next.book.book.id && state.playing;
  const downloading = !!next && !!state.downloads[next.book.book.id];

  const sentence = !next
    ? "Every book in it is left off the shelf."
    : s.allDone
      ? "Every book finished. Open any of them to read or hear it again."
      : next.progress.started
        ? `${nextToRead ? "Reading" : "Listening to"} book ${numberOf(next.book.book.id)}, ${titleOf(next.book)}, ${Math.max(1, Math.floor(next.progress.fraction * 100))}% ${nextToRead ? "through" : "in"}.${s.leftMs > 0 ? ` ${hoursOf(s.leftMs)} left in the series.` : ""}`
        : s.finished > 0
          ? `${s.finished} of ${s.books.length} finished. Up next, book ${numberOf(next.book.book.id)}: ${titleOf(next.book)}.${s.leftMs > 0 ? ` ${hoursOf(s.leftMs)} left in the series.` : ""}`
          : `Not started.${s.leftMs > 0 ? ` ${hoursOf(s.leftMs)} in all, starting with ${titleOf(next.book)}.` : ` It starts with ${titleOf(next.book)}.`}`;

  return (
    <section className="h-full overflow-y-auto quiet-scroll" aria-labelledby="series-title">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 pt-8 pb-16 sm:px-8 sm:pt-12">
        <header className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-5 gap-y-6 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start sm:gap-x-8 sm:gap-y-5">
          <CoverStack url={next ? c.coverUrl(next.book) : null} title={next ? next.book.book.title : group.name} count={s.books.length} className="w-full sm:row-span-2" />
          <div className="min-w-0">
            <h1 id="series-title" className="text-xl font-semibold text-balance text-ink">
              {group.name}
            </h1>
            <p className="mt-1 text-base/6 text-pretty text-ink-2 sm:text-sm/5">{byline(s.books.map((b) => b.book))}</p>
          </div>
          <div className="col-span-2 flex min-w-0 flex-col sm:col-span-1 sm:col-start-2">
            <p className="max-w-[52ch] border-l border-line-strong pl-3 text-base/6 text-pretty text-ink tabular-nums sm:text-[0.9375rem]/6">{sentence}</p>
            {s.books.length > 0 && <SegmentedProgress parts={s.books.map((b) => (b.progress.finished ? 1 : b.progress.fraction))} className="mt-4 max-w-sm" />}
            <div className="mt-6 flex flex-wrap items-center gap-2">
              {next && !s.allDone && (
                <Button
                  variant="primary"
                  leading={nextToRead ? BookOpenIcon : playingNext ? PauseIcon : PlayIcon}
                  disabled={downloading}
                  onClick={() => (nextToRead ? void c.openReading(next.book.book.id) : playingNext ? c.pause() : void c.playBook(next.book))}
                  className="max-sm:flex-1"
                >
                  {playingNext ? "Pause" : <Short phone={nextToRead ? "Read" : "Listen"}>{next.progress.started ? (nextToRead ? "Continue reading" : "Continue listening") : nextToRead ? "Start reading" : "Start listening"}</Short>}
                </Button>
              )}
              <Button variant="ghost" onClick={() => c.openSeriesSetup(group.key)}>
                {record ? "Change the series…" : "Set up the series…"}
              </Button>
            </div>
          </div>
        </header>

        <SeriesBooks group={group} record={record} ids={s.ids} hidden={s.hidden} place={next && !s.allDone ? { id: next.book.book.id, kind: "next" } : null} label={`The books in ${group.name}`} />
      </div>
    </section>
  );
}

/** "10 books by John French, Guy Haley and 4 others". */
function byline(books: ScannedBook[]): string {
  const authors: string[] = [];
  for (const b of books) for (const a of splitPeople(b.book.author)) if (!authors.some((x) => x.toLowerCase() === a.toLowerCase())) authors.push(a);
  const count = `${books.length} ${books.length === 1 ? "book" : "books"}`;
  if (authors.length === 0) return count;
  if (authors.length <= 3) return `${count} by ${authors.length === 1 ? authors[0] : `${authors.slice(0, -1).join(", ")} and ${authors[authors.length - 1]}`}`;
  return `${count} by ${authors.slice(0, 2).join(", ")} and ${authors.length - 2} others`;
}

/**
 * A series' books in order, each under its number, with how it stands;
 * books left off the shelf are dimmed. An amber mark shows your place:
 * the book whose page this is, or on the series' page, the one to go on with.
 */
export function SeriesBooks({ group, record, ids, hidden, place, label }: { group: SeriesGroup; record: SeriesRecord | undefined; ids: string[]; hidden: Set<string>; place: { id: string; kind: "page" | "next" } | null; label: string }) {
  const books = useAppState((s) => s.books);
  const byId = useMemo(() => new Map(books.map((b) => [b.book.id, b])), [books]);
  return (
    <ol role="list" aria-label={label} className="flex flex-col border-t border-line">
      {ids.map((id, i) => {
        const b = byId.get(id);
        if (!b) return null;
        return <SeriesRow key={id} book={b} number={seriesNumber(record, id, i + 1, group.numbers)} title={group.titles?.[id] ?? b.book.title} place={place?.id === id ? place.kind : null} off={hidden.has(id)} />;
      })}
    </ol>
  );
}

/** One book in a series: its number, cover, title, and how it stands. On a phone, how it stands takes the author's line. */
function SeriesRow({ book, number, title, place, off }: { book: ScannedBook; number: string; title: string; place: "page" | "next" | null; off: boolean }) {
  const shelf = useShelfProgress();
  useCovers();
  const c = useController();
  const p = progressOf(book, shelf, (id) => c.readingProgress(id));
  const standing = off ? "Left off the shelf" : p.finished ? "Finished" : p.started ? howFar(book, p, Math.max(1, Math.floor(p.fraction * 100))) : lengthOf(book);
  const done = p.finished && !off && <CheckIcon className="size-4 shrink-0 fill-ink-3" aria-hidden="true" />;
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={() => c.openReader(book.book.id)}
        aria-current={place === "page" ? "page" : undefined}
        className={clsx(
          "relative grid w-full grid-cols-[1.5rem_2.5rem_minmax(0,1fr)] items-center gap-3 py-2 pr-2 pl-3 text-left focus-ring sm:grid-cols-[2rem_2.5rem_minmax(0,1fr)_auto]",
          place === "page" ? "bg-raised" : "hover:bg-raised",
          off && "opacity-50",
        )}
      >
        {place && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-place" aria-hidden="true" />}
        <span className="text-right text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{number}</span>
        <Cover url={c.coverUrl(book)} title={book.book.title} className="w-10" />
        <span className="min-w-0">
          {/* Two lines, not one: volumes of one book differ only at the end ("…: Volume II"). */}
          <span className={clsx("line-clamp-2 text-base/6 text-ink sm:text-sm/5", place && "font-medium")}>{title}</span>
          <span className="block truncate text-sm/5 text-ink-3 max-sm:hidden sm:text-[0.8125rem]/5">{book.book.author}</span>
          <span className="flex items-center gap-1.5 text-sm/5 text-ink-2 tabular-nums sm:hidden">
            {done}
            <span className="truncate">{standing}</span>
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-sm/5 text-ink-2 tabular-nums max-sm:hidden sm:text-[0.8125rem]/5">
          {done}
          {standing}
        </span>
      </button>
    </li>
  );
}
