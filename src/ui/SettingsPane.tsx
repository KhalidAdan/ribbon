import { ArrowPathIcon, ChevronLeftIcon, FolderPlusIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { useEffect, useMemo, useState } from "react";
import { groupProblems } from "../core/problems";
import { useAppState, useController } from "./store";
import { Button } from "./Button";

declare const __APP_VERSION__: string;

/**
 * Settings: the library folder, the problems the last scan found, and
 * the version. Full width, with a way back to the shelf.
 */
export function SettingsPane() {
  const state = useAppState();
  const c = useController();
  const groups = groupProblems(state.problems);
  const series = useMemo(() => c.detectedSeries(), [c, state.books, state.sources]);
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

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label="Settings">
      <header className="flex items-center gap-2 px-3 pt-3 sm:px-5">
        <Button icon size="sm" variant="ghost" aria-label="Back to library" onClick={() => c.showLibrary()}>
          <ChevronLeftIcon className="size-4 fill-current" />
        </Button>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-950 dark:text-white">Settings</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6 sm:px-8">
          <Section title="Folders" description="The folders your library is made of. The books stay where they are; Ribbon reads them in place and keeps its records beside them in a .ribbon folder. Removing a folder here changes nothing on disk.">
            <ul role="list" className="divide-y divide-neutral-950/5 dark:divide-white/5">
              {state.sources.map((s) => {
                const status = state.sourceStatus[s.id];
                const count = countBySource.get(s.id) ?? 0;
                const line = status?.error
                  ? `Could not open: ${status.error}`
                  : status?.scanning
                    ? status.scanning.stage
                      ? status.scanning.stage
                      : status.scanning.walked > 0
                        ? `Checking ${status.scanning.done.toLocaleString()} of ${status.scanning.walked.toLocaleString()} files…`
                        : "Checking for changes…"
                    : `${count.toLocaleString()} ${count === 1 ? "book" : "books"}${status?.lastScanMs !== null && status?.lastScanMs !== undefined ? (status.lastScanMs < 1000 ? " · last check took under a second" : ` · last check took ${(status.lastScanMs / 1000).toFixed(1)} s`) : ""}`;
                return (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-base/6 font-medium text-neutral-950 sm:text-sm/6 dark:text-white">{s.name}</p>
                      <p className="truncate text-sm/5 text-neutral-500 dark:text-neutral-400" title={s.root}>
                        {s.root}
                      </p>
                      <p className={status?.error ? "text-sm/5 text-red-600 dark:text-red-400" : "text-sm/5 text-neutral-500 dark:text-neutral-400"}>{line}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button icon size="sm" variant="ghost" aria-label={`Rescan ${s.name}`} title="Rescan" onClick={() => void c.rescanSourceById(s.id)} disabled={status?.scanning !== null && status?.scanning !== undefined}>
                        <ArrowPathIcon className={status?.scanning ? "size-4 animate-spin fill-current" : "size-4 fill-current"} />
                      </Button>
                      <Button icon size="sm" variant="ghost" aria-label={`Remove ${s.name} from the library`} title="Remove from the library" onClick={() => void c.removeSource(s.id)}>
                        <XMarkIcon className="size-4 fill-current" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void c.pickLibrary()} className="py-1.5 pr-2.5 pl-1.5">
                <FolderPlusIcon className="size-4 fill-current" />
                Add a folder
              </Button>
              {state.sources.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => void c.rescan()} disabled={state.scanning !== null} className="py-1.5 pr-2.5 pl-1.5">
                  <ArrowPathIcon className="size-4 fill-current" />
                  {state.scanning ? "Checking…" : "Rescan every folder"}
                </Button>
              )}
            </div>
          </Section>

          <Section
            title="Problems"
            description={
              state.problems.length === 0
                ? "Every file in the library was read on the last scan."
                : `${state.problems.length.toLocaleString()} ${state.problems.length === 1 ? "file" : "files"} could not be read. Each is listed under its folder; a rescan reads it again.`
            }
          >
            {groups.length > 0 && (
              <ul role="list" className="divide-y divide-neutral-950/5 dark:divide-white/5">
                {groups.map((g) => {
                  const book = bookFor(g.source, g.folder);
                  const where = state.sources.length > 1 ? sourceName(g.source) : "";
                  return (
                    <li key={`${g.source ?? ""}:${g.folder || "/"}`} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-base/6 font-medium text-neutral-950 sm:text-sm/6 dark:text-white">{book ? book.book.title : g.folder || where || "Library folder"}</p>
                          {(book?.book.author || where) && (
                            <p className="truncate text-sm/5 text-neutral-500 dark:text-neutral-400">{[book?.book.author, where].filter(Boolean).join(" · ")}</p>
                          )}
                        </div>
                        <Button size="sm" onClick={() => void (g.source && c.rescanFolder(g.source, g.folder))} disabled={state.scanning !== null || !g.source} className="shrink-0 py-1.5 pr-2.5 pl-1.5">
                          <ArrowPathIcon className="size-4 fill-current" />
                          Rescan
                        </Button>
                      </div>
                      <ul className="mt-2 flex flex-col gap-1">
                        {g.problems.map((p) => (
                          <li key={p.path} className="flex flex-wrap items-baseline gap-x-3 text-sm/5">
                            <span className="min-w-0 truncate text-neutral-700 dark:text-neutral-300" title={p.path}>
                              {p.path.slice(p.path.lastIndexOf("/") + 1)}
                            </span>
                            <span className="text-neutral-500 dark:text-neutral-400">{p.message}</span>
                            {p.at && (
                              <time dateTime={p.at} className="text-neutral-400 tabular-nums dark:text-neutral-500">
                                {new Date(p.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                              </time>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="Series"
            description={series.length === 0 ? "No series found. Numbered folders or a series tag make one." : "Which books belong, in what order, and which to leave off the shelf. Nothing is deleted."}
          >
            {series.length > 0 && (
              <ul role="list" className="divide-y divide-neutral-950/5 dark:divide-white/5">
                {series.map((g) => {
                  const record = state.series[g.key];
                  const left = record ? record.choices.filter((ch) => !ch.included).length : 0;
                  return (
                    <li key={g.key} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-base/6 font-medium text-neutral-950 sm:text-sm/6 dark:text-white">{g.name}</p>
                        <p className="text-sm/5 text-neutral-500 dark:text-neutral-400">
                          {g.bookIds.length} books
                          {record ? ` · ${left === 0 ? "all on the shelf" : `${left} left off`} · set up ${new Date(record.decidedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}` : " · not set up"}
                        </p>
                      </div>
                      <Button size="sm" onClick={() => c.openSeriesSetup(g.key)} className="shrink-0">
                        {record ? "Change" : "Set up"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="Descriptions"
            description="Ribbon can ask Open Library, a free book database, about each book: it sends the title and author once, in the background, and keeps the answer beside the book. Off unless you turn it on."
          >
            <label htmlFor="lookup-descriptions" className="flex cursor-pointer items-start gap-3">
              <input id="lookup-descriptions" type="checkbox" role="switch" checked={state.lookup.enabled} onChange={(e) => void c.setLookup(e.target.checked)} className="mt-1 size-4 shrink-0 accent-amber-500" />
              <span>
                <span className="block text-base/6 text-neutral-950 sm:text-sm/6 dark:text-white">Look up descriptions from Open Library</span>
                <span className="block text-sm/5 text-neutral-500 dark:text-neutral-400">
                  {state.lookup.running
                    ? `Asking about book ${state.lookup.done + 1} of ${state.lookup.total}…`
                    : `${Object.values(state.about).filter((a) => a.source === "openlibrary").length.toLocaleString()} of ${state.books.length.toLocaleString()} books have a description.`}
                </span>
              </span>
            </label>
          </Section>

          {homePath && (
            <Section title="Ribbon folder" description="The one place Ribbon keeps its own files on this machine: a local mirror of each library's records and covers, the log, and the list of libraries opened here. Your records stay beside your books.">
              <p className="truncate text-base/6 text-neutral-950 sm:text-sm/6 dark:text-white" title={homePath}>
                {homePath}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void c.revealHome()}>
                  Reveal in Explorer
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void c.resetHome()}>
                  Reset Ribbon…
                </Button>
              </div>
            </Section>
          )}

          <Section title="About" description={`Ribbon ${__APP_VERSION__}. The listener for books you own.`}>
            <p className="text-sm/6 text-neutral-500 dark:text-neutral-400">The log lives in the Ribbon folder; the problems above are the part of it worth reading.</p>
          </Section>
        </div>
      </div>
    </section>
  );
}

function Section({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return (
    <section aria-labelledby={`settings-${title}`}>
      <h2 id={`settings-${title}`} className="text-base/6 font-semibold text-neutral-950 dark:text-white">
        {title}
      </h2>
      <p className="mt-0.5 text-sm/6 text-pretty text-neutral-500 dark:text-neutral-400">{description}</p>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
