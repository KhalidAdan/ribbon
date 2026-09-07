import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { fold } from "../core/search";
import { formatLeft } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";

/**
 * Make a series by hand, for the ones detection misses: a name, then
 * the books in the order you pick them. Nothing touches the disk until
 * Create; ordering and leaving books off happen in the same setup every
 * series has, afterwards.
 */
export function NewSeries() {
  const state = useAppState();
  const c = useController();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (state.seriesNew && !el.open) {
      setName("");
      setQuery("");
      setPicked([]);
      el.showModal();
    } else if (!state.seriesNew && el.open) el.close();
  }, [state.seriesNew]);

  const needle = fold(query.trim());
  const shown = useMemo(() => {
    const list = needle ? state.books.filter((b) => fold(b.book.title).includes(needle) || fold(b.book.author).includes(needle)) : state.books;
    return list;
  }, [state.books, needle]);
  if (!state.seriesNew) return null;

  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const ready = name.trim().length > 0 && picked.length > 0;

  return (
    <dialog
      ref={ref}
      onClose={() => c.closeNewSeries()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          c.closeNewSeries();
        }
      }}
      aria-labelledby="new-series-title"
      className="m-auto hidden max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl flex-col rounded-2xl bg-white p-0 text-neutral-950 shadow-2xl ring-1 ring-neutral-950/10 backdrop:bg-neutral-950/40 backdrop:backdrop-blur-sm open:flex dark:bg-neutral-900 dark:text-white dark:ring-white/10"
    >
      <header className="shrink-0 px-5 pt-5 sm:px-6">
        <h2 id="new-series-title" className="text-xl font-semibold tracking-tight">
          New series
        </h2>
        <p className="mt-1 text-sm/6 text-pretty text-neutral-500 dark:text-neutral-400">Name it, then tick the books in the order you want to listen. You can reorder and leave books off afterwards, like any series.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <label htmlFor="new-series-name" className="sr-only">
            Series name
          </label>
          <input
            id="new-series-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Series name"
            autoComplete="off"
            autoFocus
            className="w-full rounded-md bg-white px-3 py-1.5 text-base/6 text-neutral-950 ring-1 ring-neutral-950/10 placeholder:text-neutral-400 focus:outline-2 focus:-outline-offset-1 focus:outline-amber-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:ring-white/10"
          />
          <label htmlFor="new-series-filter" className="sr-only">
            Find books
          </label>
          <input
            id="new-series-filter"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a title or author…"
            autoComplete="off"
            className="w-full rounded-md bg-white px-3 py-1.5 text-base/6 text-neutral-950 ring-1 ring-neutral-950/10 placeholder:text-neutral-400 focus:outline-2 focus:-outline-offset-1 focus:outline-amber-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:ring-white/10"
          />
        </div>
      </header>

      <ol role="list" className="mt-3 min-h-0 flex-1 divide-y divide-neutral-950/5 overflow-y-auto px-3 sm:px-4 dark:divide-white/5">
        {shown.length === 0 && <li className="px-2 py-6 text-center text-sm/6 text-neutral-500 dark:text-neutral-400">No book matches.</li>}
        {shown.map((b) => {
          const at = picked.indexOf(b.book.id);
          return (
            <li key={b.book.id}>
              <label className={clsx("flex cursor-pointer items-center gap-3 py-2", at < 0 && "opacity-80")}>
                <input type="checkbox" checked={at >= 0} onChange={() => toggle(b.book.id)} className="size-4 shrink-0 accent-amber-500" aria-label={`Include ${b.book.title}`} />
                <span className="w-6 shrink-0 text-right text-sm/6 text-neutral-500 tabular-nums dark:text-neutral-400">{at >= 0 ? at + 1 : ""}</span>
                <Cover url={c.coverUrl(b)} title={b.book.title} className="size-10" />
                <span className="min-w-0 flex-1">
                  <span className={clsx("block truncate text-base/6 sm:text-sm/6", at >= 0 ? "font-medium text-neutral-950 dark:text-white" : "text-neutral-700 dark:text-neutral-300")}>{b.book.title}</span>
                  <span className="block truncate text-sm/5 text-neutral-500 dark:text-neutral-400">
                    {b.book.author || "Unknown author"} · {formatLeft(b.book.durationMs)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ol>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-neutral-950/10 px-5 py-4 sm:px-6 dark:border-white/10">
        <p className="text-sm/6 text-neutral-500 tabular-nums dark:text-neutral-400">
          {picked.length} {picked.length === 1 ? "book" : "books"} picked
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => c.closeNewSeries()}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => void c.createSeries(name, picked)}>
            Create
          </Button>
        </div>
      </footer>
    </dialog>
  );
}
