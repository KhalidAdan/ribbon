import { BookmarkIcon, ChevronDownIcon, MinusIcon, PlusIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useState } from "react";
import { SPEED_STEP, formatDuration, formatLeft, formatSpeed, remainingAtSpeed } from "../core/speed";
import { partAt } from "../core/scan/parts";
import { useAppState, useController } from "./store";
import { Button, IconButton } from "./Button";
import { Cover } from "./Cover";
import { Drawer } from "./Drawer";
import { Scrubber } from "./Scrubber";
import { SpeedControl } from "./SpeedControl";
import { SleepControl } from "./SleepControl";
import { ChapterList } from "./ChapterList";
import { BookmarkList } from "./BookmarkList";
import { ResumeOffer } from "./ResumeOffer";
import { Transport } from "./PlayerBar";
import { Group, Row, Toggle } from "./kit";

/**
 * The full player, a canvas of its own: where you are as a sentence, the
 * book in the middle, the transport over the chapter's scrubber, and what
 * you can change about listening in grouped rows below. The footer says
 * where your place is kept.
 */
export function PlayerPane() {
  const state = useAppState();
  const c = useController();
  const cur = state.current;
  const drawer = state.playerDrawer;
  const setDrawer = (d: typeof drawer) => c.setPlayerDrawer(d);
  const [noteOpen, setNoteOpen] = useState(false);
  const [moreAbout, setMoreAbout] = useState(false);

  if (!cur) {
    return (
      <section className="flex h-full items-center justify-center px-6" aria-label="Player">
        <p className="max-w-[40ch] text-center text-base/6 text-pretty text-ink-2 sm:text-sm/5">Choose a book from your library to start listening.</p>
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
  const storyIndex = partAt(book.parts, p.positionMs);
  const story = book.parts[storyIndex] ?? null;
  const percent = p.durationMs > 0 ? Math.floor((p.positionMs / p.durationMs) * 100) : 0;
  const where = story ? `Story ${storyIndex + 1} of ${book.parts.length}` : chapter && book.chapters.length > 1 ? `Chapter ${p.chapterIndex + 1} of ${book.chapters.length}` : null;
  const sentence = `${where ? `${where}, ` : ""}${percent}% through, ${formatLeft(bookLeft)} left${p.speed !== 1 ? ` at ${formatSpeed(p.speed)}` : ""}.`;
  const status = p.error ?? (p.reconnecting ? "Reconnecting to the file…" : p.buffering ? "Loading…" : p.skippingGap ? "Shortening a pause" : null);

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Player">
      <header className="flex shrink-0 items-start gap-3 px-3 pt-3 sm:px-5 sm:pt-4">
        <IconButton label="Back to the shelf" icon={ChevronDownIcon} onClick={() => c.collapsePlayer()} />
        <div className="min-w-0 flex-1 pt-1">
          <p className="truncate text-[0.8125rem]/5 text-ink-3">
            <button type="button" onClick={() => c.collapsePlayer()} className="rounded-sm focus-ring hover:text-ink">
              Library
            </button>
            <span aria-hidden="true"> › </span>
            <span className="text-ink-2">{book.book.title}</span>
          </p>
          <h1 tabIndex={-1} data-autofocus className="mt-1.5 border-l border-line-strong pl-3 text-base/6 font-normal text-ink tabular-nums outline-none sm:text-[0.9375rem]/6">{sentence}</h1>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto quiet-scroll">
        <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 pt-8 pb-12">
          <div className="flex flex-col items-center gap-5 text-center">
            <Cover url={c.coverUrl(book)} title={book.book.title} className="w-56 sm:w-64" />
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-balance text-ink">{book.book.title}</h2>
              <p className="mt-1 text-base/6 text-ink-2 sm:text-sm/5">
                {book.book.author || "Unknown author"}
                {book.book.narrator ? `, read by ${book.book.narrator}` : ""}
              </p>
            </div>
          </div>

          {state.resumeOffer && <ResumeOffer />}

          <div className="flex flex-col gap-5">
            <div>
              {chapter && (
                <button type="button" onClick={() => setDrawer("chapters")} className="mb-2 flex w-full items-baseline gap-2 rounded-md text-left focus-ring" aria-label={`${story ? `${story.title}. ` : ""}${chapter.title}. Open the chapter list`}>
                  <span className="min-w-0 flex-1 truncate text-base/6 font-medium text-ink hover:underline hover:underline-offset-2 sm:text-sm/5">{story && story.title !== chapter.title ? `${story.title} · ${chapter.title}` : chapter.title}</span>
                  <span className="shrink-0 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">-{formatDuration(chapterLeft)}</span>
                </button>
              )}
              <Scrubber positionMs={inChapter} durationMs={scrubLength} chapters={[]} onSeek={(ms) => c.seek(scrubStart + ms)} label={chapter ? "Position in chapter" : "Position in book"} />
              <div className="mt-1.5 flex justify-between text-[0.75rem]/4 text-ink-3 tabular-nums">
                <span>{formatDuration(inChapter)}</span>
                <span>{formatDuration(scrubLength)}</span>
              </div>
            </div>
            <div className="flex justify-center">
              <Transport size="md" />
            </div>
            <p className={clsx("-mt-1 h-5 text-center text-sm/5 sm:text-[0.8125rem]/5", p.error ? "text-ink" : "text-ink-3")} role="status" aria-live="polite">
              {status}
            </p>
          </div>

          <Group label="Listening">
            <Row
              title="Speed"
              description={p.speed !== 1 ? `Kept for this book. ${formatLeft(bookLeft)} left at this speed.` : "Kept for this book."}
              aside={
                <span className="flex items-center gap-1">
                  <IconButton size="sm" label="Slower" icon={MinusIcon} onClick={() => void c.setSpeed(p.speed - SPEED_STEP)} />
                  <button type="button" onClick={() => setDrawer("speed")} className="w-12 rounded-md py-0.5 text-center font-medium text-ink tabular-nums focus-ring hover:bg-line" aria-label={`Speed ${formatSpeed(p.speed)}. More speeds`}>
                    {formatSpeed(p.speed)}
                  </button>
                  <IconButton size="sm" label="Faster" icon={PlusIcon} onClick={() => void c.setSpeed(p.speed + SPEED_STEP)} />
                </span>
              }
            />
            <Row title="Trim silences" description="Shortens pauses longer than a second to about half a second." aside={<Toggle label="Trim silences" checked={cur.settings.trimSilence} onChange={(on) => void c.setTrimSilence(on)} />} />
            <div className="rounded-md bg-raised px-3 py-2.5">
              <SleepControl />
            </div>
          </Group>

          <Group label="This book">
            <Row title="Chapters" aside={book.chapters.length > 1 && chapter ? `${p.chapterIndex + 1} of ${book.chapters.length}` : String(book.chapters.length)} onClick={() => setDrawer("chapters")} />
            <Row title="Bookmarks" aside={String(cur.bookmarks.length)} onClick={() => setDrawer("bookmarks")} />
            {about && (
              <div className="rounded-md bg-raised px-3 py-2.5">
                <p className="text-base/6 font-medium text-ink sm:text-sm/5">About</p>
                <p className={clsx("mt-1 text-base/6 text-pretty whitespace-pre-line text-ink-2 sm:text-sm/6", !moreAbout && "line-clamp-4")}>{about.description}</p>
                <button type="button" onClick={() => setMoreAbout((v) => !v)} className="mt-1 rounded-sm text-sm/5 text-ink-3 focus-ring hover:text-ink sm:text-[0.8125rem]/5">
                  {moreAbout ? "Less" : "More"}
                </button>
              </div>
            )}
          </Group>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-4 py-3 sm:px-5">
        <PlaceKept />
        {noteOpen ? (
          <BookmarkNote onDone={() => setNoteOpen(false)} />
        ) : (
          <Button size="sm" leading={BookmarkIcon} onClick={() => setNoteOpen(true)}>
            Add a bookmark
          </Button>
        )}
      </footer>

      <Drawer open={drawer === "speed"} onClose={() => setDrawer(null)} title="Speed">
        <SpeedControl />
      </Drawer>
      <Drawer open={drawer === "chapters" || drawer === "bookmarks"} onClose={() => setDrawer(null)} title={drawer === "bookmarks" ? "Bookmarks" : "Chapters"}>
        <div className="mb-3 flex gap-5 border-b border-line" role="tablist">
          {(["chapters", "bookmarks"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={drawer === t}
              onClick={() => setDrawer(t)}
              className={clsx("-mb-px border-b py-2 text-base/6 focus-ring sm:text-sm/5", drawer === t ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink")}
            >
              {t === "chapters" ? "Chapters" : "Bookmarks"} <span className="text-ink-3 tabular-nums">{t === "chapters" ? book.chapters.length : cur.bookmarks.length}</span>
            </button>
          ))}
        </div>
        {drawer === "bookmarks" ? <BookmarkList /> : <ChapterList />}
      </Drawer>
    </section>
  );
}

/** Where the listener's place is kept, in a sentence. */
function PlaceKept() {
  const state = useAppState();
  const kept = state.placeKept;
  const text =
    kept === null
      ? "Your place is saved as you listen."
      : kept.pendingShare > 0
        ? kept.shareFailing
          ? "Your place is saved on this machine. The folder is out of reach; it gets the place when it is back."
          : "Your place is saved on this machine and is on its way to the folder."
        : kept.local
          ? "Your place is saved on this machine and beside the book."
          : "Your place is saved beside the book.";
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2 text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
      <span className={clsx("size-1.5 shrink-0 rounded-full", kept && kept.pendingShare > 0 && kept.shareFailing ? "bg-ink-3" : "bg-place")} aria-hidden="true" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

function BookmarkNote({ onDone }: { onDone: () => void }) {
  const c = useController();
  const state = useAppState();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="flex w-full items-center gap-2 sm:w-auto"
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
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
        placeholder={`A note at ${formatDuration(state.player.positionMs)}`}
        className="min-w-0 flex-1 rounded-md bg-raised px-2.5 py-1 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:w-64 sm:text-[0.8125rem]/[1.125rem]"
      />
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}
