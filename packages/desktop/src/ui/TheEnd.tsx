import { readerOnly } from "@ribbon/core/ebook";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { hiddenBookIds, orderBySeries, seriesNumber } from "@ribbon/core/series";
import { formatLeft } from "@ribbon/core/speed";
import { listenThrough, readsOf, type ListenThrough } from "@ribbon/core/stats";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Dialog } from "./Dialog";
import { useKept } from "./modal";
import { progressOf, useShelfProgress } from "./progress";
import { useAppState, useController, useCovers } from "./store";

/**
 * The end of a book: a quiet card that says when it was started and
 * finished, and the time spent listening to it on every device, then the
 * next book in its series, for you to start when you choose: there's no
 * countdown. As the Apple app ends a book
 * (packages/apple/Ribbon/Listening/FinishedView.swift).
 */
export function TheEnd() {
  const c = useController();
  const live = useAppState((s) => (s.theEnd ? s.books.find((b) => b.book.id === s.theEnd) : undefined));
  // The book as it was when the card opened, until the card is gone.
  const [book, closed] = useKept(live ?? null);
  if (!book) return null;
  return <Card book={book} open={live !== undefined} onClose={() => c.closeTheEnd()} onClosed={closed} />;
}

function Card({ book, open, onClose, onClosed }: { book: ScannedBook; open: boolean; onClose: () => void; onClosed: () => void }) {
  const c = useController();
  const state = useAppState((s) => ({ history: s.history, books: s.books, series: s.series }));
  const shelf = useShelfProgress();
  useCovers();
  const id = book.book.id;
  const last = readsOf(state.history.reads, id).at(-1);
  const went = last?.finished ? listenThrough(last, state.history.sessions, id) : null;
  const next = upNext(book);

  /** The next book in its series not finished yet, and its number there. */
  function upNext(b: ScannedBook): { book: ScannedBook; number: string; series: string } | null {
    const group = c.detectedSeries().find((g) => g.bookIds.includes(b.book.id));
    if (!group) return null;
    const record = state.series[group.key];
    const records = record ? [record] : [];
    const ids = orderBySeries(group.bookIds, (x) => x, records);
    const hidden = hiddenBookIds(records);
    const byId = new Map(state.books.map((x) => [x.book.id, x]));
    for (const [i, nextId] of ids.entries()) {
      if (i <= ids.indexOf(b.book.id) || hidden.has(nextId)) continue;
      const candidate = byId.get(nextId);
      if (candidate && !progressOf(candidate, shelf, (bookId) => c.readingProgress(bookId)).finished) {
        return { book: candidate, number: seriesNumber(record, nextId, i + 1, group.numbers), series: group.name };
      }
    }
    return null;
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      labelId="the-end-title"
      title={`The end of ${book.book.title}`}
      description={went ? howItWent(went, new Date()) : undefined}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          {next && (
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                void c.playBook(next.book);
              }}
            >
              {readerOnly(next.book.book) ? "Start reading" : "Start listening"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex items-center gap-4 px-5 py-4">
        <Cover url={c.coverUrl(book)} title={book.book.title} className="w-20 shrink-0" />
        <div className="min-w-0">
          <p className="font-serif text-xl/7 font-semibold text-balance text-ink">{book.book.title}</p>
          <p className="text-base/6 text-ink-2 sm:text-sm/5">{book.book.author || "Author unknown"}</p>
        </div>
      </div>
      {next && (
        <section aria-labelledby="up-next-title" className="border-t border-line px-5 py-4">
          <h3 id="up-next-title" className="text-sm/5 font-medium text-ink-3 sm:text-[0.8125rem]/5">
            Up next in {next.series}
          </h3>
          <div className="mt-3 flex items-center gap-4">
            <Cover url={c.coverUrl(next.book)} title={next.book.book.title} className="w-14 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">Book {next.number}</p>
              <p className="font-serif text-lg/6 font-semibold text-balance text-ink">{next.book.book.title}</p>
              <p className="text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">{[next.book.book.author, readerOnly(next.book.book) ? "EPUB" : formatLeft(next.book.book.durationMs)].filter(Boolean).join(" · ")}</p>
            </div>
          </div>
        </section>
      )}
    </Dialog>
  );
}

/** "Started on 3 October, finished today. 11h 20m of listening, over 9 days." */
export function howItWent(went: ListenThrough, now: Date): string {
  const started = new Date(went.started);
  const finished = went.finished ? new Date(went.finished) : now;
  const days = Math.round((startOfDay(finished) - startOfDay(started)) / 86_400_000) + 1;
  let words = days === 1 ? `Started and finished ${day(finished, now)}.` : `Started ${day(started, now)}, finished ${day(finished, now)}.`;
  if (went.listenedMs > 0) words += ` ${formatLeft(went.listenedMs)} of listening${days > 1 ? `, over ${days} days` : ""}.`;
  return words;
}

/** A day as a sentence says it: "today", "yesterday", "on 3 October", with the year when it isn't this one. */
function day(date: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear() ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" };
  return `on ${date.toLocaleDateString(undefined, options)}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
