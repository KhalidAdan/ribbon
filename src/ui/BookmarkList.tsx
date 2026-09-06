import { PauseIcon, PlayIcon, TrashIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { formatDuration } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";

export function BookmarkList() {
  const state = useAppState();
  const c = useController();
  const cur = state.current!;

  if (cur.bookmarks.length === 0) {
    return <p className="py-4 text-base/7 text-neutral-500 sm:text-sm/6 dark:text-neutral-400">No bookmarks yet. A bookmark keeps the last thirty seconds of audio and a note.</p>;
  }

  return (
    <ul role="list" className="divide-y divide-neutral-950/5 dark:divide-white/5">
      {cur.bookmarks.map((bm) => {
        const previewing = state.previewing === bm.offsetMs && state.player.playing;
        return (
          <li key={bm.offsetMs} className={clsx("flex items-start gap-2 py-2", previewing && "text-neutral-950 dark:text-white")}>
            <button
              type="button"
              onClick={() => c.seek(bm.offsetMs)}
              className="flex min-w-0 flex-1 items-baseline gap-3 rounded-md px-2 py-1 text-left hover:bg-neutral-950/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:hover:bg-white/5"
            >
              <span className="w-14 shrink-0 text-sm/6 text-neutral-500 tabular-nums dark:text-neutral-400">{formatDuration(bm.offsetMs)}</span>
              <span className="min-w-0 flex-1 text-base/6 text-pretty text-neutral-950 sm:text-sm/6 dark:text-white">{bm.note || <span className="text-neutral-400 dark:text-neutral-500">No note</span>}</span>
            </button>
            <Button
              icon
              size="sm"
              variant="ghost"
              aria-label={previewing ? "Stop" : "Play the thirty seconds before this bookmark"}
              aria-pressed={previewing}
              onClick={() => void c.previewBookmark(bm)}
            >
              {previewing ? <PauseIcon className="size-4 fill-current" /> : <PlayIcon className="size-4 fill-current" />}
            </Button>
            <Button icon size="sm" variant="ghost" aria-label="Delete bookmark" onClick={() => void c.removeBookmark(bm.offsetMs)}>
              <TrashIcon className="size-4 fill-current" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
