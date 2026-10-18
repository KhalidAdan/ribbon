import { CheckIcon, PencilSquareIcon, ScissorsIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useState } from "react";
import { formatDuration, formatLeft } from "../core/speed";
import type { Correction } from "../core/scan/chapters";
import { groupByPart, partAt } from "../core/scan/parts";
import type { Part } from "../core/types";
import { fit, REGIONS, titlesAndTimes, titlesOnly, type LookedUp, type Region } from "../core/audnexus";
import { useAppState, useController } from "./store";
import { progressOf } from "./progress";
import { Button, IconButton } from "./Button";
import { Group, Menu } from "./kit";

const input = "rounded-md bg-raised px-2.5 py-1 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:text-sm/6";

/**
 * The chapters of the open book, and for an anthology, its stories with
 * their chapters beneath each. A story's heading jumps to its start; a
 * chapter row jumps to the chapter. Edit puts the tools out: start a
 * chapter where you are, move a start to here or by a second, shift the
 * rest, rename, name them all from a pattern, one chapter per file, or
 * look the chapters up by ASIN. Every change is a correction kept beside
 * the book, and all of them can be undone at once.
 */
export function ChapterList() {
  const state = useAppState();
  const c = useController();
  const cur = state.current!;
  const chapters = cur.book.chapters;
  const parts = cur.book.parts;
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [shifting, setShifting] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const apply = (...extra: Correction[]) => void c.correctChapters([...cur.corrections, ...extra]);
  const groups = groupByPart(chapters, parts);
  const storyNow = partAt(parts, state.player.positionMs);
  const bookDone = progressOf(cur.book, state).finished;
  const here = state.player.positionMs;
  const source = chapters.length > cur.book.files.length ? "From the markers in the file" : cur.book.files.length > 1 ? "One per file" : "The whole book";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
          {cur.corrections.length > 0 && state.namedChapters[cur.book.book.id]
            ? `Names from Audible’s data (${state.namedChapters[cur.book.book.id]})`
            : cur.corrections.length > 0
              ? `${cur.corrections.length} ${cur.corrections.length === 1 ? "change" : "changes"} by hand`
              : parts.length > 0
                ? `${parts.length} stories`
                : source}
        </p>
        <Button size="sm" variant={editing ? "secondary" : "ghost"} leading={editing ? CheckIcon : PencilSquareIcon} onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
          {editing ? "Done" : "Edit"}
        </Button>
      </div>

      {editing && <Tools here={here} onApply={apply} />}

      <div className={clsx(parts.length > 0 && "flex flex-col gap-4")}>
        {groups.map((g) => {
          const storyIndex = g.part ? parts.indexOf(g.part) : -1;
          return (
            <section key={g.part ? g.part.title + storyIndex : "chapters"} aria-label={g.part ? g.part.title : undefined}>
              {g.part && <StoryHeading part={g.part} bookAuthor={cur.book.book.author} now={storyIndex === storyNow} done={storyIndex < storyNow || (storyIndex === storyNow && bookDone)} positionMs={here} onClick={() => c.seek(g.part!.startMs)} />}
              <ol role="list" className="flex flex-col">
                {g.chapters.map(({ chapter: ch, index: i }) => {
                  const active = i === state.player.chapterIndex;
                  const done = i < state.player.chapterIndex;
                  return (
                    <li key={`${ch.startMs}-${i}`} className="flex flex-col">
                      <div className="group/row flex items-center gap-1">
                        {renaming === i ? (
                          <form
                            className="flex min-w-0 flex-1 items-center gap-1 py-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (draft.trim()) apply({ op: "rename", index: i, title: draft.trim() });
                              setRenaming(null);
                            }}
                          >
                            <label htmlFor={`chapter-title-${i}`} className="sr-only">
                              Chapter title
                            </label>
                            <input id={`chapter-title-${i}`} name="title" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className={clsx(input, "min-w-0 flex-1")} />
                            <IconButton type="submit" size="sm" label="Save title" icon={CheckIcon} />
                            <IconButton size="sm" label="Cancel" icon={XMarkIcon} onClick={() => setRenaming(null)} />
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => c.goToChapter(i)}
                            aria-current={active ? "true" : undefined}
                            className={clsx("relative flex min-w-0 flex-1 items-baseline gap-3 rounded-md py-2 pr-2 pl-3 text-left focus-ring", active ? "bg-raised" : "hover:bg-raised")}
                          >
                            {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-place" aria-hidden="true" />}
                            <span className="w-14 shrink-0 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{formatDuration(ch.startMs)}</span>
                            <span className={clsx("min-w-0 flex-1 truncate text-base/6 sm:text-sm/5", active ? "font-medium text-ink" : done ? "text-ink-3" : "text-ink-2")}>{ch.title}</span>
                            <span className="shrink-0 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{formatDuration(ch.endMs - ch.startMs)}</span>
                          </button>
                        )}
                        {editing && renaming !== i && (
                          <div className="flex shrink-0 items-center">
                            <IconButton
                              size="sm"
                              label={`Rename ${ch.title}`}
                              icon={PencilSquareIcon}
                              onClick={() => {
                                setDraft(ch.title);
                                setRenaming(i);
                              }}
                            />
                            <Menu
                              label={`${ch.title}: more`}
                              title={ch.title}
                              items={[
                                { label: `Start it here, at ${formatDuration(here)}`, onSelect: () => apply({ op: "move", index: i, startMs: here }), disabled: i === 0 },
                                { label: "Start it a second earlier", onSelect: () => apply({ op: "move", index: i, startMs: Math.max(0, ch.startMs - 1000) }), disabled: i === 0 },
                                { label: "Start it a second later", onSelect: () => apply({ op: "move", index: i, startMs: ch.startMs + 1000 }), disabled: i === 0 },
                                { label: "Shift it and every later one…", onSelect: () => setShifting(i) },
                                { label: "Merge into the chapter before", onSelect: () => apply({ op: "delete", index: i }), disabled: i === 0 },
                              ]}
                            />
                          </div>
                        )}
                      </div>
                      {shifting === i && <ShiftForm index={i} onApply={(deltaMs) => apply({ op: "shift", index: i, deltaMs })} onDone={() => setShifting(null)} />}
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

function ShiftForm({ index, onApply, onDone }: { index: number; onApply: (deltaMs: number) => void; onDone: () => void }) {
  const [seconds, setSeconds] = useState("");
  const n = Number(seconds);
  return (
    <form
      className="my-1 ml-3 flex flex-wrap items-center gap-2 rounded-md bg-raised px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (seconds.trim() && Number.isFinite(n) && n !== 0) onApply(Math.round(n * 1000));
        onDone();
      }}
    >
      <label htmlFor={`shift-${index}`} className="text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">
        Move this and every later start by
      </label>
      <input id={`shift-${index}`} name="shift" autoFocus inputMode="decimal" placeholder="-2.5" value={seconds} onChange={(e) => setSeconds(e.target.value)} className={clsx(input, "w-20 text-right tabular-nums")} />
      <span className="text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">seconds</span>
      <Button type="submit" size="sm">
        Shift
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

/** The tools that work on the whole list. */
function Tools({ here, onApply }: { here: number; onApply: (...c: Correction[]) => void }) {
  const state = useAppState();
  const c = useController();
  const cur = state.current!;
  const [pattern, setPattern] = useState("Chapter {n}");
  const [from, setFrom] = useState("1");
  const [asin, setAsin] = useState(cur.book.book.asin ?? "");
  const [region, setRegion] = useState<Region>("us");
  const [lookup, setLookup] = useState<{ state: "idle" } | { state: "busy" } | { state: "found"; found: LookedUp } | { state: "error"; message: string }>({ state: "idle" });
  const multiFile = cur.book.files.length > 1;
  const f = lookup.state === "found" ? fit(lookup.found, cur.book.book.durationMs, cur.book.chapters.length) : null;

  return (
    <Group label="Change the chapters" footer="Changes are kept beside the book and never touch the audio. Undo every change to go back to what the files say.">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-raised px-3 py-2.5">
        <p className="text-base/6 font-medium text-ink sm:text-sm/5">Start a new chapter where you are</p>
        <Button size="sm" leading={ScissorsIcon} onClick={() => onApply({ op: "insert", startMs: here, title: "" })}>
          At {formatDuration(here)}
        </Button>
      </div>

      <form
        className="flex flex-wrap items-center gap-2 rounded-md bg-raised px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (pattern.includes("{n")) onApply({ op: "titles", pattern, from: Number(from) || 1 });
        }}
      >
        <label htmlFor="chapter-pattern" className="basis-full text-base/6 font-medium text-ink sm:text-sm/5">
          Name every chapter from a pattern
        </label>
        <input id="chapter-pattern" name="chapter-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} className={clsx(input, "min-w-0 flex-1")} aria-describedby="chapter-pattern-hint" />
        <label htmlFor="chapter-from" className="sr-only">
          First number
        </label>
        <input id="chapter-from" name="chapter-from" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value)} className={clsx(input, "w-14 text-right tabular-nums")} />
        <Button type="submit" size="sm" disabled={!pattern.includes("{n")}>
          Name them
        </Button>
        <p id="chapter-pattern-hint" className="basis-full text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">
          {"{n}"} is the number; {"{nn}"} pads it to two digits. The first chapter gets the number on the right.
        </p>
      </form>

      {multiFile && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-raised px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-base/6 font-medium text-ink sm:text-sm/5">One chapter per file</p>
            <p className="text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">{cur.book.files.length} files, named as the files are.</p>
          </div>
          <Button size="sm" onClick={() => onApply({ op: "files" })}>
            Use the files
          </Button>
        </div>
      )}

      <form
        className="flex flex-wrap items-center gap-2 rounded-md bg-raised px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!asin.trim()) return;
          setLookup({ state: "busy" });
          c.lookupChapters(asin, region).then(
            (found) => setLookup({ state: "found", found }),
            (err: unknown) => setLookup({ state: "error", message: err instanceof Error ? err.message : String(err) }),
          );
        }}
      >
        <label htmlFor="chapter-asin" className="basis-full text-base/6 font-medium text-ink sm:text-sm/5">
          Look the chapters up by ASIN
        </label>
        <input id="chapter-asin" name="chapter-asin" value={asin} onChange={(e) => setAsin(e.target.value)} placeholder="B002V1OF70" autoComplete="off" spellCheck={false} className={clsx(input, "w-36 font-mono uppercase")} />
        <label htmlFor="chapter-region" className="sr-only">
          Audible region
        </label>
        <span className="inline-grid grid-cols-[1fr_--spacing(7)]">
          <select id="chapter-region" name="chapter-region" value={region} onChange={(e) => setRegion(e.target.value as Region)} className={clsx(input, "col-span-full row-start-1 appearance-none pr-7 uppercase")}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <svg viewBox="0 0 8 5" width="8" height="5" fill="none" className="pointer-events-none col-start-2 row-start-1 place-self-center stroke-ink-3" aria-hidden="true">
            <path d="M.5.5 4 4 7.5.5" />
          </svg>
        </span>
        <Button type="submit" size="sm" disabled={!asin.trim() || lookup.state === "busy"}>
          {lookup.state === "busy" ? "Asking…" : "Look up"}
        </Button>
        <p className="basis-full text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">Asks Audnexus, an open service with Audible’s chapter data. Only the ASIN is sent.</p>
        {lookup.state === "error" && <p className="basis-full text-sm/5 text-ink sm:text-[0.8125rem]/5">{lookup.message}</p>}
        {lookup.state === "found" && f && (
          <div className="basis-full rounded-md bg-surface p-3 ring-1 ring-line">
            <p className="text-base/6 text-ink sm:text-sm/5">
              Found {lookup.found.chapters.length} chapters over {formatLeft(lookup.found.runtimeMs)}
              {Math.abs(f.diffMs) >= 1000 ? `, ${formatLeft(Math.abs(f.diffMs))} ${f.diffMs > 0 ? "longer" : "shorter"} than this book` : ", the same length as this book"}.
            </p>
            {!f.timesFit && <p className="mt-1 text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">The lengths differ by more than a little, so the times may not line up. Titles alone are safer.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={!f.countsMatch} onClick={() => onApply(...titlesOnly(lookup.found, cur.book.chapters.length))} title={f.countsMatch ? undefined : `This book has ${cur.book.chapters.length} chapters`}>
                Use the titles
              </Button>
              <Button size="sm" variant={f.timesFit ? "primary" : "secondary"} onClick={() => onApply(...titlesAndTimes(lookup.found, cur.book.book.durationMs))}>
                Use titles and times
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLookup({ state: "idle" })}>
                Never mind
              </Button>
            </div>
          </div>
        )}
      </form>

      {cur.corrections.length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-raised px-3 py-2.5">
          <p className="text-base/6 font-medium text-ink sm:text-sm/5">Undo every change</p>
          <Button size="sm" variant="ghost" onClick={() => void c.correctChapters([])}>
            Back to the files
          </Button>
        </div>
      )}
    </Group>
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
      className="mb-1 flex w-full items-baseline gap-3 rounded-md px-3 py-2 text-left focus-ring hover:bg-raised"
    >
      <span className="min-w-0 flex-1">
        <span className={clsx("block truncate text-base/6 font-semibold sm:text-sm/5", now ? "text-place" : "text-ink")}>{part.title}</span>
        {author && <span className="block truncate text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">{author}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">
        {done && <CheckIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />}
        {standing}
      </span>
    </button>
  );
}
