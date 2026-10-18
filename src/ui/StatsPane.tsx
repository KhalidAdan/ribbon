import { ChartBarIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useMemo } from "react";
import { splitPeople } from "../core/scan/sidefiles";
import { bookIdOf, formatSpan, heatmap, timeBy, totals } from "../core/stats";
import { useAppState, useController } from "./store";
import { Cover } from "./Cover";
import { EmptyState, SectionHeader } from "./kit";

/**
 * What you have been listening to, from the sessions in the position
 * log: this week as a sentence, the numbers that matter, a year of days,
 * and where the time went. Kept beside the books; nothing leaves the
 * machine except through your own sync.
 */
export function StatsPane() {
  const state = useAppState();
  const c = useController();
  const { sessions, reads, recording } = state.history;
  const now = Date.now();
  const tz = new Date().getTimezoneOffset();
  const t = useMemo(() => totals(sessions, reads, now, tz), [sessions, reads, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const weeks = useMemo(() => heatmap(sessions, now, tz), [sessions, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(state.books.map((b) => [b.book.id, b])), [state.books]);
  const books = useMemo(() => timeBy(sessions, (id) => [id]).filter((x) => byId.has(x.key)).slice(0, 6), [sessions, byId]);
  const authors = useMemo(() => timeBy(sessions, (id) => splitPeople(byId.get(id)?.book.author ?? "")).slice(0, 6), [sessions, byId]);
  const narrators = useMemo(() => timeBy(sessions, (id) => splitPeople(byId.get(id)?.book.narrator ?? "")).slice(0, 6), [sessions, byId]);
  const finished = useMemo(
    () =>
      reads
        .filter((r) => r.finished)
        .sort((a, b) => Date.parse(b.finished!) - Date.parse(a.finished!))
        .slice(0, 8),
    [reads],
  );

  if (sessions.length === 0 && finished.length === 0) {
    return (
      <section className="h-full overflow-y-auto quiet-scroll" aria-label="Stats">
        <div className="mx-auto w-full max-w-4xl px-4 pt-16 sm:px-8">
          <EmptyState icon={ChartBarIcon} title="Nothing to count yet">
            {recording ? "Listen for a while and your time, your streaks and what you finished show up here. It is kept beside your books." : "Listening sessions are not being kept. Turn them on in Settings to see your time here."}
          </EmptyState>
        </div>
      </section>
    );
  }

  const sentence =
    t.weekMs > 0
      ? `You listened ${formatSpan(t.weekMs)} this week${t.todayMs > 0 ? `, ${formatSpan(t.todayMs)} of it today` : ""}.`
      : `Nothing this week yet. ${formatSpan(t.totalMs)} in all.`;

  const tiles = [
    { label: "This week", value: formatSpan(t.weekMs) },
    { label: "A day, lately", value: formatSpan(t.dailyAverageMs) },
    { label: "Streak", value: `${t.streakDays} ${t.streakDays === 1 ? "day" : "days"}`, note: t.longestStreakDays > t.streakDays ? `Longest ${t.longestStreakDays}` : undefined },
    { label: `Finished in ${new Date().getFullYear()}`, value: String(t.finishedThisYear) },
  ];
  const maxBook = books[0]?.ms ?? 1;

  return (
    <section className="h-full overflow-y-auto quiet-scroll" aria-label="Stats">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-4 pt-8 pb-16 sm:px-8">
        <div>
          <h1 className="border-l border-line-strong pl-3 text-xl font-semibold text-balance text-ink">{sentence}</h1>
          <div className="@container mt-6">
            <dl className="grid grid-cols-2 border-t border-line @2xl:grid-cols-4">
              {tiles.map((tile, i) => (
                <div key={tile.label} className={clsx("min-w-0 py-4", i % 2 === 1 ? "pl-5 max-@2xl:border-l max-@2xl:border-line" : "pr-5", i > 1 && "max-@2xl:border-t max-@2xl:border-line", "@2xl:px-5 @2xl:first:pl-0 @2xl:last:pr-0 @2xl:[&:not(:first-child)]:border-l @2xl:[&:not(:first-child)]:border-line")}>
                  <dt className="truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">{tile.label}</dt>
                  <dd className="mt-1 text-2xl font-semibold text-ink tabular-nums">{tile.value}</dd>
                  {tile.note && <dd className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">{tile.note}</dd>}
                </div>
              ))}
            </dl>
          </div>
        </div>

        <section aria-labelledby="stats-year" className="flex flex-col gap-4">
          <SectionHeader id="stats-year" title="The last year" description={`${formatSpan(t.totalMs)} over ${t.sessions.toLocaleString()} ${t.sessions === 1 ? "session" : "sessions"}. Each square is a day.`} />
          <div className="overflow-x-auto quiet-scroll pb-1">
            <div className="flex w-max gap-[3px]" role="img" aria-label="Listening time per day over the last year">
              {weeks.map((week, w) => (
                <div key={w} className="flex flex-col gap-[3px]">
                  {week.map((d) => (
                    <span
                      key={d.day}
                      title={`${new Date(d.day * 86_400_000 + new Date().getTimezoneOffset() * 60_000 + 43_200_000).toLocaleDateString(undefined, { dateStyle: "medium" })}: ${formatSpan(d.ms)}`}
                      className={clsx("size-2.5 rounded-[2px]", d.level === 0 ? "bg-raised ring-1 ring-line ring-inset" : d.level === 1 ? "bg-place/25" : d.level === 2 ? "bg-place/50" : d.level === 3 ? "bg-place/75" : "bg-place")}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-12 lg:grid-cols-2">
          {books.length > 0 && (
            <section aria-labelledby="stats-books" className="flex flex-col gap-4">
              <SectionHeader id="stats-books" title="Most listened" description="By time spent, all time." />
              <ol role="list" className="flex flex-col gap-1">
                {books.map((x) => {
                  const b = byId.get(x.key)!;
                  return (
                    <li key={x.key}>
                      <button type="button" onClick={() => c.openReader(x.key)} className="flex w-full items-center gap-3 rounded-md p-1.5 text-left focus-ring hover:bg-raised">
                        <Cover url={c.coverUrl(b)} title={b.book.title} className="size-10" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base/6 font-medium text-ink sm:text-sm/5">{b.book.title}</span>
                          <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-line-strong">
                            <span className="block h-full w-(--share) rounded-full bg-place" style={{ "--share": `${((x.ms / maxBook) * 100).toFixed(1)}%` } as React.CSSProperties} />
                          </span>
                        </span>
                        <span className="w-16 shrink-0 text-right text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">{formatSpan(x.ms)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {finished.length > 0 && (
            <section aria-labelledby="stats-finished" className="flex flex-col gap-4">
              <SectionHeader id="stats-finished" title="Finished lately" description={`${reads.filter((r) => r.finished).length} listen-throughs finished in all.`} />
              <ol role="list" className="flex flex-col gap-1">
                {finished.map((r) => {
                  const id = bookIdOf(r);
                  const b = id ? byId.get(id) : undefined;
                  if (!b) return null;
                  return (
                    <li key={r.id}>
                      <button type="button" onClick={() => c.openReader(b.book.id)} className="flex w-full items-center gap-3 rounded-md p-1.5 text-left focus-ring hover:bg-raised">
                        <Cover url={c.coverUrl(b)} title={b.book.title} className="size-10" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base/6 font-medium text-ink sm:text-sm/5">{b.book.title}</span>
                          <span className="block truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">{b.book.author}</span>
                        </span>
                        <time dateTime={r.finished} className="shrink-0 text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
                          {new Date(r.finished!).toLocaleDateString(undefined, { dateStyle: "medium" })}
                        </time>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {authors.length > 0 && <TimeList id="stats-authors" title="Authors" rows={authors} />}
          {narrators.length > 0 && <TimeList id="stats-narrators" title="Narrators" rows={narrators} />}
        </div>
      </div>
    </section>
  );
}

function TimeList({ id, title, rows }: { id: string; title: string; rows: { key: string; ms: number }[] }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <SectionHeader id={id} title={title} />
      <ol role="list" className="flex flex-col border-t border-line">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline justify-between gap-3 border-b border-line py-2.5">
            <span className="min-w-0 truncate text-base/6 text-ink sm:text-sm/5">{r.key}</span>
            <span className="shrink-0 text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">{formatSpan(r.ms)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
