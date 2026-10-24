import { ArrowDownIcon, ArrowUpIcon, Bars2Icon, PlusIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { defaultChoices, excludeShorterThan, isHandMade, normalizeChoices, sortByNumber, type SeriesChoice } from "../core/series";
import { fold } from "../core/search";
import { lengthOf } from "./progress";
import { readerOnly } from "../core/ebook";
import { useAppState, useController, useCovers } from "./store";
import { Button, IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { useKept } from "./modal";
import { Checkbox, Menu, type MenuItem } from "./kit";
import { Cover } from "./Cover";

/**
 * A series, set up or changed: its name, which books belong, in what
 * order and under what numbers, which to leave off the shelf, and books
 * moved to another series or taken out. Opens once after a scan finds a
 * series with no record; reopens from the series card, the book page
 * and settings. Nothing touches the disk until Save.
 */
export function SeriesSetup() {
  const live = useAppState((s) => ({ seriesSetup: s.seriesSetup, series: s.series, books: s.books }));
  useCovers();
  const c = useController();
  // On its way out it shows what it showed last, not what Save or Forget just changed.
  const [kept, closed] = useKept(live.seriesSetup ? live : null);
  const state = kept ?? live;
  const setup = state.seriesSetup;
  const existing = setup ? state.series[setup.key] : undefined;
  const [choices, setChoices] = useState<SeriesChoice[]>([]);
  const [name, setName] = useState("");
  const [hours, setHours] = useState(4);
  const [adding, setAdding] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Books leaving this series, and for a move, where they go. */
  const [out, setOut] = useState<Map<string, string | null>>(new Map());
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    if (!setup) return;
    // Start from the record when there is one; new books join at the end.
    const base = existing ? existing.choices.filter((ch) => setup.bookIds.includes(ch.bookId) && !ch.removed) : [];
    const known = new Set(base.map((ch) => ch.bookId));
    const fresh = defaultChoices(setup).filter((ch) => !known.has(ch.bookId));
    setChoices(normalizeChoices([...base, ...fresh.map((ch, i) => ({ ...ch, order: base.length + i + 1 }))]));
    setName(existing?.name || setup.name);
    setAdding("");
    setConfirmDelete(false);
    setOut(new Map());
  }, [setup, existing]);

  const byId = useMemo(() => new Map(state.books.map((b) => [b.book.id, b])), [state.books]);
  const otherSeries = useMemo(() => (setup ? c.detectedSeries().filter((g) => g.key !== setup.key) : []), [c, setup, state.books, state.series]);
  if (!setup) return null;

  const shown = [...choices].sort((a, b) => a.order - b.order).filter((ch) => !out.has(ch.bookId));
  const included = shown.filter((ch) => ch.included).length;
  // A book that is only its EPUB has no length to be too short by.
  const durations = new Map(state.books.map((b) => [b.book.id, readerOnly(b.book) ? Infinity : b.book.durationMs]));
  const handMade = isHandMade(setup);

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const list = [...choices].sort((a, b) => a.order - b.order);
    const from = list.findIndex((c2) => c2.bookId === fromId);
    const to = list.findIndex((c2) => c2.bookId === toId);
    // A dragged book drops its number: where it now sits says where it goes.
    const { number: _was, ...moved } = list.splice(from, 1)[0]!;
    list.splice(to, 0, moved);
    setChoices(list.map((c2, i) => ({ ...c2, order: i + 1 })));
  };
  const step = (bookId: string, delta: number) => {
    const i = shown.findIndex((c2) => c2.bookId === bookId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= shown.length) return;
    reorder(bookId, shown[j]!.bookId);
  };
  const toggle = (bookId: string) => setChoices(choices.map((ch) => (ch.bookId === bookId ? { ...ch, included: !ch.included } : ch)));
  const setNumber = (bookId: string, text: string) => {
    const t = text.trim();
    const n = Number(t);
    const next = choices.map((ch) => {
      if (ch.bookId !== bookId) return ch;
      const { number: _old, ...rest } = ch;
      return t && Number.isFinite(n) ? { ...rest, number: n } : rest;
    });
    setChoices(sortByNumber(next, setup.numbers));
  };
  const takeOut = (bookId: string, toKey: string | null) => setOut(new Map(out).set(bookId, toKey));
  const member = new Set(choices.map((ch) => ch.bookId));
  const needle = fold(adding.trim());
  const candidates = needle ? state.books.filter((b) => !member.has(b.book.id) && (fold(b.book.title).includes(needle) || fold(b.book.author).includes(needle))).slice(0, 6) : [];
  const add = (bookId: string) => {
    setChoices(normalizeChoices([...choices, { bookId, included: true, order: choices.length + 1 }]));
    setAdding("");
  };

  const save = () => {
    const moves = [...out.entries()].filter((e): e is [string, string] => e[1] !== null).map(([bookId, toKey]) => ({ bookId, toKey }));
    // Taken out with nowhere to go: marked removed, so detection does not put it back.
    const kept = choices.map((ch) => (out.has(ch.bookId) ? { ...ch, removed: true } : ch));
    const removedBefore = (existing?.choices ?? []).filter((ch) => ch.removed && !member.has(ch.bookId));
    void c.saveSeries([...kept, ...removedBefore.map((ch, i) => ({ ...ch, order: kept.length + i + 1 }))], { name, moves });
  };

  return (
    <Dialog
      open={live.seriesSetup !== null}
      onClose={() => c.closeSeriesSetup()}
      onClosed={closed}
      labelId="series-setup-title"
      wide
      title={existing ? `Change ${existing.name || setup.name}` : `Set up ${setup.name}`}
      description="Name it, put the books in the order you listen, number them, and untick anything you do not want on the shelf. Drag a book, or use the arrows. Nothing is deleted."
      hint={`${included} of ${shown.length} on the shelf${out.size > 0 ? `, ${out.size} leaving` : ""}`}
      actions={
        <>
          {existing && (
            <Button
              variant={confirmDelete ? "danger" : "ghost"}
              onClick={() => (confirmDelete ? void c.forgetSeries(setup.key) : setConfirmDelete(true))}
            >
              {confirmDelete ? (handMade ? "Delete for good" : "Forget my changes") : handMade ? "Delete series" : "Forget my changes…"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => (existing ? c.closeSeriesSetup() : void c.skipSeriesSetup())}>
            {existing ? "Cancel" : "Not now"}
          </Button>
          <Button variant="primary" onClick={save} disabled={shown.length === 0 || !name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 flex-col gap-3 px-5 pt-4">
        <div>
          <label htmlFor="series-name" className="mb-1 block text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">
            Name
          </label>
          <input
            id="series-name"
            name="series-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            className="w-full rounded-md bg-raised px-2.5 py-1.5 text-base/6 text-ink ring-1 ring-line focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-base/6 text-ink-2 sm:text-sm/5">
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
      </div>

      <ol role="list" className="mx-3 mt-3 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto quiet-scroll">
        {shown.map((ch, i) => {
          const b = byId.get(ch.bookId);
          if (!b) return null;
          const items: MenuItem[] = [
            ...otherSeries.slice(0, 8).map((g) => ({ label: `Move to ${g.name}`, onSelect: () => takeOut(ch.bookId, g.key) })),
            { label: "Take out of this series", onSelect: () => takeOut(ch.bookId, null) },
          ];
          return (
            <li
              key={ch.bookId}
              draggable
              onDragStart={(e) => {
                setDragging(ch.bookId);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (dragging !== ch.bookId) reorder(dragging, ch.bookId);
              }}
              className={clsx("group/row flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-raised", !ch.included && "opacity-55", dragging === ch.bookId && "bg-raised ring-1 ring-line-strong")}
            >
              <Bars2Icon className="size-4 shrink-0 cursor-grab fill-ink-3 max-sm:hidden" aria-hidden="true" />
              <Checkbox id={`series-include-${ch.bookId}`} checked={ch.included} onChange={() => toggle(ch.bookId)} label={`Keep ${b.book.title} on the shelf`} />
              <label htmlFor={`series-number-${ch.bookId}`} className="sr-only">
                Number of {b.book.title} in the series
              </label>
              <input
                key={`${ch.bookId}-${ch.number ?? ""}`}
                id={`series-number-${ch.bookId}`}
                name={`series-number-${ch.bookId}`}
                inputMode="decimal"
                defaultValue={ch.number !== undefined ? String(ch.number) : ""}
                placeholder={String(setup.numbers?.[ch.bookId] ?? i + 1)}
                onBlur={(e) => setNumber(ch.bookId, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="w-11 shrink-0 rounded-md bg-transparent px-1.5 py-0.5 text-right text-sm/5 text-ink tabular-nums ring-1 ring-transparent placeholder:text-ink-3 hover:ring-line focus:bg-raised focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:text-[0.8125rem]/5"
              />
              <Cover url={c.coverUrl(b)} title={b.book.title} className="size-9" />
              <div className="min-w-0 flex-1">
                <p className={clsx("truncate text-base/6 sm:text-sm/5", ch.included ? "font-medium text-ink" : "text-ink-2 line-through")}>{setup.titles?.[ch.bookId] ?? b.book.title}</p>
                <p className="truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
                  {b.book.author || "Unknown author"} · {lengthOf(b)}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <IconButton size="sm" label={`Move ${b.book.title} up`} icon={ArrowUpIcon} disabled={i === 0} onClick={() => step(ch.bookId, -1)} />
                <IconButton size="sm" label={`Move ${b.book.title} down`} icon={ArrowDownIcon} disabled={i === shown.length - 1} onClick={() => step(ch.bookId, 1)} />
                <Menu label={`${b.book.title}: more`} title={b.book.title} items={items} />
              </div>
            </li>
          );
        })}
      </ol>

      {out.size > 0 && (
        <div className="mx-5 mt-2 rounded-md bg-raised px-3 py-2 text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">
          Leaving on Save:{" "}
          {[...out.entries()].map(([id, to], k) => (
            <span key={id}>
              {k > 0 && ", "}
              {byId.get(id)?.book.title ?? id}
              {to ? ` (to ${otherSeries.find((g) => g.key === to)?.name ?? "another series"})` : ""}
            </span>
          ))}
          .{" "}
          <button type="button" onClick={() => setOut(new Map())} className="rounded-sm text-ink underline-offset-2 focus-ring hover:underline">
            Keep them
          </button>
        </div>
      )}

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

