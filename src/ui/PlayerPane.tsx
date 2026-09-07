import { BackwardIcon, BookmarkIcon, ChevronLeftIcon, ForwardIcon, ListBulletIcon, PauseIcon, PlayIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useState } from "react";
import { formatDuration, formatLeft, formatSpeed, remainingAtSpeed } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Drawer } from "./Drawer";
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
  const [drawer, setDrawer] = useState<"chapters" | "bookmarks" | "speed" | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [moreAbout, setMoreAbout] = useState(false);

  if (!cur) {
    return (
      <section className="flex h-full items-center justify-center px-6" aria-label="Player">
        <p className="max-w-[40ch] text-center text-base/7 text-pretty text-neutral-500 sm:text-sm/6 dark:text-neutral-400">Choose a book from your library to start listening.</p>
      </section>
    );
  }

  const { book } = cur;
  const p = state.player;
  const about = c.aboutFor(book);
  const chapter = book.chapters[p.chapterIndex] ?? null;
  const bookLeft = remainingAtSpeed(p.durationMs - p.positionMs, p.speed);
  // The timeline is the current chapter. Books run ten hours and more;
  // a whole-book bar gives seconds per pixel and makes seeking a lottery.
  const scrubStart = chapter ? chapter.startMs : 0;
  const scrubLength = chapter ? chapter.endMs - chapter.startMs : p.durationMs;
  const inChapter = Math.min(scrubLength, Math.max(0, p.positionMs - scrubStart));
  const chapterLeft = remainingAtSpeed(scrubLength - inChapter, p.speed);
  const chapterNumber = chapter ? `${p.chapterIndex + 1} of ${book.chapters.length}` : "";

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
            </div>
          </div>
          {about && (
            <div>
              <p className={clsx("text-base/7 text-pretty whitespace-pre-line text-neutral-700 sm:text-sm/6 dark:text-neutral-300", !moreAbout && "line-clamp-4")}>{about.description}</p>
              <button type="button" onClick={() => setMoreAbout((v) => !v)} className="mt-1 text-sm/6 text-neutral-500 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:text-neutral-400">
                {moreAbout ? "Less" : "More"}
              </button>
            </div>
          )}

          {state.resumeOffer && <ResumeOffer />}

          <div>
            {chapter && (
              <button
                type="button"
                onClick={() => setDrawer("chapters")}
                className="mb-2 flex w-full items-baseline justify-center gap-2 rounded-md px-2 py-1 text-center hover:bg-neutral-950/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 sm:justify-start sm:text-left dark:hover:bg-white/5"
                aria-label={`Chapter ${chapterNumber}: ${chapter.title}. Open the chapter list`}
              >
                <span className="min-w-0 truncate text-base/6 font-medium text-neutral-950 sm:text-sm/6 dark:text-white">{chapter.title}</span>
                <span className="shrink-0 text-sm/5 text-neutral-500 tabular-nums dark:text-neutral-400">{chapterNumber}</span>
              </button>
            )}
            <Scrubber positionMs={inChapter} durationMs={scrubLength} chapters={[]} onSeek={(ms) => c.seek(scrubStart + ms)} label={chapter ? "Position in chapter" : "Position in book"} />
            <div className="mt-2 grid grid-cols-3 text-sm/5 text-neutral-500 tabular-nums dark:text-neutral-400">
              <span>{formatDuration(inChapter)}</span>
              <span className="text-center">
                {formatLeft(bookLeft)} left{p.speed !== 1 ? ` at ${p.speed}×` : ""}
                {p.skippingGap ? " · skipping silence" : ""}
              </span>
              <span className="text-right">-{formatDuration(chapterLeft)}</span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 sm:gap-3">
            <Button icon variant="ghost" aria-label="Previous chapter" onClick={() => c.previousChapter()} disabled={book.chapters.length === 0}>
              <SkipIcon direction="back" />
            </Button>
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
            <Button icon variant="ghost" aria-label="Next chapter" onClick={() => c.nextChapter()} disabled={book.chapters.length === 0}>
              <SkipIcon direction="forward" />
            </Button>
          </div>

          {p.error && <p className="text-center text-sm/6 text-red-600 dark:text-red-400">{p.error}.</p>}
          {p.buffering && !p.error && <p className="text-center text-sm/6 text-neutral-500 dark:text-neutral-400">Loading…</p>}

          <div className="grid grid-cols-3 gap-2 border-t border-neutral-950/10 pt-5 dark:border-white/10">
            <div className="flex justify-start">
              <Button variant="ghost" onClick={() => setDrawer("speed")} className="flex-col gap-0.5 px-3 py-1.5" aria-haspopup="dialog">
                <span className="text-base/5 font-semibold tabular-nums">{formatSpeed(p.speed)}</span>
                <span className="text-xs/4">Speed</span>
              </Button>
            </div>
            <div className="flex justify-center">
              <Button variant="ghost" onClick={() => setDrawer("chapters")} className="flex-col gap-0.5 px-3 py-1.5" aria-haspopup="dialog">
                <ListBulletIcon className="size-5 fill-current" />
                <span className="text-xs/4">Chapters</span>
              </Button>
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setNoteOpen((v) => !v)} aria-expanded={noteOpen} className="flex-col gap-0.5 px-3 py-1.5">
                <BookmarkIcon className="size-5 fill-current" />
                <span className="text-xs/4">Bookmark</span>
              </Button>
            </div>
          </div>
          {noteOpen && <BookmarkNote onDone={() => setNoteOpen(false)} />}
          <SleepControl />
        </div>
      </div>

      <Drawer open={drawer === "speed"} onClose={() => setDrawer(null)} title="Speed">
        <div className="py-2">
          <SpeedControl />
        </div>
      </Drawer>
      <Drawer open={drawer === "chapters" || drawer === "bookmarks"} onClose={() => setDrawer(null)} title={drawer === "bookmarks" ? "Bookmarks" : "Chapters"}>
        <div className="mb-3 flex gap-1 border-b border-neutral-950/10 dark:border-white/10" role="tablist">
          {(["chapters", "bookmarks"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={drawer === t}
              onClick={() => setDrawer(t)}
              className={clsx(
                "-mb-px border-b-2 px-2 py-2 text-base/6 sm:text-sm/6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
                drawer === t ? "border-amber-500 text-neutral-950 dark:text-white" : "border-transparent text-neutral-500 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white",
              )}
            >
              {t === "chapters" ? `Chapters (${book.chapters.length})` : `Bookmarks (${cur.bookmarks.length})`}
            </button>
          ))}
        </div>
        {drawer === "bookmarks" ? <BookmarkList /> : <ChapterList />}
      </Drawer>
    </section>
  );
}

/** Skip-to-chapter glyph: a bar and a triangle, mirrored for back. */
function SkipIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg viewBox="0 0 16 16" className={clsx("size-4 fill-current", direction === "back" && "-scale-x-100")} aria-hidden="true">
      <path d="M3 3.5a1 1 0 0 1 1.6-.8l6 4.5a1 1 0 0 1 0 1.6l-6 4.5A1 1 0 0 1 3 12.5v-9Z" />
      <path d="M12 3a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Z" />
    </svg>
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
