import { BookmarkIcon, CheckIcon, ListBulletIcon, PlayIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { orderBySeries, hiddenBookIds } from "../core/series";
import { NEUTRAL_TONE, type Tone } from "../core/tint";
import { formatDuration, formatLeft } from "../core/speed";
import { chapterAt } from "../core/scan/chapters";
import { groupByPart, partAt } from "../core/scan/parts";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Drawer } from "./Drawer";
import { tintFromImage } from "./tint";
import { progressOf as progressIn } from "./progress";
import { Badge, Menu, ProgressLine, SectionHeader } from "./kit";

/**
 * One book's page: the cover, the title in the book's own serif, where
 * you are as a sentence, what you can do, the facts, the description,
 * and the rest of its series as a list. A faint wash of the cover's
 * colour sits behind the top. Up and down move through the series;
 * Escape goes back to the library.
 */
export function ReaderPage() {
  const state = useAppState();
  const c = useController();
  const book = state.books.find((b) => b.book.id === state.readerBookId) ?? null;
  const [tone, setTone] = useState<Tone>(NEUTRAL_TONE);
  const [drawer, setDrawer] = useState<"chapters" | null>(null);

  const series = useMemo(() => (book ? (c.detectedSeries().find((g) => g.bookIds.includes(book.book.id)) ?? null) : null), [c, book, state.books, state.sources, state.series]);
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
      if (e.key === "ArrowDown" && i >= 0 && i + 1 < orderedIds.length) {
        e.preventDefault();
        c.openReader(orderedIds[i + 1]!);
      }
      if (e.key === "ArrowUp" && i > 0) {
        e.preventDefault();
        c.openReader(orderedIds[i - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c, book, orderedIds]);

  if (!book) return null;

  const me = progressIn(book, state);
  const index = orderedIds.indexOf(book.book.id);
  const shelfIds = orderedIds.filter((id) => !hidden.has(id));
  const nextId = index >= 0 ? orderedIds.slice(index + 1).find((id) => !hidden.has(id)) : undefined;
  const next = nextId ? byId.get(nextId) : undefined;
  // What the files say about the book comes first; Open Library only fills a gap.
  const about = c.aboutFor(book);
  const description = book.book.description || about?.description || "";
  const chapterNow = chapterAt(book.chapters, me.posMs);
  // An anthology counts in stories where a novel counts in chapters.
  const stories = book.parts;
  const storyNow = partAt(stories, me.posMs);
  const story = stories[storyNow] ?? null;
  const contents = groupByPart(book.chapters, stories);
  const isCurrent = state.current?.book.book.id === book.book.id;
  const left = book.book.durationMs - me.posMs;
  const where = story ? `story ${storyNow + 1} of ${stories.length}, ${story.title}` : book.chapters.length > 1 ? `chapter ${chapterNow + 1} of ${book.chapters.length}` : null;
  const sentence = hidden.has(book.book.id)
    ? "Left off the shelf for this series. It is still here when you want it."
    : me.finished
      ? "Finished. Listen again any time; your place starts over."
      : me.started
        ? `You are ${Math.max(1, Math.floor(me.fraction * 100))}% through${where ? `, in ${where}` : ""}. ${formatLeft(left)} left.`
        : `Not started. ${formatLeft(book.book.durationMs)}${book.chapters.length > 1 ? ` in ${book.chapters.length} chapters` : ""}.`;

  const seriesProgress = shelfIds.map((id) => {
    const b = byId.get(id);
    return b ? progressIn(b, state) : null;
  });
  const seriesFinished = seriesProgress.filter((p) => p?.finished).length;
  const seriesLeft = shelfIds.reduce((s, id, i) => {
    const b = byId.get(id);
    const p = seriesProgress[i];
    return b && p && !p.finished ? s + b.book.durationMs - p.posMs : s;
  }, 0);

  const facts: { term: string; value: string }[] = [
    { term: "Length", value: formatLeft(book.book.durationMs) },
    stories.length > 0 ? { term: "Stories", value: String(stories.length) } : { term: "Chapters", value: String(book.chapters.length) },
    ...(book.book.year ? [{ term: "Year", value: String(book.book.year) }] : []),
    ...(book.book.publisher ? [{ term: "Publisher", value: book.book.publisher }] : []),
    ...(book.book.language ? [{ term: "Language", value: languageName(book.book.language) }] : []),
    { term: book.files.length === 1 ? "File" : "Files", value: book.files.length === 1 ? (book.files[0]!.path.split(".").pop() ?? "").toUpperCase() : String(book.files.length) },
  ];

  const wash = { "--tone": tone.accent } as CSSProperties;

  return (
    <section className="relative h-full overflow-y-auto quiet-scroll" style={wash} aria-label={book.book.title}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[32rem] [background:radial-gradient(70%_100%_at_20%_0%,color-mix(in_oklab,var(--tone)_16%,transparent),transparent)] dark:[background:radial-gradient(70%_100%_at_20%_0%,color-mix(in_oklab,var(--tone)_12%,transparent),transparent)]" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-5xl px-4 pt-8 pb-16 sm:px-8 sm:pt-12">
        <div className="grid gap-8 md:grid-cols-[16rem_minmax(0,1fr)] md:gap-12 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <Cover url={coverUrl} title={book.book.title} className="w-48 self-start sm:w-56 md:w-full" />
          <div className="min-w-0">
            {series && index >= 0 && (
              <p className="text-base/6 text-ink-2 sm:text-sm/5">
                {series.name} · Book {index + 1} of {orderedIds.length}
              </p>
            )}
            <h1 className="mt-1 font-serif text-[2rem]/[1.15] font-semibold tracking-tight text-balance text-ink sm:text-[2.25rem]/[1.15]">{book.book.title}</h1>
            {book.book.subtitle && <p className="mt-1 font-serif text-xl/7 text-pretty text-ink-2">{book.book.subtitle}</p>}
            <p className="mt-2 text-base/6 text-ink-2">
              {book.book.author || "Author unknown"}
              {book.book.narrator ? `, read by ${book.book.narrator}` : ""}
            </p>

            {book.book.genres && book.book.genres.length > 0 && (
              <ul role="list" className="mt-4 flex flex-wrap gap-1.5" aria-label="Genres">
                {book.book.genres.slice(0, 6).map((g) => (
                  <li key={g}>
                    <Badge>{g}</Badge>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-6 max-w-[52ch] border-l border-line-strong pl-3 text-base/6 text-pretty text-ink tabular-nums sm:text-[0.9375rem]/6">{sentence}</p>
            {me.started && !me.finished && <ProgressLine fraction={me.fraction} className="mt-4 max-w-sm" />}

            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Button variant="primary" leading={PlayIcon} onClick={() => void c.playBook(book)}>
                {me.finished ? "Listen again" : me.started ? "Continue listening" : "Start listening"}
              </Button>
              <Button leading={ListBulletIcon} onClick={() => setDrawer("chapters")}>
                {stories.length > 0 ? "Contents" : "Chapters"}
              </Button>
              {isCurrent && state.current && state.current.bookmarks.length > 0 && (
                <Button variant="ghost" leading={BookmarkIcon} onClick={() => c.expandPlayer("bookmarks")}>
                  {state.current.bookmarks.length} {state.current.bookmarks.length === 1 ? "bookmark" : "bookmarks"}
                </Button>
              )}
              <Menu
                label="More about this book"
                title={book.book.title}
                align="left"
                items={[
                  { label: "Edit details and cover…", onSelect: () => c.openEditBook(book.book.id) },
                  ...(next ? [{ label: `Open the next book, ${next.book.title}`, onSelect: () => c.openReader(next.book.id) }] : []),
                  ...(series ? [{ label: "Change the series…", onSelect: () => c.openSeriesSetup(series.key) }] : [{ label: "Make a series…", onSelect: () => c.openNewSeries() }]),
                ]}
              />
            </div>

            <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 sm:grid-cols-4">
              {facts.map((f) => (
                <div key={f.term} className="min-w-0">
                  <dt className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">{f.term}</dt>
                  <dd className="mt-0.5 truncate text-base/6 font-medium text-ink tabular-nums sm:text-sm/5">{f.value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-8">
              {description ? (
                <p className="max-w-[65ch] text-base/7 text-pretty whitespace-pre-line text-ink-2 sm:text-[0.9375rem]/7">{description}</p>
              ) : (
                <p className="max-w-[60ch] text-base/6 text-pretty text-ink-3 sm:text-sm/6">
                  No description yet.{state.lookup.enabled ? " Ribbon is asking Open Library about your books in the background." : " Turn on descriptions in Settings and Ribbon will ask Open Library."}
                </p>
              )}
            </div>
          </div>
        </div>

        {series && (
          <section aria-labelledby="series-list-title" className="mt-16 flex flex-col gap-4">
            <SectionHeader
              id="series-list-title"
              title={series.name}
              description={`${seriesFinished} of ${shelfIds.length} finished${seriesLeft > 0 ? `, ${formatLeft(seriesLeft).replace(/ \d+m$/, "")} still to hear` : ""}. Use the up and down arrows to move through it.`}
              actions={
                <Button size="sm" variant="ghost" onClick={() => c.openSeriesSetup(series.key)}>
                  Change the series…
                </Button>
              }
            />
            <ol role="list" className="flex flex-col border-t border-line">
              {orderedIds.map((id, i) => {
                const b = byId.get(id);
                if (!b) return null;
                return <SeriesRow key={id} book={b} number={i + 1} now={id === book.book.id} off={hidden.has(id)} />;
              })}
            </ol>
          </section>
        )}
      </div>

      <Drawer open={drawer === "chapters"} onClose={() => setDrawer(null)} title={stories.length > 0 ? "Contents" : "Chapters"}>
        <div className={clsx(stories.length > 0 && "flex flex-col gap-5")}>
          {contents.map((g) => {
            const storyIndex = g.part ? stories.indexOf(g.part) : -1;
            const done = me.finished || (storyIndex >= 0 && storyIndex < storyNow);
            const author = g.part && g.part.author && g.part.author !== book.book.author ? g.part.author : "";
            return (
              <section key={g.part ? g.part.title + storyIndex : "chapters"} aria-label={g.part?.title}>
                {g.part && (
                  <div className="mb-1 flex items-baseline gap-3 px-3 py-1">
                    <div className="min-w-0 flex-1">
                      <p className={clsx("truncate text-base/6 font-semibold sm:text-sm/5", storyIndex === storyNow && me.started && !me.finished ? "text-place" : "text-ink")}>{g.part.title}</p>
                      {author && <p className="truncate text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">{author}</p>}
                    </div>
                    <p className="flex shrink-0 items-center gap-1 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">
                      {done && <CheckIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />}
                      {done ? "Finished" : formatLeft(g.part.endMs - g.part.startMs)}
                    </p>
                  </div>
                )}
                <ol role="list" className="flex flex-col">
                  {g.chapters.map(({ chapter: ch, index: i }) => {
                    const here = i === chapterNow && me.started && !me.finished;
                    return (
                      <li key={i} className={clsx("relative grid grid-cols-[3.5rem_1fr_auto] gap-3 rounded-md py-2 pr-2 pl-3 text-base/6 sm:text-sm/5", here && "bg-raised")}>
                        {here && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-place" aria-hidden="true" />}
                        <span className="text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{formatDuration(ch.startMs)}</span>
                        <span className={clsx("truncate", here ? "font-medium text-ink" : "text-ink-2")}>{ch.title}</span>
                        <span className="text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{formatDuration(ch.endMs - ch.startMs)}</span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      </Drawer>
    </section>
  );
}

/** One book in the series list: its number, cover, title, and how it stands. */
function SeriesRow({ book, number, now, off }: { book: ScannedBook; number: number; now: boolean; off: boolean }) {
  const state = useAppState();
  const c = useController();
  const p = progressIn(book, state);
  const standing = off ? "Left off the shelf" : p.finished ? "Finished" : p.started ? `${Math.max(1, Math.floor(p.fraction * 100))}% · ${formatLeft(book.book.durationMs - p.posMs)} left` : formatLeft(book.book.durationMs);
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={() => c.openReader(book.book.id)}
        aria-current={now ? "page" : undefined}
        className={clsx("relative grid w-full grid-cols-[2rem_2.5rem_minmax(0,1fr)_auto] items-center gap-3 py-2 pr-2 pl-3 text-left focus-ring sm:grid-cols-[2rem_2.5rem_minmax(0,1fr)_auto]", now ? "bg-raised" : "hover:bg-raised", off && "opacity-50")}
      >
        {now && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-place" aria-hidden="true" />}
        <span className="text-right text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{number}</span>
        <Cover url={c.coverUrl(book)} title={book.book.title} className="w-10" />
        <span className="min-w-0">
          <span className={clsx("block truncate text-base/6 sm:text-sm/5", now ? "font-medium text-ink" : "text-ink")}>{book.book.title}</span>
          <span className="block truncate text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">{book.book.author}</span>
        </span>
        <span className="flex items-center gap-1.5 text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
          {p.finished && !off && <CheckIcon className="size-4 shrink-0 fill-ink-3" aria-hidden="true" />}
          {standing}
        </span>
      </button>
    </li>
  );
}

/** "en", "eng" or "English" as a name people read. */
function languageName(code: string): string {
  const c = code.trim();
  if (c.length > 3) return c;
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(c.length === 3 ? (ISO3[c.toLowerCase()] ?? c) : c) ?? c;
  } catch {
    return c;
  }
}

/** The three-letter codes audiobook tags use most, to their two-letter forms. */
const ISO3: Record<string, string> = { eng: "en", deu: "de", ger: "de", fra: "fr", fre: "fr", spa: "es", ita: "it", jpn: "ja", nld: "nl", dut: "nl", por: "pt", rus: "ru", pol: "pl", swe: "sv", nor: "no", dan: "da", fin: "fi", zho: "zh", chi: "zh" };
