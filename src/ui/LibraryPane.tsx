import { ArrowPathIcon, FolderOpenIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { memo, useEffect, useMemo, useState } from "react";
import type { Position } from "../core/types";
import type { ScannedBook } from "../core/scan/scan";
import { formatDuration } from "../core/speed";
import { compareBooks } from "../core/order";
import { indexBooks, searchBooks, type BookIndex } from "../core/search";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { ScanProgress } from "./ScanProgress";
import { SearchField } from "./SearchField";

export function LibraryPane() {
  const state = useAppState();
  const c = useController();
  const sorted = useMemo(() => {
    const listenedAt = (b: ScannedBook) => {
      const p = state.positions[b.book.id];
      return p ? Date.parse(p.updatedAt) : 0;
    };
    return [...state.books].sort((a, b) => {
      const d = listenedAt(b) - listenedAt(a);
      if (d !== 0) return d;
      return compareBooks(a.book, b.book);
    });
  }, [state.books, state.positions]);

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
  const shown = useMemo(() => {
    if (!matches) return sorted;
    const rank = new Map(matches.map((id, i) => [id, i]));
    return sorted.filter((b) => rank.has(b.book.id)).sort((a, b) => rank.get(a.book.id)! - rank.get(b.book.id)!);
  }, [sorted, matches]);

  const folderName = state.root ? state.root.split(/[\\/]/).filter(Boolean).pop() : "";

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Library">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 sm:px-5">
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
        <Button icon size="sm" variant="ghost" aria-label="Rescan library" title="Rescan library" onClick={() => void c.rescan()} disabled={state.scanning !== null}>
          <ArrowPathIcon className={clsx("size-4 fill-current", state.scanning && "animate-spin")} />
        </Button>
        <Button icon size="sm" variant="ghost" aria-label="Choose a different folder" title="Choose a different folder" onClick={() => c.forgetLibrary()}>
          <FolderOpenIcon className="size-4 fill-current" />
        </Button>
      </header>

      {sorted.length > 0 && (
        <div className="px-4 pb-3 sm:px-5">
          <SearchField value={query} onChange={setQuery} count={matches ? shown.length : null} onSubmit={() => shown[0] && void c.openBook(shown[0])} />
        </div>
      )}
      {state.scanErrors.length > 0 && (
        <p className="px-4 pb-2 text-sm/5 text-neutral-500 sm:px-5 dark:text-neutral-400" title={state.scanErrors.map((e) => `${e.path}: ${e.message}`).join("\n")}>
          {state.scanErrors.length.toLocaleString()} {state.scanErrors.length === 1 ? "file" : "files"} could not be read. Details are in the log.
        </p>
      )}
      {sorted.length === 0 && state.scanning ? (
        <ScanProgress status={state.scanning} />
      ) : sorted.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-base/7 text-neutral-500 sm:text-sm/6 dark:text-neutral-400">No audiobooks found in this folder.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-base/7 text-neutral-500 sm:text-sm/6 dark:text-neutral-400">Nothing matches “{query.trim()}”.</p>
        </div>
      ) : (
        <ul role="list" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 sm:px-3">
          {shown.map((b) => {
            const active = state.current?.book.book.id === b.book.id;
            return (
              <BookRow key={b.book.id} book={b} active={active} coverUrl={c.coverUrl(b)} position={state.positions[b.book.id] ?? null} playingAt={active ? state.player.positionMs : null} />
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface RowProps {
  book: ScannedBook;
  active: boolean;
  coverUrl: string | null;
  position: Position | null;
  /** The player's position when this is the open book, else null. */
  playingAt: number | null;
}

/**
 * One shelf row. Memoised on its own props so a progress tick in the
 * header, or another book's position, does not redraw the whole shelf:
 * while a scan streams in, the header changes many times a second.
 */
const BookRow = memo(function BookRow({ book, active, coverUrl, position, playingAt }: RowProps) {
  const c = useController();
  const offset = playingAt ?? position?.offsetMs ?? 0;
  const fraction = book.book.durationMs > 0 ? Math.min(1, offset / book.book.durationMs) : 0;
  const remaining = Math.max(0, book.book.durationMs - offset);
  const started = offset > 0;
  const finished = fraction >= 0.999;

  return (
    <li>
      <button
        type="button"
        onClick={() => void c.openBook(book)}
        aria-current={active ? "true" : undefined}
        className={clsx(
          "flex w-full items-center gap-3 rounded-lg p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
          active ? "bg-neutral-950/5 dark:bg-white/10" : "hover:bg-neutral-950/5 dark:hover:bg-white/5",
        )}
      >
        <Cover url={coverUrl} title={book.book.title} className="size-14" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base/6 font-medium text-neutral-950 sm:text-sm/6 dark:text-white">{book.book.title}</p>
          <p className="truncate text-sm/5 text-neutral-500 dark:text-neutral-400">
            {book.book.author || "Unknown author"}
            {book.book.series ? ` · ${book.book.series}${book.book.seriesIndex !== null ? ` ${book.book.seriesIndex}` : ""}` : ""}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-950/10 dark:bg-white/15" aria-hidden="true">
              <div className="h-full w-(--progress) rounded-full bg-amber-500 dark:bg-amber-400" style={{ "--progress": `${(fraction * 100).toFixed(1)}%` } as React.CSSProperties} />
            </div>
            <span className="shrink-0 text-xs/4 text-neutral-500 tabular-nums dark:text-neutral-400">
              {book.pending ? "Reading…" : finished ? "Finished" : started ? `${formatDuration(remaining)} left` : formatDuration(book.book.durationMs)}
            </span>
          </div>
        </div>
      </button>
    </li>
  );
});
