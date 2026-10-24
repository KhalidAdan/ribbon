import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { fold } from "../core/search";
import { lengthOf } from "./progress";
import { useAppState, useController, useCovers } from "./store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { useKept } from "./modal";
import { Checkbox } from "./kit";
import { Cover } from "./Cover";

/**
 * Make a series by hand, for the ones detection misses: a name, then
 * the books in the order you pick them. Nothing touches the disk until
 * Create; ordering and leaving books off happen in the same setup every
 * series has, afterwards.
 */
export function NewSeries() {
  const live = useAppState((s) => ({ seriesNew: s.seriesNew, books: s.books }));
  useCovers();
  const c = useController();
  // On its way out it shows what it showed last, not the shelf Create just changed.
  const [kept, closed] = useKept(live.seriesNew ? live : null);
  const state = kept ?? live;
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    if (!state.seriesNew) return;
    setName("");
    setQuery("");
    setPicked([]);
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
    <Dialog
      open={live.seriesNew}
      onClose={() => c.closeNewSeries()}
      onClosed={closed}
      labelId="new-series-title"
      title="New series"
      description="Name it, then tick the books in the order you listen. You can reorder and leave books off afterwards, like any series."
      hint={`${picked.length} ${picked.length === 1 ? "book" : "books"} picked`}
      actions={
        <>
          <Button variant="ghost" onClick={() => c.closeNewSeries()}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => void c.createSeries(name, picked)}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 flex-col gap-2 px-5 pt-4 sm:flex-row">
        <label htmlFor="new-series-name" className="sr-only">
          Series name
        </label>
        <input
          id="new-series-name"
          name="new-series-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Series name"
          autoComplete="off"
          autoFocus
          className="w-full rounded-md bg-raised px-3 py-1.5 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6"
        />
        <label htmlFor="new-series-filter" className="sr-only">
          Find books
        </label>
        <input
          id="new-series-filter"
          name="new-series-filter"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a title or author"
          autoComplete="off"
          className="w-full rounded-md bg-raised px-3 py-1.5 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6"
        />
      </div>

      <ol role="list" className="mx-3 mt-3 mb-3 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto quiet-scroll">
        {shown.length === 0 && <li className="px-2 py-6 text-center text-sm/5 text-ink-3">No book matches.</li>}
        {shown.map((b) => {
          const at = picked.indexOf(b.book.id);
          return (
            <li key={b.book.id}>
              <label className={clsx("flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-raised", at < 0 && "opacity-80")}>
                <Checkbox checked={at >= 0} onChange={() => toggle(b.book.id)} label={`Include ${b.book.title}`} name={`pick-${b.book.id}`} />
                <span className="w-6 shrink-0 text-right text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{at >= 0 ? at + 1 : ""}</span>
                <Cover url={c.coverUrl(b)} title={b.book.title} className="size-9" />
                <span className="min-w-0 flex-1">
                  <span className={clsx("block truncate text-base/6 sm:text-sm/5", at >= 0 ? "font-medium text-ink" : "text-ink-2")}>{b.book.title}</span>
                  <span className="block truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
                    {b.book.author || "Unknown author"} · {lengthOf(b)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ol>
    </Dialog>
  );
}
