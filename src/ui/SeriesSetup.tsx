import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { defaultChoices, excludeShorterThan, isHandMade, normalizeChoices, type SeriesChoice } from "../core/series";
import { fold } from "../core/search";
import { formatLeft } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button, IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { Checkbox } from "./kit";
import { Cover } from "./Cover";

/**
 * Set up a series in a minute: which books belong, in what order, and
 * which to leave out. Opens once after a scan finds a series with no
 * record, can be skipped at any point, and can be reopened from
 * settings. Nothing here touches the disk until Save.
 */
export function SeriesSetup() {
  const state = useAppState();
  const c = useController();
  const setup = state.seriesSetup;
  const existing = setup ? state.series[setup.key] : undefined;
  const [choices, setChoices] = useState<SeriesChoice[]>([]);
  const [hours, setHours] = useState(4);
  const [adding, setAdding] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Books added in this dialog, which can be taken out again before Save. */
  const [addedHere, setAddedHere] = useState<string[]>([]);

  useEffect(() => {
    if (!setup) return;
    // Start from the record when there is one; new books join at the end.
    const base = existing ? existing.choices.filter((ch) => setup.bookIds.includes(ch.bookId)) : [];
    const known = new Set(base.map((ch) => ch.bookId));
    const fresh = defaultChoices(setup).filter((ch) => !known.has(ch.bookId));
    setChoices(normalizeChoices([...base, ...fresh.map((ch, i) => ({ ...ch, order: base.length + i + 1 }))]));
    setAdding("");
    setConfirmDelete(false);
    setAddedHere([]);
  }, [setup, existing]);

  const byId = useMemo(() => new Map(state.books.map((b) => [b.book.id, b])), [state.books]);
  if (!setup) return null;

  const ordered = [...choices].sort((a, b) => a.order - b.order);
  const included = choices.filter((ch) => ch.included).length;
  const durations = new Map(state.books.map((b) => [b.book.id, b.book.durationMs]));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const next = ordered.map((ch) => ({ ...ch }));
    [next[index]!.order, next[target]!.order] = [next[target]!.order, next[index]!.order];
    setChoices(normalizeChoices(next));
  };
  const toggle = (bookId: string) => setChoices(choices.map((ch) => (ch.bookId === bookId ? { ...ch, included: !ch.included } : ch)));
  // Books the listener put in by hand can be taken out again; detected ones can only be left off.
  const handMade = isHandMade(setup);
  const removable = new Set(handMade ? setup.bookIds : (setup.added ?? []));
  const remove = (bookId: string) => {
    setChoices(normalizeChoices(choices.filter((ch) => ch.bookId !== bookId)));
    setAddedHere(addedHere.filter((id) => id !== bookId));
  };
  const member = new Set(choices.map((ch) => ch.bookId));
  const needle = fold(adding.trim());
  const candidates = needle
    ? state.books.filter((b) => !member.has(b.book.id) && (fold(b.book.title).includes(needle) || fold(b.book.author).includes(needle))).slice(0, 6)
    : [];
  const add = (bookId: string) => {
    setChoices(normalizeChoices([...choices, { bookId, included: true, order: choices.length + 1 }]));
    setAddedHere([...addedHere, bookId]);
    setAdding("");
  };


  return (
    <Dialog
      open={!!setup}
      onClose={() => c.closeSeriesSetup()}
      labelId="series-setup-title"
      title={existing ? `Change ${setup.name}` : `Set up ${setup.name}`}
      description="Untick what you do not want on the shelf, put the books in the order you listen, and add any book detection missed. Nothing is deleted."
      hint={`${included} of ${choices.length} on the shelf`}
      actions={
        <>
          {handMade && existing && (
            <Button variant={confirmDelete ? "danger" : "ghost"} onClick={() => (confirmDelete ? void c.deleteSeries(setup.key) : setConfirmDelete(true))}>
              {confirmDelete ? "Delete for good" : "Delete series"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => (existing ? c.closeSeriesSetup() : void c.skipSeriesSetup())}>
            {existing ? "Cancel" : "Not now"}
          </Button>
          <Button variant="primary" onClick={() => void c.saveSeries(choices)} disabled={choices.length === 0}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-4 text-base/6 text-ink-2 sm:text-sm/5">
        <label htmlFor="series-min-hours">Leave off books shorter than</label>
        <input
          id="series-min-hours"
          name="series-min-hours"
          type="number"
          min={1}
          max={48}
          step={1}
          value={hours}
          onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))}
          className="w-14 rounded-md bg-raised px-2 py-0.5 text-base/6 text-ink tabular-nums ring-1 ring-line focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:text-sm/5"
        />
        <span>hours</span>
        <Button size="sm" onClick={() => setChoices(excludeShorterThan(choices, durations, hours * 3_600_000))}>
          Apply
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setChoices(choices.map((ch) => ({ ...ch, included: true })))}>
          Include all
        </Button>
      </div>

      <ol role="list" className="mx-3 mt-3 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto quiet-scroll rounded-md">
        {ordered.map((ch, i) => {
          const b = byId.get(ch.bookId);
          if (!b) return null;
          return (
            <li key={ch.bookId} className={clsx("group/row flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-raised", !ch.included && "opacity-55")}>
              <Checkbox id={`series-include-${ch.bookId}`} checked={ch.included} onChange={() => toggle(ch.bookId)} label={`Include ${b.book.title}`} />
              <span className="w-6 shrink-0 text-right text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{ch.order}</span>
              <Cover url={c.coverUrl(b)} title={b.book.title} className="size-9" />
              <div className="min-w-0 flex-1">
                <p className={clsx("truncate text-base/6 sm:text-sm/5", ch.included ? "font-medium text-ink" : "text-ink-2 line-through")}>{b.book.title}</p>
                <p className="truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
                  {b.book.author || "Unknown author"} · {formatLeft(b.book.durationMs)}
                </p>
              </div>
              <div className="flex shrink-0">
                <IconButton size="sm" label={`Move ${b.book.title} up`} icon={ArrowUpIcon} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton size="sm" label={`Move ${b.book.title} down`} icon={ArrowDownIcon} disabled={i === ordered.length - 1} onClick={() => move(i, 1)} />
                {(removable.has(ch.bookId) || addedHere.includes(ch.bookId)) && <IconButton size="sm" label={`Take ${b.book.title} out of the series`} icon={XMarkIcon} onClick={() => remove(ch.bookId)} />}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="shrink-0 px-5 pt-3 pb-4">
        <label htmlFor="series-add-book" className="sr-only">
          Add a book to the series
        </label>
        <input
          id="series-add-book"
          name="series-add-book"
          type="search"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Add a book: type a title or author"
          autoComplete="off"
          className="w-full rounded-md bg-raised px-3 py-1.5 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6"
        />
        {needle && (
          <ul role="list" className="mt-1 max-h-48 overflow-y-auto quiet-scroll rounded-md bg-surface p-1 ring-1 ring-line">
            {candidates.length === 0 && <li className="px-2 py-2 text-sm/5 text-ink-3">No other book matches.</li>}
            {candidates.map((b) => (
              <li key={b.book.id}>
                <button type="button" onClick={() => add(b.book.id)} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left focus-ring hover:bg-raised">
                  <PlusIcon className="size-4 shrink-0 fill-ink-3" aria-hidden="true" />
                  <Cover url={c.coverUrl(b)} title={b.book.title} className="size-8" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm/5 font-medium text-ink">{b.book.title}</span>
                    <span className="block truncate text-[0.8125rem]/5 text-ink-3">{b.book.author || "Unknown author"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
