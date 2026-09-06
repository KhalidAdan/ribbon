import { CheckIcon, PencilSquareIcon, ScissorsIcon, TrashIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useState } from "react";
import { formatDuration } from "../core/speed";
import type { Correction } from "../core/scan/chapters";
import { useAppState, useController } from "./store";
import { Button } from "./Button";

export function ChapterList() {
  const state = useAppState();
  const c = useController();
  const cur = state.current!;
  const chapters = cur.book.chapters;
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const apply = (extra: Correction) => void c.correctChapters([...cur.corrections, extra]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm/6 text-neutral-500 dark:text-neutral-400">
          {cur.corrections.length > 0 ? `${cur.corrections.length} hand ${cur.corrections.length === 1 ? "correction" : "corrections"}` : chapters.length > cur.book.files.length ? "From the file's markers" : cur.book.files.length > 1 ? "One per file" : "Whole book"}
        </p>
        <div className="flex gap-1">
          {editing && cur.corrections.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void c.correctChapters([])}>
              Reset
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)} aria-pressed={editing} className="py-1.5 pr-2.5 pl-1.5">
            {editing ? <CheckIcon className="size-4 fill-current" /> : <PencilSquareIcon className="size-4 fill-current" />}
            {editing ? "Done" : "Edit"}
          </Button>
        </div>
      </div>
      {editing && (
        <div className="mb-2">
          <Button size="sm" onClick={() => apply({ op: "insert", startMs: state.player.positionMs, title: "" })} className="py-1.5 pr-2.5 pl-1.5">
            <ScissorsIcon className="size-4 fill-current" />
            Split chapter here ({formatDuration(state.player.positionMs)})
          </Button>
        </div>
      )}
      <ol role="list" className="divide-y divide-neutral-950/5 dark:divide-white/5">
        {chapters.map((ch, i) => {
          const active = i === state.player.chapterIndex;
          return (
            <li key={`${ch.startMs}-${i}`} className={clsx("flex items-center gap-2", active && "text-neutral-950 dark:text-white")}>
              {renaming === i ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.trim()) apply({ op: "rename", index: i, title: draft.trim() });
                    setRenaming(null);
                  }}
                >
                  <label htmlFor={`chapter-title-${i}`} className="sr-only">
                    Chapter title
                  </label>
                  <input
                    id={`chapter-title-${i}`}
                    name="title"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-w-0 flex-1 rounded-md bg-white px-2 py-1 text-base/6 text-neutral-950 ring-1 ring-neutral-950/10 focus:outline-2 focus:-outline-offset-1 focus:outline-amber-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:ring-white/10"
                  />
                  <Button type="submit" icon size="sm" variant="ghost" aria-label="Save title">
                    <CheckIcon className="size-4 fill-current" />
                  </Button>
                  <Button icon size="sm" variant="ghost" aria-label="Cancel" onClick={() => setRenaming(null)}>
                    <XMarkIcon className="size-4 fill-current" />
                  </Button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => c.goToChapter(i)}
                  aria-current={active ? "true" : undefined}
                  className={clsx(
                    "flex min-w-0 flex-1 items-baseline gap-3 rounded-md px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
                    active ? "bg-neutral-950/5 dark:bg-white/10" : "hover:bg-neutral-950/5 dark:hover:bg-white/5",
                  )}
                >
                  <span className="w-14 shrink-0 text-sm/6 text-neutral-500 tabular-nums dark:text-neutral-400">{formatDuration(ch.startMs)}</span>
                  <span className={clsx("min-w-0 flex-1 truncate text-base/6 sm:text-sm/6", active ? "font-medium" : "text-neutral-700 dark:text-neutral-300")}>{ch.title}</span>
                  <span className="shrink-0 text-sm/6 text-neutral-400 tabular-nums dark:text-neutral-500">{formatDuration(ch.endMs - ch.startMs)}</span>
                </button>
              )}
              {editing && renaming !== i && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    icon
                    size="sm"
                    variant="ghost"
                    aria-label={`Rename ${ch.title}`}
                    onClick={() => {
                      setDraft(ch.title);
                      setRenaming(i);
                    }}
                  >
                    <PencilSquareIcon className="size-4 fill-current" />
                  </Button>
                  <Button icon size="sm" variant="ghost" aria-label={`Merge ${ch.title} into the previous chapter`} disabled={i === 0} onClick={() => apply({ op: "delete", index: i })}>
                    <TrashIcon className="size-4 fill-current" />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
