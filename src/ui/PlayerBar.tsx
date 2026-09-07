import { BackwardIcon, ChevronUpIcon, ForwardIcon, ListBulletIcon, PauseIcon, PlayIcon } from "@heroicons/react/16/solid";
import { formatDuration, formatLeft, formatSpeed, remainingAtSpeed } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { Scrubber } from "./Scrubber";

/**
 * The player as a bar along the bottom: what is playing, the transport,
 * the chapter scrubber, speed and chapters. It stays while you browse;
 * the cover or the arrow opens the full player.
 */
export function PlayerBar() {
  const state = useAppState();
  const c = useController();
  const cur = state.current;
  if (!cur) return null;
  const { book } = cur;
  const p = state.player;
  const chapter = book.chapters[p.chapterIndex] ?? null;
  const start = chapter ? chapter.startMs : 0;
  const length = chapter ? chapter.endMs - chapter.startMs : p.durationMs;
  const inChapter = Math.min(length, Math.max(0, p.positionMs - start));
  const bookLeft = remainingAtSpeed(p.durationMs - p.positionMs, p.speed);

  return (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-4 border-t border-neutral-950/10 bg-white px-3 py-2 dark:border-white/10 dark:bg-neutral-900" role="region" aria-label="Now playing">
      <button
        type="button"
        onClick={() => c.expandPlayer()}
        className="-ml-1 flex min-w-0 items-center gap-3 rounded-lg p-1 text-left hover:bg-neutral-950/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:hover:bg-white/5"
        aria-label={`${book.book.title}. Open the player`}
      >
        <Cover url={c.coverUrl(book)} title={book.book.title} className="size-12" />
        <span className="min-w-0">
          <span className="block truncate text-sm/5 font-medium text-neutral-950 dark:text-white">{book.book.title}</span>
          <span className="block truncate text-xs/5 text-neutral-500 dark:text-neutral-400">
            {chapter ? `${chapter.title} · ` : ""}
            {formatLeft(bookLeft)} left in the book
          </span>
        </span>
      </button>

      <div className="flex min-w-0 flex-col items-center gap-1">
        <div className="flex items-center gap-1">
          <Button icon size="sm" variant="ghost" aria-label="Previous chapter" onClick={() => c.previousChapter()} disabled={book.chapters.length === 0}>
            <SkipIcon direction="back" />
          </Button>
          <Button icon size="sm" variant="ghost" aria-label="Back 30 seconds" onClick={() => c.skip(-30_000)}>
            <BackwardIcon className="size-4 fill-current" />
          </Button>
          <button
            type="button"
            onClick={() => c.togglePlay()}
            aria-label={p.playing ? "Pause" : "Play"}
            disabled={p.error !== null}
            className="flex size-10 items-center justify-center rounded-full bg-amber-500 text-neutral-950 hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 disabled:opacity-50 dark:bg-amber-400 dark:hover:bg-amber-300"
          >
            {p.playing ? <PauseIcon className="size-5 fill-current" /> : <PlayIcon className="size-5 translate-x-px fill-current" />}
          </button>
          <Button icon size="sm" variant="ghost" aria-label="Forward 30 seconds" onClick={() => c.skip(30_000)}>
            <ForwardIcon className="size-4 fill-current" />
          </Button>
          <Button icon size="sm" variant="ghost" aria-label="Next chapter" onClick={() => c.nextChapter()} disabled={book.chapters.length === 0}>
            <SkipIcon direction="forward" />
          </Button>
        </div>
        <div className="grid w-full max-w-xl grid-cols-[3rem_1fr_3rem] items-center gap-2 text-xs/4 text-neutral-500 tabular-nums dark:text-neutral-400">
          <span>{formatDuration(inChapter)}</span>
          <Scrubber positionMs={inChapter} durationMs={length} chapters={[]} onSeek={(ms) => c.seek(start + ms)} label={chapter ? "Position in chapter" : "Position in book"} />
          <span className="text-right">-{formatDuration(remainingAtSpeed(length - inChapter, p.speed))}</span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => c.expandPlayer("speed")} className="tabular-nums">
          {formatSpeed(p.speed)}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => c.expandPlayer("chapters")} className="max-sm:hidden">
          <ListBulletIcon className="size-4 fill-current" />
          Chapters
        </Button>
        <Button icon size="sm" variant="ghost" aria-label="Open the player" onClick={() => c.expandPlayer()}>
          <ChevronUpIcon className="size-4 fill-current" />
        </Button>
      </div>
    </div>
  );
}

/** Skip-to-chapter glyph: a bar and a triangle, mirrored for back. */
export function SkipIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg viewBox="0 0 16 16" className={direction === "back" ? "size-4 -scale-x-100 fill-current" : "size-4 fill-current"} aria-hidden="true">
      <path d="M3 3.5a1 1 0 0 1 1.6-.8l6 4.5a1 1 0 0 1 0 1.6l-6 4.5A1 1 0 0 1 3 12.5v-9Z" />
      <path d="M12 3a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}
