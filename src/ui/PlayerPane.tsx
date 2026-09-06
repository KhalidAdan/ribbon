import { BackwardIcon, BookmarkIcon, ChevronLeftIcon, ForwardIcon, PauseIcon, PlayIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useState } from "react";
import { formatDuration, remainingAtSpeed } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Scrubber } from "./Scrubber";
import { SpeedControl } from "./SpeedControl";
import { SleepControl } from "./SleepControl";
import { ChapterList } from "./ChapterList";
import { BookmarkList } from "./BookmarkList";
import { ResumeOffer } from "./ResumeOffer";

export function PlayerPane() {
  const state = useAppState();
  const c = useController();
  const cur = state.current;
  const [tab, setTab] = useState<"chapters" | "bookmarks">("chapters");
  const [noteOpen, setNoteOpen] = useState(false);

  if (!cur) {
    return (
      <section className="flex h-full items-center justify-center px-6" aria-label="Player">
        <p className="max-w-[40ch] text-center text-base/7 text-pretty text-neutral-500 sm:text-sm/6 dark:text-neutral-400">Choose a book from your library to start listening.</p>
      </section>
    );
  }

  const { book } = cur;
  const p = state.player;
  const chapter = book.chapters[p.chapterIndex] ?? null;
  const remaining = remainingAtSpeed(p.durationMs - p.positionMs, p.speed);
  const chapterRemaining = chapter ? remainingAtSpeed(chapter.endMs - p.positionMs, p.speed) : 0;

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Player">
      <div className="flex items-center gap-2 px-3 pt-3 lg:hidden">
        <Button icon size="sm" variant="ghost" aria-label="Back to library" onClick={() => c.showLibrary()}>
          <ChevronLeftIcon className="size-4 fill-current" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm/6 text-neutral-500 dark:text-neutral-400">Library</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-6 pb-8 sm:px-8">
          <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-end">
            <Cover url={c.coverUrl(book)} title={book.book.title} className="w-48 sm:w-40 lg:w-48" />
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <h2 className="text-2xl font-semibold tracking-tight text-balance text-neutral-950 dark:text-white">{book.book.title}</h2>
              <p className="mt-1 text-base/6 text-neutral-600 sm:text-sm/6 dark:text-neutral-400">
                {book.book.author || "Unknown author"}
                {book.book.narrator ? ` · read by ${book.book.narrator}` : ""}
              </p>
              {chapter && (
                <p className="mt-3 truncate text-base/6 text-neutral-950 sm:text-sm/6 dark:text-white">
                  {chapter.title}
                  <span className="text-neutral-500 tabular-nums dark:text-neutral-400"> · {formatDuration(chapterRemaining)} left in chapter</span>
                </p>
              )}
            </div>
          </div>

          {state.resumeOffer && <ResumeOffer />}

          <div>
            <Scrubber positionMs={p.positionMs} durationMs={p.durationMs} chapters={book.chapters} onSeek={(ms) => c.seek(ms)} />
            <div className="mt-2 flex justify-between text-sm/5 text-neutral-500 tabular-nums dark:text-neutral-400">
              <span>{formatDuration(p.positionMs)}</span>
              <span>
                {p.speed !== 1 ? `${formatDuration(remaining)} left at ${p.speed}×` : `${formatDuration(remaining)} left`}
                {p.skippingGap ? " · skipping silence" : ""}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-3 sm:gap-4">
            <Button icon variant="ghost" aria-label="Back 30 seconds" onClick={() => c.skip(-30_000)}>
              <BackwardIcon className="size-4 fill-current" />
            </Button>
            <button
              type="button"
              onClick={() => c.togglePlay()}
              aria-label={p.playing ? "Pause" : "Play"}
              disabled={p.error !== null}
              className={clsx(
                "flex size-16 items-center justify-center rounded-full bg-amber-500 text-neutral-950 hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 disabled:opacity-50 dark:bg-amber-400 dark:hover:bg-amber-300",
              )}
            >
              {p.playing ? <PauseIcon className="size-6 fill-current" /> : <PlayIcon className="size-6 translate-x-px fill-current" />}
            </button>
            <Button icon variant="ghost" aria-label="Forward 30 seconds" onClick={() => c.skip(30_000)}>
              <ForwardIcon className="size-4 fill-current" />
            </Button>
          </div>

          {p.error && <p className="text-center text-sm/6 text-red-600 dark:text-red-400">{p.error}.</p>}
          {p.buffering && !p.error && <p className="text-center text-sm/6 text-neutral-500 dark:text-neutral-400">Loading…</p>}

          <div className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-neutral-950/10 pt-5 sm:grid-cols-[1fr_auto] dark:border-white/10">
            <SpeedControl />
            <div className="flex items-start justify-end gap-2">
              <Button size="sm" onClick={() => setNoteOpen((v) => !v)} aria-expanded={noteOpen} className="py-1.5 pr-2.5 pl-1.5">
                <BookmarkIcon className="size-4 fill-current" />
                Bookmark
              </Button>
            </div>
          </div>
          {noteOpen && <BookmarkNote onDone={() => setNoteOpen(false)} />}
          <SleepControl />

          <div>
            <div className="flex gap-1 border-b border-neutral-950/10 dark:border-white/10" role="tablist">
              {(["chapters", "bookmarks"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={clsx(
                    "-mb-px border-b-2 px-2 py-2 text-base/6 sm:text-sm/6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
                    tab === t ? "border-amber-500 text-neutral-950 dark:text-white" : "border-transparent text-neutral-500 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white",
                  )}
                >
                  {t === "chapters" ? `Chapters (${book.chapters.length})` : `Bookmarks (${cur.bookmarks.length})`}
                </button>
              ))}
            </div>
            <div className="pt-3">{tab === "chapters" ? <ChapterList /> : <BookmarkList />}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function BookmarkNote({ onDone }: { onDone: () => void }) {
  const c = useController();
  const state = useAppState();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        void c.addBookmark(note.trim()).finally(() => {
          setSaving(false);
          onDone();
        });
      }}
    >
      <label htmlFor="bookmark-note" className="sr-only">
        Bookmark note
      </label>
      <input
        id="bookmark-note"
        name="note"
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={`Note at ${formatDuration(state.player.positionMs)}`}
        className="min-w-0 flex-1 rounded-md bg-white px-3 py-2 text-base/6 text-neutral-950 ring-1 ring-neutral-950/10 placeholder:text-neutral-400 focus:outline-2 focus:-outline-offset-1 focus:outline-amber-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:ring-white/10"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save bookmark"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
