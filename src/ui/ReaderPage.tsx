import { ArrowLeftIcon, ArrowUpRightIcon, Cog6ToothIcon, PlayIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { orderBySeries, hiddenBookIds } from "../core/series";
import { NEUTRAL_TONE, type Tone } from "../core/tint";
import { formatDuration, formatLeft } from "../core/speed";
import { chapterAt } from "../core/scan/chapters";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Drawer } from "./Drawer";
import { tintFromImage } from "./tint";

/** A book is finished when the saved position is within a minute of its end. */
const FINISHED_WITHIN_MS = 60_000;

/**
 * One book, as a page in its own colours: a rail of every book in its
 * series on the left, the cover with pride of place, then the title,
 * author, a few facts, the description when there is one, and what you
 * can do next. Up and down move through the series; Escape goes back.
 */
export function ReaderPage() {
  const state = useAppState();
  const c = useController();
  const book = state.books.find((b) => b.book.id === state.readerBookId) ?? null;
  const [tone, setTone] = useState<Tone>(NEUTRAL_TONE);
  const [drawer, setDrawer] = useState<"chapters" | null>(null);

  const series = useMemo(() => (book ? c.detectedSeries().find((g) => g.bookIds.includes(book.book.id)) ?? null : null), [c, book, state.books, state.root]);
  const record = series ? state.series[series.key] : undefined;
  const orderedIds = useMemo(() => (series ? orderBySeries(series.bookIds, (id) => id, record ? [record] : []) : []), [series, record]);
  const hidden = useMemo(() => hiddenBookIds(record ? [record] : []), [record]);
  const byId = useMemo(() => new Map(state.books.map((b) => [b.book.id, b])), [state.books]);

  const coverUrl = book ? c.coverUrl(book) : null;
  useEffect(() => {
    let live = true;
    if (!coverUrl) {
      setTone(NEUTRAL_TONE);
      return;
    }
    void tintFromImage(coverUrl).then((t) => live && setTone(t ?? NEUTRAL_TONE));
    return () => {
      live = false;
    };
  }, [coverUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") c.showLibrary();
      if (!book || orderedIds.length === 0) return;
      const i = orderedIds.indexOf(book.book.id);
      if (e.key === "ArrowDown" && i >= 0 && i + 1 < orderedIds.length) c.openReader(orderedIds[i + 1]!);
      if (e.key === "ArrowUp" && i > 0) c.openReader(orderedIds[i - 1]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c, book, orderedIds]);

  if (!book) return null;

  const progressOf = (b: ScannedBook) => {
    const active = state.current?.book.book.id === b.book.id;
    const pos = active ? state.player.positionMs : (state.positions[b.book.id]?.offsetMs ?? 0);
    const within = Math.min(FINISHED_WITHIN_MS, b.book.durationMs * 0.1);
    return { pos, finished: pos > 0 && b.book.durationMs > 0 && pos >= b.book.durationMs - within, started: pos > 0 };
  };
  const me = progressOf(book);
  const index = orderedIds.indexOf(book.book.id);
  const nextId = index >= 0 ? orderedIds.slice(index + 1).find((id) => !hidden.has(id)) : undefined;
  const next = nextId ? byId.get(nextId) : undefined;
  const about = c.aboutFor(book);
  const chapterNow = chapterAt(book.chapters, me.pos);
  const status = hidden.has(book.book.id) ? "Left off the shelf" : me.finished ? "Finished" : me.started ? `Up to chapter ${chapterNow + 1}` : "Not started";
  const isCurrent = state.current?.book.book.id === book.book.id;
  const seriesLeft = series ? orderedIds.filter((id) => !hidden.has(id)).reduce((s, id) => {
    const b = byId.get(id);
    if (!b) return s;
    const p = progressOf(b);
    return s + (p.finished ? 0 : b.book.durationMs - p.pos);
  }, 0) : 0;
  const finishedCount = series ? orderedIds.filter((id) => !hidden.has(id) && byId.get(id) && progressOf(byId.get(id)!).finished).length : 0;

  const vars = { "--pb": tone.bg, "--pb2": tone.bg2, "--pi": tone.ink, "--pm": tone.muted, "--pl": tone.line, "--pa": tone.accent } as CSSProperties;

  return (
    <section className="grid h-full grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)] overflow-hidden bg-(--pb) font-serif text-(--pi) transition-colors duration-500 max-lg:grid-cols-[4.5rem_1fr]" style={vars} aria-label={book.book.title}>
      <nav className="relative flex flex-col pt-5 pl-7 max-lg:pl-5" aria-label={series ? `Books in ${series.name}` : "Back"}>
        <Button icon size="sm" variant="ghost" aria-label="Back to the library" onClick={() => c.showLibrary()} className="mb-6 text-(--pi) hover:bg-white/10 hover:text-(--pi)">
          <ArrowLeftIcon className="size-5 fill-current" />
        </Button>
        {series && (
          <div className="group/rail flex w-60 flex-col gap-1.5" role="list">
            {orderedIds.map((id) => {
              const b = byId.get(id);
              if (!b) return null;
              const p = progressOf(b);
              const now = id === book.book.id;
              const off = hidden.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="listitem"
                  onClick={() => c.openReader(id)}
                  aria-current={now ? "true" : undefined}
                  aria-label={`${b.book.title}${now ? ", this book" : ""}${p.finished ? ", finished" : ""}`}
                  className="group/notch flex h-2 w-60 items-center gap-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--pa)"
                >
                  <i
                    className={clsx(
                      "block h-0.5 rounded-[1px] bg-(--pi) transition-[width,opacity] duration-300 ease-out group-hover/notch:bg-(--pa) group-hover/notch:opacity-100",
                      now ? "h-[3px] w-8 bg-(--pa) opacity-100 group-hover/rail:w-[4.5rem]" : p.finished ? "w-6 opacity-70 group-hover/rail:w-14" : off ? "w-2.5 opacity-25 group-hover/rail:w-14" : "w-4 opacity-35 group-hover/rail:w-14",
                    )}
                  />
                  <span className="pointer-events-none translate-x-[-6px] text-[15px]/none font-medium whitespace-nowrap text-(--pa) opacity-0 transition-[opacity,transform] duration-150 group-hover/notch:translate-x-0 group-hover/notch:opacity-100 group-focus-visible/notch:translate-x-0 group-focus-visible/notch:opacity-100">
                    {b.book.title}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-auto flex flex-col gap-2 pb-5 opacity-80">
          {series && (
            <Button icon size="sm" variant="ghost" aria-label="Change this series" onClick={() => c.openSeriesSetup(series.key)} className="text-(--pi) hover:bg-white/10 hover:text-(--pi)">
              <Cog6ToothIcon className="size-4 fill-current" />
            </Button>
          )}
        </div>
      </nav>

      <div className="grid place-items-center py-10 pr-6 max-lg:hidden">
        <Cover url={coverUrl} title={book.book.title} className="w-[min(460px,82%)] rounded-[4px] bg-(--pb2) text-(--pm) outline-0" />
      </div>

      <div className="max-w-[620px] overflow-y-auto px-6 pt-24 pb-12 lg:pl-6 lg:pr-16 max-lg:pt-10">
        <h1 className="text-[34px]/[1.15] font-semibold tracking-[-0.01em] text-balance">{book.book.title}</h1>
        <p className="mt-1.5 text-[21px]/7 italic">
          {book.book.author || "Author unknown"}
          {book.book.narrator ? `, read by ${book.book.narrator}` : ""}
        </p>
        <div className="mt-5 mb-6 flex flex-wrap gap-2">
          <Tag emphasis={me.started && !me.finished}>{status}</Tag>
          {series && index >= 0 && <Tag>Book {index + 1} of {orderedIds.length}</Tag>}
          <Tag>{formatLeft(book.book.durationMs)}</Tag>
          <Tag>{book.chapters.length} chapters</Tag>
        </div>
        {about ? (
          <p className="mb-3.5 max-w-[34rem] text-[17.5px]/[1.55] text-pretty whitespace-pre-line">{about.description}</p>
        ) : (
          <p className="mb-3.5 max-w-[34rem] text-[15px]/6 italic text-(--pm)">
            No description yet.{state.lookup.enabled ? " Ribbon is asking Open Library about your books in the background." : " Turn on descriptions in settings and Ribbon will ask Open Library."}
          </p>
        )}
        {series && (
          <p className="mb-3.5 max-w-[34rem] text-[15px]/6 italic text-(--pm)">
            {series.name} · {finishedCount} of {orderedIds.length - hidden.size} finished · {formatLeft(seriesLeft).replace(/ \d+m$/, "")} still to hear.
          </p>
        )}
        <div className="mt-8 max-w-[34rem] border border-(--pl)">
          <Action onClick={() => void c.playBook(book)} label={me.finished ? "Listen again" : me.started ? "Continue listening" : "Start listening"} detail={me.started && !me.finished ? `Chapter ${chapterNow + 1} · ${formatLeft(book.book.durationMs - me.pos)} left` : formatDuration(book.book.durationMs)} icon={<PlayIcon className="size-3 fill-current" />} />
          <Action onClick={() => setDrawer("chapters")} label="Chapters" detail={String(book.chapters.length)} />
          {isCurrent && state.current && <Action onClick={() => c.expandPlayer("bookmarks")} label="Bookmarks" detail={String(state.current.bookmarks.length)} />}
          {next && <Action onClick={() => c.openReader(next.book.id)} label="Next in the series" detail={next.book.title} />}
        </div>
        {series && <p className="mt-8 text-xs text-(--pm) font-sans">↑ ↓ move through the series · Esc back to the library</p>}
      </div>

      <Drawer open={drawer === "chapters"} onClose={() => setDrawer(null)} title={`Chapters · ${book.book.title}`}>
        <ol className="divide-y divide-neutral-950/5 dark:divide-white/5">
          {book.chapters.map((ch, i) => (
            <li key={i} className={clsx("grid grid-cols-[3.5rem_1fr_auto] gap-3 py-2 text-sm/6", i === chapterNow && me.started && "font-medium text-neutral-950 dark:text-white")}>
              <span className="text-neutral-500 tabular-nums dark:text-neutral-400">{formatDuration(ch.startMs)}</span>
              <span className="truncate">{ch.title}</span>
              <span className="text-neutral-500 tabular-nums dark:text-neutral-400">{formatDuration(ch.endMs - ch.startMs)}</span>
            </li>
          ))}
        </ol>
      </Drawer>
    </section>
  );
}

function Tag({ children, emphasis = false }: { children: React.ReactNode; emphasis?: boolean }) {
  return <span className={clsx("rounded-[3px] border px-2.5 py-1.5 text-[13px]/4", emphasis ? "border-(--pa) text-(--pa)" : "border-(--pl) text-(--pi)")}>{children}</span>;
}

function Action({ onClick, label, detail, icon }: { onClick: () => void; label: string; detail: string; icon?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="grid w-full grid-cols-[1fr_auto_2.5rem] items-center gap-3 border-b border-(--pl) py-2.5 pl-4 text-left text-[16px]/6 font-medium last:border-b-0 hover:bg-white/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--pa)">
      <span>{label}</span>
      <span className="text-[15px]/6 font-normal text-(--pm)">{detail}</span>
      <span className="grid h-full place-items-center border-l border-(--pl) text-(--pi)">{icon ?? <ArrowUpRightIcon className="size-3 fill-current" />}</span>
    </button>
  );
}
