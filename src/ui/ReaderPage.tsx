import { BookOpenIcon, BookmarkIcon, PlayIcon } from "@heroicons/react/16/solid";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { orderBySeries, hiddenBookIds, seriesNumber } from "../core/series";
import { NEUTRAL_TONE, type Tone } from "../core/tint";
import { formatLeft } from "../core/speed";
import { chapterAt } from "../core/scan/chapters";
import { partAt } from "../core/scan/parts";
import { useAppState, useController, useCovers } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Dialog } from "./Dialog";
import { ReadHistory } from "./ReadHistory";
import { tintFromImage } from "./tint";
import { progressOf as progressIn, useShelfProgress } from "./progress";
import { readerOnly } from "../core/ebook";
import { Badge, Menu, ProgressLine, SectionHeader, Short } from "./kit";
import { formatBytes } from "./Servers";
import { SeriesBooks } from "./SeriesPage";

/**
 * One book's page: the cover, the title in the book's own serif, where
 * you are as a sentence, what you can do, the facts, the description,
 * and the rest of its series as a list. A faint wash of the cover's
 * colour sits behind the top. Up and down move through the series;
 * Escape goes back to the library.
 */
export function ReaderPage() {
  // How far along comes from useShelfProgress: by the minute while the book plays.
  const state = useAppState((s) => ({ books: s.books, readerBookId: s.readerBookId, sources: s.sources, series: s.series, current: s.current, about: s.about, lookupEnabled: s.lookup.enabled, download: s.readerBookId ? s.downloads[s.readerBookId] : undefined }));
  const shelf = useShelfProgress();
  useCovers();
  const c = useController();
  const reading = (id: string) => c.readingProgress(id);
  const book = state.books.find((b) => b.book.id === state.readerBookId) ?? null;
  const [tone, setTone] = useState<Tone>(NEUTRAL_TONE);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const me = progressIn(book, shelf, reading);
  const index = orderedIds.indexOf(book.book.id);
  const numbers = orderedIds.map((id, i) => seriesNumber(record, id, i + 1, series?.numbers));
  // "Book 4 of 10" while the numbers are the positions; "Book 9" when the series has gaps or a book in parts.
  const counted = numbers.every((n, i) => n === String(i + 1));
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
  const isCurrent = state.current?.book.book.id === book.book.id;
  // A book that is only its EPUB: read, never played.
  const toRead = readerOnly(book.book);
  const left = book.book.durationMs - me.posMs;
  // A server's book: downloaded before it plays or opens, and removable from this device after. Its admin can delete it from the server.
  const fromServer = !!state.sources.find((s) => s.id === book.source)?.server;
  const remote = book.remote;
  const download = state.download;
  const where = story ? `story ${storyNow + 1} of ${stories.length}, ${story.title}` : book.chapters.length > 1 ? `chapter ${chapterNow + 1} of ${book.chapters.length}` : null;
  const sentence = hidden.has(book.book.id)
    ? "Left off the shelf for this series. It is still here when you want it."
    : download
      ? `Downloading, ${formatBytes(download.done)} of ${formatBytes(download.total)}. It opens when it's here.`
      : remote && !me.started
        ? `On the server. ${toRead ? "It downloads before it opens" : `${formatLeft(book.book.durationMs)}; it downloads (${formatBytes(book.book.sizeBytes)}) before it plays`}.`
        : toRead
      ? me.finished
        ? "Finished. Read it again any time."
        : me.started
          ? `You are ${Math.max(1, Math.floor(me.fraction * 100))}% through.`
          : "Not started. An EPUB to read; there is no audio for it."
      : me.finished
        ? "Finished. Listen again any time; your place starts over."
        : me.started
          ? `You are ${Math.max(1, Math.floor(me.fraction * 100))}% through${where ? `, in ${where}` : ""}. ${formatLeft(left)} left.`
          : `Not started. ${formatLeft(book.book.durationMs)}${book.chapters.length > 1 ? ` in ${book.chapters.length} chapters` : ""}.`;

  const seriesProgress = shelfIds.map((id) => {
    const b = byId.get(id);
    return b ? progressIn(b, shelf, reading) : null;
  });
  const seriesFinished = seriesProgress.filter((p) => p?.finished).length;
  const seriesLeft = shelfIds.reduce((s, id, i) => {
    const b = byId.get(id);
    const p = seriesProgress[i];
    return b && p && !p.finished ? s + b.book.durationMs - p.posMs : s;
  }, 0);

  const facts: { term: string; value: string }[] = [
    ...(toRead ? [] : [{ term: "Length", value: formatLeft(book.book.durationMs) }]),
    // A server's book has its chapters read once it's here.
    ...(toRead || book.remote ? [] : [stories.length > 0 ? { term: "Stories", value: String(stories.length) } : { term: "Chapters", value: String(book.chapters.length) }]),
    ...(book.book.year ? [{ term: "Year", value: String(book.book.year) }] : []),
    ...(book.book.publisher ? [{ term: "Publisher", value: book.book.publisher }] : []),
    ...(book.book.language ? [{ term: "Language", value: languageName(book.book.language) }] : []),
    ...(book.book.ebook ? [{ term: "Ebook", value: "EPUB" }] : []),
    ...(toRead || book.remote ? [] : [{ term: book.files.length === 1 ? "File" : "Files", value: book.files.length === 1 ? (book.files[0]!.path.split(".").pop() ?? "").toUpperCase() : String(book.files.length) }]),
    ...(book.remote && !toRead ? [{ term: "Download", value: formatBytes(book.book.sizeBytes) }] : []),
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
                <button type="button" onClick={() => c.openSeries(series.key)} className="rounded-sm text-left focus-ring hover:text-ink">
                  {series.name} · Book {numbers[index]}
                  {counted && ` of ${orderedIds.length}`}
                </button>
              </p>
            )}
            <h1 className="mt-1 font-serif text-[2rem]/[1.15] font-semibold tracking-tight text-balance text-ink sm:text-[2.25rem]/[1.15]">{(index >= 0 && series?.titles?.[book.book.id]) || book.book.title}</h1>
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
            {download ? <ProgressLine fraction={download.total > 0 ? download.done / download.total : 0} className="mt-4 max-w-sm" /> : me.started && !me.finished && <ProgressLine fraction={me.fraction} className="mt-4 max-w-sm" />}

            {/* On a phone, one row: listening and reading share it under short names (the sentence above says how far in), and the bookmarks are the player's. */}
            <div className="mt-6 flex flex-wrap items-center gap-2">
              {!toRead && (
                <Button variant="primary" leading={PlayIcon} disabled={!!download} onClick={() => void (me.finished ? c.listenAgain(book.book.id) : c.playBook(book))} className="max-sm:flex-1">
                  {me.finished ? "Listen again" : <Short phone="Listen">{me.started ? "Continue listening" : "Start listening"}</Short>}
                </Button>
              )}
              {book.book.ebook && (
                <Button variant={toRead ? "primary" : "secondary"} leading={BookOpenIcon} disabled={!!download} onClick={() => void c.openReading(book.book.id)} className="max-sm:flex-1">
                  {(c.readingProgress(book.book.id) ?? 0) > 0 ? <Short phone="Read">Continue reading</Short> : "Read"}
                </Button>
              )}
              {isCurrent && state.current && state.current.bookmarks.length > 0 && (
                <Button variant="ghost" leading={BookmarkIcon} onClick={() => c.expandPlayer("bookmarks")} className="max-sm:hidden">
                  {state.current.bookmarks.length} {state.current.bookmarks.length === 1 ? "bookmark" : "bookmarks"}
                </Button>
              )}
              <Menu
                label="More about this book"
                title={book.book.title}
                align="left"
                items={[
                  me.finished ? { label: "Mark as not finished", onSelect: () => void c.markUnfinished(book.book.id) } : { label: "Mark as finished", onSelect: () => void c.markFinished(book.book.id) },
                  ...(me.started && !me.finished && !toRead ? [{ label: "Start again from the beginning", onSelect: () => void c.listenAgain(book.book.id) }] : []),
                  { label: "Edit details and cover…", onSelect: () => c.openEditBook(book.book.id) },
                  ...(next ? [{ label: `Open the next book, ${next.book.title}`, onSelect: () => c.openReader(next.book.id) }] : []),
                  ...(series ? [{ label: "Change the series…", onSelect: () => c.openSeriesSetup(series.key) }] : [{ label: "Make a series…", onSelect: () => c.openNewSeries() }]),
                  ...(fromServer && !remote ? [{ label: `Remove from ${c.here} (${formatBytes(book.book.sizeBytes)})`, onSelect: () => void c.removeDownload(book.book.id), danger: true }] : []),
                  ...(c.canDeleteFromServer(book.book.id) ? [{ label: "Delete from the server…", onSelect: () => setConfirmDelete(true), danger: true }] : []),
                ]}
              />
              <Dialog
                open={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                labelId="delete-from-server-title"
                title={`Delete ${book.book.title} from the server?`}
                description="It goes from the server and from every device that downloaded it. Everyone’s places in it are kept, and the folder it came from isn’t touched."
                actions={
                  <>
                    <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        setConfirmDelete(false);
                        void c.deleteFromServer(book.book.id);
                      }}
                    >
                      Delete
                    </Button>
                  </>
                }
              >
                {/* Nothing more to say than the description: room before the footer. */}
                <div className="h-5 shrink-0" />
              </Dialog>
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
                  No description yet.{state.lookupEnabled ? " Ribbon is asking Open Library about your books in the background." : " Turn on descriptions in Settings and Ribbon will ask Open Library."}
                </p>
              )}
            </div>
            <ReadHistory book={book} />
          </div>
        </div>

        {series && (
          <section aria-labelledby="series-list-title" className="mt-16 flex flex-col gap-4">
            <SectionHeader
              id="series-list-title"
              title={series.name}
              description={`${seriesFinished} of ${shelfIds.length} finished${seriesLeft > 0 ? `, ${formatLeft(seriesLeft).replace(/ \d+m$/, "")} still to hear` : ""}. Use the up and down arrows to move through it.`}
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={() => c.openSeries(series.key)}>
                    Open the series
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => c.openSeriesSetup(series.key)}>
                    Change the series…
                  </Button>
                </>
              }
            />
            <SeriesBooks group={series} record={record} ids={orderedIds} hidden={hidden} place={{ id: book.book.id, kind: "page" }} label={`The books in ${series.name}`} />
          </section>
        )}
      </div>

    </section>
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
