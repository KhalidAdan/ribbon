import { ArrowDownIcon, ArrowUpIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultChoices, excludeShorterThan, normalizeChoices, type SeriesChoice } from "../core/series";
import { formatLeft } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
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
  const ref = useRef<HTMLDialogElement>(null);
  const existing = setup ? state.series[setup.key] : undefined;
  const [choices, setChoices] = useState<SeriesChoice[]>([]);
  const [hours, setHours] = useState(4);

  useEffect(() => {
    if (!setup) return;
    // Start from the record when there is one; new books join at the end.
    const base = existing ? existing.choices.filter((ch) => setup.bookIds.includes(ch.bookId)) : [];
    const known = new Set(base.map((ch) => ch.bookId));
    const fresh = defaultChoices(setup).filter((ch) => !known.has(ch.bookId));
    setChoices(normalizeChoices([...base, ...fresh.map((ch, i) => ({ ...ch, order: base.length + i + 1 }))]));
  }, [setup, existing]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (setup && !el.open) el.showModal();
    else if (!setup && el.open) el.close();
  }, [setup]);

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

  return (
    <dialog
      ref={ref}
      onClose={() => c.closeSeriesSetup()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          c.closeSeriesSetup();
        }
      }}
      aria-labelledby="series-setup-title"
      className="m-auto hidden max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl flex-col rounded-2xl bg-white p-0 text-neutral-950 shadow-2xl ring-1 ring-neutral-950/10 backdrop:bg-neutral-950/40 backdrop:backdrop-blur-sm open:flex dark:bg-neutral-900 dark:text-white dark:ring-white/10"
    >
      <header className="shrink-0 px-5 pt-5 sm:px-6">
        <h2 id="series-setup-title" className="text-xl font-semibold tracking-tight text-balance">
          Set up {setup.name}
        </h2>
        <p className="mt-1 text-sm/6 text-pretty text-neutral-500 dark:text-neutral-400">
          Untick anything you do not want on the shelf, and put the books in the order you want to listen. Nothing is deleted; you can change this later in settings.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="series-min-hours" className="text-sm/6 text-neutral-600 dark:text-neutral-400">
            Leave out books shorter than
          </label>
          <input
            id="series-min-hours"
            type="number"
            min={1}
            max={48}
            step={1}
            value={hours}
            onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded-md bg-white px-2 py-1 text-sm/6 text-neutral-950 ring-1 ring-neutral-950/10 focus:outline-2 focus:-outline-offset-1 focus:outline-amber-500 dark:bg-white/5 dark:text-white dark:ring-white/10"
          />
          <span className="text-sm/6 text-neutral-600 dark:text-neutral-400">hours</span>
          <Button size="sm" onClick={() => setChoices(excludeShorterThan(choices, durations, hours * 3_600_000))}>
            Apply
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setChoices(choices.map((ch) => ({ ...ch, included: true })))}>
            Include all
          </Button>
        </div>
      </header>

      <ol role="list" className="mt-3 min-h-0 flex-1 divide-y divide-neutral-950/5 overflow-y-auto px-3 sm:px-4 dark:divide-white/5">
        {ordered.map((ch, i) => {
          const b = byId.get(ch.bookId);
          if (!b) return null;
          return (
            <li key={ch.bookId} className={clsx("flex items-center gap-3 py-2", !ch.included && "opacity-60")}>
              <input
                id={`series-include-${ch.bookId}`}
                type="checkbox"
                checked={ch.included}
                onChange={() => toggle(ch.bookId)}
                className="size-4 shrink-0 accent-amber-500"
                aria-label={`Include ${b.book.title}`}
              />
              <span className="w-6 shrink-0 text-right text-sm/6 text-neutral-500 tabular-nums dark:text-neutral-400">{ch.order}</span>
              <Cover url={c.coverUrl(b)} title={b.book.title} className="size-10" />
              <div className="min-w-0 flex-1">
                <p className={clsx("truncate text-base/6 sm:text-sm/6", ch.included ? "font-medium text-neutral-950 dark:text-white" : "text-neutral-500 line-through dark:text-neutral-400")}>{b.book.title}</p>
                <p className="truncate text-sm/5 text-neutral-500 dark:text-neutral-400">
                  {b.book.author || "Unknown author"} · {formatLeft(b.book.durationMs)}
                </p>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <Button icon size="sm" variant="ghost" aria-label={`Move ${b.book.title} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUpIcon className="size-4 fill-current" />
                </Button>
                <Button icon size="sm" variant="ghost" aria-label={`Move ${b.book.title} down`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDownIcon className="size-4 fill-current" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-neutral-950/10 px-5 py-4 sm:px-6 dark:border-white/10">
        <p className="text-sm/6 text-neutral-500 tabular-nums dark:text-neutral-400">
          {included} of {choices.length} on the shelf
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void c.skipSeriesSetup()}>
            Skip for now
          </Button>
          <Button variant="primary" onClick={() => void c.saveSeries(choices)}>
            Save
          </Button>
        </div>
      </footer>
    </dialog>
  );
}
