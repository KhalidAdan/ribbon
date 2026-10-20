import { ArrowsUpDownIcon, FunnelIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useMemo, useState } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { facetCounts, filterCount, missing, SORT_LABELS, SORTS, type BookFacts, type FacetKind, type LibraryFilter, type LibraryView, type Missing, type SortKey, type Standing } from "../core/view";
import { fold } from "../core/search";
import { useAppState, useController } from "./store";
import { progressOf, useShelfProgress } from "./progress";
import { Button, IconButton } from "./Button";
import { Drawer } from "./Drawer";
import { Checkbox, Group } from "./kit";

/** How far along, when last listened, and which series: what filters and sorts need to know about a book. */
export function useShelfFacts(): BookFacts {
  const state = useAppState((s) => ({ books: s.books, series: s.series, sources: s.sources }));
  const progress = useShelfProgress();
  const c = useController();
  const seriesById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of c.detectedSeries()) for (const id of g.bookIds) if (!m.has(id)) m.set(id, g.name);
    return m;
  }, [c, state.books, state.series, state.sources]);
  // A book that is only its EPUB is as far along as its reading place.
  const reading = (id: string) => c.readingProgress(id);
  return useMemo<BookFacts>(
    () => ({
      standing: (b) => {
        const p = progressOf(b, progress, reading);
        return p.finished ? "finished" : p.started ? "started" : "new";
      },
      fraction: (b) => progressOf(b, progress, reading).fraction,
      listenedAt: (b) => {
        const p = progress.positions[b.book.id];
        return p ? Date.parse(p.updatedAt) : 0;
      },
      seriesOf: (b) => seriesById.get(b.book.id) ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [progress, seriesById],
  );
}

const STANDING: { value: Standing; label: string }[] = [
  { value: "new", label: "Not started" },
  { value: "started", label: "In progress" },
  { value: "finished", label: "Finished" },
];

const MISSING: { value: Missing; label: string }[] = [
  { value: "cover", label: "No cover" },
  { value: "chapters", label: "No chapters" },
  { value: "description", label: "No description" },
];

const FACETS: { kind: FacetKind; label: string; plural: string }[] = [
  { kind: "author", label: "Author", plural: "Authors" },
  { kind: "narrator", label: "Narrator", plural: "Narrators" },
  { kind: "genre", label: "Genre", plural: "Genres" },
  { kind: "series", label: "Series", plural: "Series" },
];

function toggled<T>(list: T[] | undefined, v: T): T[] {
  const have = list ?? [];
  return have.includes(v) ? have.filter((x) => x !== v) : [...have, v];
}

function withFilter(view: LibraryView, key: keyof LibraryFilter, values: string[]): LibraryView {
  const filter = { ...view.filter } as Record<string, string[]>;
  if (values.length === 0) delete filter[key];
  else filter[key] = values;
  return { ...view, filter: filter as LibraryFilter };
}

/** In words, what the filtered shelf shows: "In progress, by Dan Abnett, in Military". */
export function describeFilter(f: LibraryFilter): string {
  const parts: string[] = [];
  const or = (list: string[]) => (list.length <= 2 ? list.join(" or ") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`);
  if (f.standing?.length) parts.push(or(f.standing.map((s) => STANDING.find((x) => x.value === s)!.label.toLowerCase())));
  if (f.author?.length) parts.push(`by ${or(f.author)}`);
  if (f.narrator?.length) parts.push(`read by ${or(f.narrator)}`);
  if (f.genre?.length) parts.push(`in ${or(f.genre)}`);
  if (f.series?.length) parts.push(`from ${or(f.series)}`);
  if (f.missing?.length) parts.push(`with ${or(f.missing.map((m) => MISSING.find((x) => x.value === m)!.label.toLowerCase()))}`);
  const text = parts.join(", ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}

/**
 * The row above the shelf: Filter, the filters that are on as chips you
 * can take off, and the sort. Filters combine; within one kind any value
 * will do.
 */
export function ViewBar() {
  const view = useAppState((s) => s.view);
  const c = useController();
  const [open, setOpen] = useState(false);
  const n = filterCount(view.filter);
  const chips: { key: keyof LibraryFilter; value: string; label: string }[] = [
    ...(view.filter.standing ?? []).map((v) => ({ key: "standing" as const, value: v, label: STANDING.find((x) => x.value === v)!.label })),
    ...FACETS.flatMap((f) => (view.filter[f.kind] ?? []).map((v) => ({ key: f.kind, value: v, label: v }))),
    ...(view.filter.missing ?? []).map((v) => ({ key: "missing" as const, value: v, label: MISSING.find((x) => x.value === v)!.label })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={n > 0 ? "secondary" : "ghost"} leading={FunnelIcon} onClick={() => setOpen(true)} aria-haspopup="dialog">
        Filter{n > 0 ? ` · ${n}` : ""}
      </Button>
      {chips.map((ch) => (
        <span key={`${ch.key}:${ch.value}`} className="inline-flex items-center gap-0.5 rounded-md bg-raised py-0.5 pr-0.5 pl-2 text-sm/5 text-ink ring-1 ring-line sm:text-[0.8125rem]/5">
          {ch.label}
          <button
            type="button"
            onClick={() => c.setView(withFilter(view, ch.key, ((view.filter[ch.key] ?? []) as string[]).filter((v) => v !== ch.value)))}
            aria-label={`Stop filtering by ${ch.label}`}
            className="rounded-[4px] p-0.5 text-ink-3 focus-ring hover:bg-line hover:text-ink"
          >
            <XMarkIcon className="size-3.5 fill-current" aria-hidden="true" />
          </button>
        </span>
      ))}
      {n > 1 && (
        <Button size="sm" variant="ghost" onClick={() => c.setView({ ...view, filter: {} })}>
          Clear
        </Button>
      )}
      <div className="ml-auto flex items-center gap-1">
        <label htmlFor="shelf-sort" className="sr-only">
          Sort by
        </label>
        <span className="inline-grid grid-cols-[1fr_--spacing(7)]">
          <select
            id="shelf-sort"
            name="shelf-sort"
            value={view.sort}
            onChange={(e) => c.setView({ ...view, sort: e.target.value as SortKey, reverse: false })}
            className="col-span-full row-start-1 appearance-none rounded-md bg-transparent py-1 pr-7 pl-2.5 text-base/6 text-ink-2 focus-ring hover:bg-raised hover:text-ink sm:text-[0.8125rem]/[1.125rem]"
          >
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
          <svg viewBox="0 0 8 5" width="8" height="5" fill="none" className="pointer-events-none col-start-2 row-start-1 place-self-center stroke-ink-3" aria-hidden="true">
            <path d="M.5.5 4 4 7.5.5" />
          </svg>
        </span>
        <IconButton size="sm" label={view.reverse ? "Natural order" : "Reverse the order"} icon={ArrowsUpDownIcon} aria-pressed={view.reverse} onClick={() => c.setView({ ...view, reverse: !view.reverse })} className={clsx(view.reverse && "bg-raised text-ink")} />
      </div>
      <FilterPanel open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/** Everything to filter by, with how many books each choice would show. */
function FilterPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useAppState((s) => ({ books: s.books, view: s.view }));
  const c = useController();
  const facts = useShelfFacts();
  const view = state.view;
  const set = (key: keyof LibraryFilter, values: string[]) => c.setView(withFilter(view, key, values));
  const standingCounts = useMemo(() => {
    const m = new Map<Standing, number>();
    for (const b of state.books) m.set(facts.standing(b), (m.get(facts.standing(b)) ?? 0) + 1);
    return m;
  }, [state.books, facts]);
  return (
    <Drawer open={open} onClose={onClose} title="Filter the shelf">
      <div className="flex flex-col gap-6 pb-4">
        <Group label="Where you are">
          {STANDING.map((s) => (
            <CheckRow key={s.value} id={`f-standing-${s.value}`} label={s.label} count={standingCounts.get(s.value) ?? 0} checked={view.filter.standing?.includes(s.value) ?? false} onChange={() => set("standing", toggled(view.filter.standing, s.value))} />
          ))}
        </Group>
        {FACETS.map((f) => (
          <FacetGroup key={f.kind} kind={f.kind} label={f.plural} books={state.books} facts={facts} chosen={view.filter[f.kind] ?? []} onChange={(v) => set(f.kind, v)} />
        ))}
        <Group label="Needs attention">
          {MISSING.map((m) => (
            <CheckRow key={m.value} id={`f-missing-${m.value}`} label={m.label} count={state.books.filter((b) => missing(b, m.value)).length} checked={view.filter.missing?.includes(m.value) ?? false} onChange={() => set("missing", toggled(view.filter.missing, m.value))} />
          ))}
        </Group>
        {filterCount(view.filter) > 0 && (
          <Button variant="ghost" onClick={() => c.setView({ ...view, filter: {} })} className="self-start">
            Clear every filter
          </Button>
        )}
      </div>
    </Drawer>
  );
}

const SHOWN = 8;

function FacetGroup({ kind, label, books, facts, chosen, onChange }: { kind: FacetKind; label: string; books: readonly ScannedBook[]; facts: BookFacts; chosen: string[]; onChange: (v: string[]) => void }) {
  const counts = useMemo(() => facetCounts(books, kind, facts), [books, kind, facts]);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  if (counts.length === 0) return null;
  const needle = fold(q.trim());
  const list = needle ? counts.filter((c) => fold(c.value).includes(needle)) : all ? counts : counts.slice(0, SHOWN);
  // A chosen value stays visible even when it is not among the most common.
  for (const v of chosen) if (!list.some((x) => x.value.toLowerCase() === v.toLowerCase())) list.push({ value: v, count: counts.find((x) => x.value.toLowerCase() === v.toLowerCase())?.count ?? 0 });
  const isChosen = (v: string) => chosen.some((x) => x.toLowerCase() === v.toLowerCase());
  return (
    <Group
      label={label}
      footer={
        counts.length > SHOWN && !needle ? (
          <button type="button" onClick={() => setAll((v) => !v)} className="rounded-sm text-ink-2 focus-ring hover:text-ink">
            {all ? "Show fewer" : `Show all ${counts.length}`}
          </button>
        ) : undefined
      }
    >
      {counts.length > SHOWN && (
        <div className="rounded-md bg-raised px-2 py-1.5">
          <label htmlFor={`f-${kind}-q`} className="sr-only">
            Find {label.toLowerCase()}
          </label>
          <input
            id={`f-${kind}-q`}
            name={`f-${kind}-q`}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Find ${label.toLowerCase()}`}
            autoComplete="off"
            className="w-full rounded-md bg-transparent px-1 text-base/6 text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-place sm:text-sm/6"
          />
        </div>
      )}
      {list.map((x) => (
        <CheckRow key={x.value} id={`f-${kind}-${x.value}`} label={x.value} count={x.count} checked={isChosen(x.value)} onChange={() => onChange(isChosen(x.value) ? chosen.filter((v) => v.toLowerCase() !== x.value.toLowerCase()) : [...chosen, x.value])} />
      ))}
    </Group>
  );
}

function CheckRow({ id, label, count, checked, onChange }: { id: string; label: string; count: number; checked: boolean; onChange: () => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 rounded-md bg-raised px-3 py-2 hover:bg-line">
      <Checkbox id={id} checked={checked} onChange={onChange} />
      <span className="min-w-0 flex-1 truncate text-base/6 text-ink sm:text-sm/5">{label}</span>
      <span className="shrink-0 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{count}</span>
    </label>
  );
}
