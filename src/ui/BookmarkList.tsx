import { BookmarkIcon, BookOpenIcon, PauseIcon, PlayIcon, TrashIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { formatDuration } from "../core/speed";
import { useAppState, useController } from "./store";
import { IconButton } from "./Button";
import { EmptyState } from "./kit";

/** Bookmarks in the open book: where, the note or the words highlighted, the thirty seconds before it, the words in the text, and delete. */
export function BookmarkList() {
  const state = useAppState();
  const c = useController();
  const cur = state.current!;

  if (cur.bookmarks.length === 0) {
    return (
      <EmptyState icon={BookmarkIcon} title="No bookmarks yet">
        A bookmark keeps the thirty seconds before it and a note. Add one from the bottom of the player.
      </EmptyState>
    );
  }

  return (
    <ul role="list" className="flex flex-col">
      {cur.bookmarks.map((bm) => {
        const previewing = state.previewing === bm.offsetMs && state.player.playing;
        return (
          <li key={bm.id} className={clsx("group/row flex items-start gap-1 rounded-md", previewing && "bg-raised")}>
            <button type="button" onClick={() => c.seek(bm.offsetMs)} className="flex min-w-0 flex-1 items-baseline gap-3 rounded-md py-2 pr-2 pl-3 text-left focus-ring hover:bg-raised">
              <span className="w-14 shrink-0 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{formatDuration(bm.offsetMs)}</span>
              {bm.text ? (
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {bm.note && <span className="text-base/6 text-pretty text-ink sm:text-sm/5">{bm.note}</span>}
                  <span className={clsx("line-clamp-3 text-base/6 text-pretty sm:text-sm/5", bm.note ? "text-ink-2" : "text-ink")}>“{bm.text.quote.replace(/\s+/g, " ")}”</span>
                </span>
              ) : (
                <span className={clsx("min-w-0 flex-1 text-base/6 text-pretty sm:text-sm/5", bm.note ? "text-ink" : "text-ink-3")}>{bm.note || "No note"}</span>
              )}
            </button>
            <div className="flex shrink-0 py-1">
              <IconButton size="sm" label={previewing ? "Stop" : "Hear the thirty seconds before it"} icon={previewing ? PauseIcon : PlayIcon} aria-pressed={previewing} onClick={() => void c.previewBookmark(bm)} />
              {bm.text && <IconButton size="sm" label="Read it in the text" icon={BookOpenIcon} onClick={() => void c.readHighlight(bm.bookId, bm.id)} />}
              <IconButton size="sm" label="Delete the bookmark" icon={TrashIcon} onClick={() => void c.removeBookmark(bm.bookId, bm.id)} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
