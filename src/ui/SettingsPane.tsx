import { ArrowPathIcon, ChevronLeftIcon, FolderOpenIcon } from "@heroicons/react/16/solid";
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
  const bookFor = (folder: string) => state.books.find((b) => b.book.path === folder) ?? null;

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
          <Section title="Library" description="Where your books are. Records live beside them in a .ribbon folder.">
            <p className="truncate text-base/6 text-neutral-950 sm:text-sm/6 dark:text-white" title={state.root ?? ""}>
              {state.root}
            </p>
            <p className="mt-1 text-sm/6 text-neutral-500 dark:text-neutral-400">
              {state.books.length.toLocaleString()} {state.books.length === 1 ? "book" : "books"}
              {state.lastScanMs !== null ? (state.lastScanMs < 1000 ? " · last check took under a second" : ` · last check took ${(state.lastScanMs / 1000).toFixed(1)} s`) : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void c.rescan()} disabled={state.scanning !== null} className="py-1.5 pr-2.5 pl-1.5">
                <ArrowPathIcon className="size-4 fill-current" />
                {state.scanning ? "Checking…" : "Rescan library"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => c.forgetLibrary()} className="py-1.5 pr-2.5 pl-1.5">
                <FolderOpenIcon className="size-4 fill-current" />
                Choose a different folder
              </Button>
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
                  const book = bookFor(g.folder);
                  return (
                    <li key={g.folder || "/"} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-base/6 font-medium text-neutral-950 sm:text-sm/6 dark:text-white">{book ? book.book.title : g.folder || "Library folder"}</p>
                          {book && book.book.author && <p className="truncate text-sm/5 text-neutral-500 dark:text-neutral-400">{book.book.author}</p>}
                        </div>
                        <Button size="sm" onClick={() => void c.rescanFolder(g.folder)} disabled={state.scanning !== null} className="shrink-0 py-1.5 pr-2.5 pl-1.5">
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

          <Section title="About" description={`Ribbon ${__APP_VERSION__}. The listener for books you own.`}>
            <p className="text-sm/6 text-neutral-500 dark:text-neutral-400">The log file is under the app's data folder; problems above are the part of it worth reading.</p>
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
