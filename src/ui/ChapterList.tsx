import { CheckIcon, PencilSquareIcon, ScissorsIcon, TrashIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useState } from "react";
import { formatDuration, formatLeft } from "../core/speed";
import type { Correction } from "../core/scan/chapters";
import { groupByPart, partAt } from "../core/scan/parts";
import type { Part } from "../core/types";
import { useAppState, useController } from "./store";
import { progressOf } from "./progress";
import { Button } from "./Button";

/**
 * The chapters of the open book, and for an anthology, its stories with
 * their chapters beneath each. A story's heading jumps to its start and
 * says whether it is done; a chapter row jumps to the chapter. Editing
 * works on chapters alone: the stories are the folders on disk.
 */
export function ChapterList() {
  const state = useAppState();
  const c = useController();
  const cur = state.current!;
  const chapters = cur.book.chapters;
  const parts = cur.book.parts;
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const apply = (extra: Correction) => void c.correctChapters([...cur.corrections, extra]);
  const groups = groupByPart(chapters, parts);
  const storyNow = partAt(parts, state.player.positionMs);
  const bookDone = progressOf(cur.book, state).finished;
  const source = chapters.length > cur.book.files.length ? "From the file's markers" : cur.book.files.length > 1 ? "One per file" : "Whole book";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm/6 text-neutral-500 dark:text-neutral-400">
          {cur.corrections.length > 0 ? `${cur.corrections.length} hand ${cur.corrections.length === 1 ? "correction" : "corrections"}` : parts.length > 0 ? `${parts.length} stories` : source}
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
      <div className={clsx(parts.length > 0 && "flex flex-col gap-5")}>
        {groups.map((g, gi) => {
          const storyIndex = g.part ? parts.indexOf(g.part) : -1;
          return (
            <section key={g.part ? g.part.title + storyIndex : "chapters"} aria-label={g.part ? g.part.title : undefined}>
              {g.part && <StoryHeading part={g.part} bookAuthor={cur.book.book.author} now={storyIndex === storyNow} done={storyIndex < storyNow || (storyIndex === storyNow && bookDone)} positionMs={state.player.positionMs} onClick={() => c.seek(g.part!.startMs)} />}
              <ol role="list" className={clsx("divide-y divide-neutral-950/5 dark:divide-white/5", gi > 0 && !g.part && "mt-2")}>
                {g.chapters.map(({ chapter: ch, index: i }) => {
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
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** One story of an anthology: its title, who wrote it when that is worth saying, and how it stands. */
function StoryHeading({ part, bookAuthor, now, done, positionMs, onClick }: { part: Part; bookAuthor: string; now: boolean; done: boolean; positionMs: number; onClick: () => void }) {
  const author = part.author && part.author !== bookAuthor ? part.author : "";
  const standing = done ? "Finished" : now ? `${formatLeft(part.endMs - positionMs)} left` : formatLeft(part.endMs - part.startMs);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={now ? "true" : undefined}
      aria-label={`${part.title}${author ? ` by ${author}` : ""}, ${standing.toLowerCase()}. Go to its start`}
      className="mb-1 flex w-full items-baseline gap-3 rounded-md px-2 py-2 text-left hover:bg-neutral-950/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:hover:bg-white/5"
    >
      <span className="min-w-0 flex-1">
        <span className={clsx("block truncate text-base/6 font-semibold", now ? "text-amber-600 dark:text-amber-400" : "text-neutral-950 dark:text-white")}>{part.title}</span>
        {author && <span className="block truncate text-sm/5 text-neutral-500 dark:text-neutral-400">{author}</span>}
      </span>
      <span className={clsx("flex shrink-0 items-center gap-1 text-sm/6 tabular-nums", done ? "text-neutral-500 dark:text-neutral-400" : "text-neutral-400 dark:text-neutral-500")}>
        {done && <CheckIcon className="size-4 shrink-0 fill-current" />}
        {standing}
      </span>
    </button>
  );
}
