import { ArrowPathIcon, CheckCircleIcon, FolderPlusIcon, PlusIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { groupProblems } from "../core/problems";
import { isHandMade } from "../core/series";
import { useAppState, useController } from "./store";
import { Button, IconButton } from "./Button";
import { EmptyState, Group, Menu, Row, SectionHeader, Toggle } from "./kit";

declare const __APP_VERSION__: string;

/**
 * Settings: the folders the library is made of, the files a scan could
 * not read, the series, the one online lookup, and Ribbon's own folder.
 */
export function SettingsPane() {
  const state = useAppState((s) => ({
    problems: s.problems,
    books: s.books,
    sources: s.sources,
    sourceStatus: s.sourceStatus,
    scanning: s.scanning,
    series: s.series,
    about: s.about,
    lookup: s.lookup,
    speech: s.speech,
    history: s.history,
    perfLog: s.perfLog,
  }));
  const c = useController();
  const groups = groupProblems(state.problems);
  const series = useMemo(() => c.detectedSeries(), [c, state.books, state.sources, state.series]);
  const [homePath, setHomePath] = useState<string | null>(null);
  useEffect(() => {
    void c.homePath().then(setHomePath);
  }, [c]);
  const bookFor = (source: string | undefined, folder: string) => state.books.find((b) => b.source === source && b.book.path === folder) ?? null;
  const sourceName = (id: string | undefined) => state.sources.find((s) => s.id === id)?.name ?? "";
  const countBySource = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of state.books) m.set(b.source ?? "", (m.get(b.source ?? "") ?? 0) + 1);
    return m;
  }, [state.books]);
  const described = Object.values(state.about).filter((a) => a.source === "openlibrary").length;

  return (
    <section className="h-full overflow-y-auto quiet-scroll" aria-label="Settings">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 pt-8 pb-16 sm:px-8">
        <section aria-labelledby="settings-folders" className="flex flex-col gap-4">
          <SectionHeader
            id="settings-folders"
            title="Folders"
            description="The library is these folders together. Books stay where they are; Ribbon keeps its records beside them in a .ribbon folder. Removing a folder here changes nothing on disk."
            actions={
              <>
                {state.sources.length > 1 && (
                  <Button size="sm" variant="ghost" leading={ArrowPathIcon} onClick={() => void c.rescan()} disabled={state.scanning !== null}>
                    {state.scanning ? "Checking…" : "Check all"}
                  </Button>
                )}
                <Button size="sm" leading={FolderPlusIcon} onClick={() => void c.pickLibrary()}>
                  Add a folder
                </Button>
              </>
            }
          />
          <Group>
            {state.sources.map((s) => {
              const status = state.sourceStatus[s.id];
              const count = countBySource.get(s.id) ?? 0;
              const busy = !!status?.scanning;
              const line = status?.error
                ? `Could not open it: ${status.error}`
                : status?.scanning
                  ? status.scanning.stage
                    ? status.scanning.stage
                    : status.scanning.walked > 0
                      ? `Checking ${status.scanning.done.toLocaleString()} of ${status.scanning.walked.toLocaleString()} files…`
                      : "Checking for changes…"
                  : `${count.toLocaleString()} ${count === 1 ? "book" : "books"}${status?.lastScanMs !== null && status?.lastScanMs !== undefined ? (status.lastScanMs < 1000 ? ", checked in under a second" : `, checked in ${(status.lastScanMs / 1000).toFixed(1)} s`) : ""}`;
              return (
                <Row
                  key={s.id}
                  title={s.name}
                  description={
                    <>
                      <span className="block truncate font-mono text-[0.75rem]/5 text-ink-3" title={s.root}>
                        {s.root}
                      </span>
                      <span className={clsx("block", status?.error ? "text-red-600 dark:text-red-400" : "")}>{line}</span>
                      {status?.readOnly && !status.error && <span className="block">Read-only from {c.here}: your place in its books is kept on {c.here}.</span>}
                    </>
                  }
                  aside={
                    <>
                      <IconButton size="sm" label={`Check ${s.name} for changes`} icon={ArrowPathIcon} onClick={() => void c.rescanSourceById(s.id)} disabled={busy} className={clsx(busy && "[&>svg]:animate-spin")} />
                      <Menu label={`${s.name}: more`} title={s.name} items={[{ label: "Remove from the library", onSelect: () => void c.removeSource(s.id), danger: true }]} />
                    </>
                  }
                />
              );
            })}
          </Group>
        </section>

        <section aria-labelledby="settings-problems" className="flex flex-col gap-4">
          <SectionHeader
            id="settings-problems"
            title="Files Ribbon could not read"
            description={state.problems.length === 0 ? undefined : `${state.problems.length.toLocaleString()} ${state.problems.length === 1 ? "file" : "files"} on the last check, by folder. Checking a folder again reads them again.`}
          />
          {groups.length === 0 ? (
            <div className="rounded-[10px] ring-1 ring-line">
              <EmptyState compact icon={CheckCircleIcon} title="Every file was read">
                The last check of every folder found nothing it could not open.
              </EmptyState>
            </div>
          ) : (
            <Group>
              {groups.map((g) => {
                const book = bookFor(g.source, g.folder);
                const where = state.sources.length > 1 ? sourceName(g.source) : "";
                return (
                  <div key={`${g.source ?? ""}:${g.folder || "/"}`} className="rounded-md bg-raised px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-base/6 font-medium text-ink sm:text-sm/5">{book ? book.book.title : g.folder || where || "Library folder"}</p>
                        {(book?.book.author || where) && <p className="truncate text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">{[book?.book.author, where].filter(Boolean).join(" · ")}</p>}
                      </div>
                      <Button size="sm" leading={ArrowPathIcon} onClick={() => void (g.source && c.rescanFolder(g.source, g.folder))} disabled={state.scanning !== null || !g.source}>
                        Check again
                      </Button>
                    </div>
                    <ul role="list" className="mt-2 flex flex-col gap-1">
                      {g.problems.map((p) => (
                        <li key={p.path} className="flex flex-wrap items-baseline gap-x-3 text-sm/5 sm:text-[0.8125rem]/5">
                          <span className="min-w-0 truncate font-mono text-[0.75rem]/5 text-ink-2" title={p.path}>
                            {p.path.slice(p.path.lastIndexOf("/") + 1)}
                          </span>
                          <span className="text-ink-3">{p.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </Group>
          )}
        </section>

        <section aria-labelledby="settings-series" className="flex flex-col gap-4">
          <SectionHeader
            id="settings-series"
            title="Series"
            description={series.length === 0 ? "No series yet. Numbered folders or a series tag make one, or make your own from any books." : "Which books belong, in what order, and which to leave off the shelf. Nothing is deleted."}
            actions={
              <Button size="sm" leading={PlusIcon} onClick={() => c.openNewSeries()} disabled={state.books.length === 0}>
                New series
              </Button>
            }
          />
          {series.length > 0 && (
            <Group>
              {series.map((g) => {
                const record = state.series[g.key];
                const left = record ? record.choices.filter((ch) => !ch.included).length : 0;
                const added = g.added?.length ?? 0;
                return (
                  <Row
                    key={g.key}
                    title={g.name}
                    description={`${g.bookIds.length} ${g.bookIds.length === 1 ? "book" : "books"}${isHandMade(g) ? ", made by hand" : added > 0 ? `, ${added} added by hand` : ""}${record ? `, ${left === 0 ? "all on the shelf" : `${left} left off`}` : ", not set up yet"}`}
                    aside={
                      <Button size="sm" onClick={() => c.openSeriesSetup(g.key)}>
                        {record ? "Change…" : "Set up…"}
                      </Button>
                    }
                  />
                );
              })}
            </Group>
          )}
        </section>

        <section aria-labelledby="settings-readalong" className="flex flex-col gap-4">
          <SectionHeader id="settings-readalong" title="Read-along" description="How Ribbon pairs a book’s text with its narration." />
          <Group footer="With a speech model, Ribbon listens to the first seconds of each chapter, on this machine, and matches the words with the book’s text. Nothing is sent anywhere, and each book is heard once. Use a whisper.cpp model you already have, or download Ribbon’s (whisper base, about 57 MB, from Hugging Face).">
            <Row
              title="Speech model"
              description={state.speech.downloading ? `Downloading… ${state.speech.downloading.total > 0 ? Math.round((state.speech.downloading.done / state.speech.downloading.total) * 100) : 0}%` : state.speech.model ? state.speech.model.split(/[\\/]/).pop() : "None: chapters are paired by length and name."}
              aside={
                <div className="flex items-center gap-1">
                  {state.speech.model ? (
                    <>
                      <Button size="sm" onClick={() => void c.chooseSpeechModel()}>
                        Change…
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => c.setSpeechModel(null)}>
                        Remove
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => void c.chooseSpeechModel()} disabled={!!state.speech.downloading}>
                        Choose file…
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void c.downloadSpeechModel()} disabled={!!state.speech.downloading}>
                        Download
                      </Button>
                    </>
                  )}
                </div>
              }
            />
          </Group>
        </section>

        <section aria-labelledby="settings-online" className="flex flex-col gap-4">
          <SectionHeader id="settings-online" title="Online" description="The only things Ribbon ever asks the internet, and only if you turn it on." />
          <Group footer="Sends a book's title and author once, in the background: to Open Library for a description, and, for a book whose chapters are only numbered, to Audible's catalog and Audnexus for the names the publisher gave them. Names go on only when the count and the times match, and undo like any chapter change. Answers are kept beside the book.">
            <Row
              title="Descriptions and chapter names"
              description={state.lookup.running ? `Asking about book ${state.lookup.done + 1} of ${state.lookup.total}…` : `${described.toLocaleString()} of ${state.books.length.toLocaleString()} books have a description.`}
              aside={<Toggle label="Look up descriptions and chapter names online" checked={state.lookup.enabled} onChange={(on) => void c.setLookup(on)} />}
            />
          </Group>
        </section>

        <section aria-labelledby="settings-history" className="flex flex-col gap-4">
          <SectionHeader id="settings-history" title="History" description="What Ribbon keeps about your listening, in the position log beside your books." />
          <Group footer="Each stretch of listening of thirty seconds or more: when, which book, how long. Turning this off keeps what is there and adds no more. Finished books and your place are always kept.">
            <Row
              title="Keep listening sessions"
              description={`${state.history.sessions.length.toLocaleString()} ${state.history.sessions.length === 1 ? "session" : "sessions"} so far, behind the Stats page.`}
              aside={<Toggle label="Keep listening sessions" checked={state.history.recording} onChange={(on) => void c.setRecordSessions(on)} />}
            />
          </Group>
        </section>

        {homePath && (
          <section aria-labelledby="settings-home" className="flex flex-col gap-4">
            <SectionHeader id="settings-home" title="Ribbon folder" description="The one place Ribbon keeps its own files on this machine: a copy of each library's records, your places, the covers, and the log." />
            <Group>
              <Row
                title={<span className="font-mono text-[0.8125rem]/5 font-normal">{homePath}</span>}
                aside={
                  <>
                    <Button size="sm" onClick={() => void c.revealHome()}>
                      Show in Explorer
                    </Button>
                    <Menu label="Ribbon folder: more" title="Ribbon folder" items={[{ label: "Reset Ribbon…", onSelect: () => void c.resetHome(), danger: true }]} />
                  </>
                }
              />
            </Group>
            <Group footer="Once a minute while you use Ribbon, a line in the log with how long page turns, opening a book, laying out a chapter and scrolling took. For finding what feels slow; nothing leaves this machine.">
              <Row title="Write speed measurements to the log" aside={<Toggle label="Write speed measurements to the log" checked={state.perfLog} onChange={(on) => void c.setPerfLog(on)} />} />
            </Group>
          </section>
        )}

        <p className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">Ribbon {__APP_VERSION__}. A home for your books, read or heard.</p>
      </div>
    </section>
  );
}
