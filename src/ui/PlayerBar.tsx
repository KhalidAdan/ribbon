import { BackwardIcon, ChevronUpIcon, ForwardIcon, ListBulletIcon, MoonIcon, PauseIcon, PlayIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { memo } from "react";
import { formatDuration, formatLeft, formatSpeed, remainingAtSpeed } from "../core/speed";
import { useAppState, useController, useCovers } from "./store";
import { Button, IconButton } from "./Button";
import { Cover } from "./Cover";
import { Scrubber } from "./Scrubber";

/**
 * The player as a bar along the bottom: what is playing and where, the
 * transport over the chapter's scrubber, and speed, sleep and chapters.
 * It stays while you browse; the book or the arrow opens the full player.
 */
export function PlayerBar() {
  // The one part of the shell that follows the player tick by tick.
  const state = useAppState((s) => ({ current: s.current, player: s.player, sleep: s.sleep }));
  useCovers();
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
  const sleeping = state.sleep.state.mode !== null;
  const status = p.reconnecting ? "Reconnecting…" : p.error ? p.error : p.buffering ? "Loading…" : null;

  return (
    <div className="shrink-0 border-t border-line bg-surface" role="region" aria-label="Now playing">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)] sm:gap-6 sm:px-4">
        <button type="button" onClick={() => c.expandPlayer()} className="-m-1 flex min-w-0 items-center gap-3 rounded-md p-1 text-left focus-ring" aria-label={`${book.book.title}. Open the player`}>
          <Cover url={c.coverUrl(book)} title={book.book.title} className="size-11" />
          <span className="min-w-0">
            <span className="block truncate text-base/6 font-medium text-ink sm:text-sm/5">{book.book.title}</span>
            <span className={clsx("block truncate text-sm/5 tabular-nums sm:text-[0.8125rem]/5", status ? "text-ink-2" : "text-ink-3")}>
              {status ?? `${chapter && book.chapters.length > 1 ? `${chapter.title} · ` : ""}${formatLeft(bookLeft)} left`}
            </span>
          </span>
        </button>

        <div className="flex min-w-0 flex-col items-center gap-1 max-sm:hidden">
          <Transport size="sm" />
          <div className="grid w-full max-w-lg grid-cols-[3.25rem_1fr_3.25rem] items-center gap-2 text-[0.75rem]/4 text-ink-3 tabular-nums">
            <span>{formatDuration(inChapter)}</span>
            <Scrubber positionMs={inChapter} durationMs={length} chapters={[]} onSeek={(ms) => c.seek(start + ms)} label={chapter ? "Position in chapter" : "Position in book"} />
            <span className="text-right">-{formatDuration(remainingAtSpeed(length - inChapter, p.speed))}</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-0.5">
          <div className="sm:hidden">
            <PlayButton size="sm" />
          </div>
          <Button size="sm" variant="ghost" onClick={() => c.expandPlayer("speed")} className="tabular-nums max-sm:hidden" aria-label={`Speed ${formatSpeed(p.speed)}`}>
            {formatSpeed(p.speed)}
          </Button>
          {sleeping && (
            <Button size="sm" variant="ghost" leading={MoonIcon} onClick={() => c.expandPlayer()} className="tabular-nums max-md:hidden" aria-label="Sleep timer">
              {state.sleep.state.mode?.kind === "chapter" ? "Chapter" : state.sleep.remainingMs !== null ? formatDuration(state.sleep.remainingMs) : "On"}
            </Button>
          )}
          <IconButton size="sm" label="Chapters" icon={ListBulletIcon} onClick={() => c.expandPlayer("chapters")} className="max-sm:hidden" />
          <IconButton size="sm" label="Open the player" icon={ChevronUpIcon} onClick={() => c.expandPlayer()} />
        </div>
      </div>
    </div>
  );
}

/** Previous chapter, back 30, play, forward 30, next chapter. */
export const Transport = memo(function Transport({ size }: { size: "sm" | "md" }) {
  const book = useAppState((s) => s.current?.book);
  const c = useController();
  if (!book) return null;
  const s = size === "md" ? "md" : "sm";
  return (
    <div className={clsx("flex items-center", size === "md" ? "gap-3" : "gap-1")}>
      <IconButton size={s} label="Previous chapter" icon={SkipBack} onClick={() => c.previousChapter()} disabled={book.chapters.length === 0} />
      <IconButton size={s} label="Back 30 seconds" icon={BackwardIcon} onClick={() => c.skip(-30_000)} />
      <PlayButton size={size} />
      <IconButton size={s} label="Forward 30 seconds" icon={ForwardIcon} onClick={() => c.skip(30_000)} />
      <IconButton size={s} label="Next chapter" icon={SkipForward} onClick={() => c.nextChapter()} disabled={book.chapters.length === 0} />
    </div>
  );
});

/** The one primary control: inverted ink, round. Pause while reconnecting, because the listener still wants to hear it. xs sits in the reader's capsule. */
export const PlayButton = memo(function PlayButton({ size }: { size: "xs" | "sm" | "md" }) {
  const on = useAppState((s) => s.player.playing || s.player.reconnecting);
  const c = useController();
  return (
    <button
      type="button"
      onClick={() => c.togglePlay()}
      aria-label={on ? "Pause" : "Play"}
      className={clsx("relative flex shrink-0 items-center justify-center rounded-full bg-primary text-on-primary focus-ring hover:bg-primary/85", size === "md" ? "size-14" : size === "sm" ? "size-9" : "size-[30px]")}
    >
      <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />
      {on ? <PauseIcon className={clsx(size === "xs" ? "size-3" : "size-4", "fill-current")} aria-hidden="true" /> : <PlayIcon className={clsx(size === "xs" ? "size-3" : "size-4", "translate-x-px fill-current")} aria-hidden="true" />}
    </button>
  );
});

/** Skip-to-chapter glyphs: a triangle and a bar, mirrored for back. */
function SkipForward(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" {...props}>
      <path d="M3 3.5a1 1 0 0 1 1.6-.8l6 4.5a1 1 0 0 1 0 1.6l-6 4.5A1 1 0 0 1 3 12.5v-9Z" />
      <path d="M12 3a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function SkipBack(props: React.SVGProps<SVGSVGElement>) {
  return <SkipForward {...props} className={clsx(props.className, "-scale-x-100")} />;
}

export { SkipForward, SkipBack };
