import { ArrowPathIcon, BookmarkIcon, ChevronRightIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { Fragment, type ReactNode } from "react";
import { useAppState, useController } from "./store";
import { IconButton } from "./Button";
import { SearchField } from "./SearchField";

export interface Crumb {
  label: string;
  onClick?: () => void;
}

/**
 * The top of every page: the mark, where you are, search, and the one
 * global action (check the folders for changes). Pages are tabs below it.
 */
export function TopBar({ crumbs, query, onQuery, count, onSubmit }: { crumbs: Crumb[]; query: string; onQuery: (q: string) => void; count: number | null; onSubmit: () => void }) {
  const state = useAppState();
  const c = useController();
  const scanning = state.scanning;
  const status = scanning
    ? scanning.stage
      ? scanning.stage.replace(/…$/, "")
      : scanning.walked > 0
        ? `Checking ${scanning.done.toLocaleString()} of ${scanning.walked.toLocaleString()} files`
        : "Checking for changes"
    : null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-4 sm:px-5">
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5">
        <button type="button" onClick={() => c.showLibrary()} aria-label="Library" className="-ml-1 flex shrink-0 items-center gap-1.5 rounded-md p-1 focus-ring">
          <BookmarkIcon className="size-4 fill-place" aria-hidden="true" />
          <span className="text-sm/5 font-semibold text-ink max-sm:hidden">Ribbon</span>
        </button>
        {crumbs.map((cr, i) => (
          <Fragment key={`${cr.label}-${i}`}>
            <ChevronRightIcon className="size-4 shrink-0 fill-ink-3" aria-hidden="true" />
            {cr.onClick && i < crumbs.length - 1 ? (
              <button type="button" onClick={cr.onClick} className="min-w-0 truncate rounded-sm text-sm/5 text-ink-2 focus-ring hover:text-ink">
                {cr.label}
              </button>
            ) : (
              <span className={clsx("min-w-0 truncate text-sm/5", i === crumbs.length - 1 ? "text-ink" : "text-ink-2")} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                {cr.label}
              </span>
            )}
          </Fragment>
        ))}
      </nav>
      {status && (
        <p className="truncate text-[0.8125rem]/5 text-ink-3 tabular-nums max-md:hidden" role="status">
          {status}…
        </p>
      )}
      {state.books.length > 0 && (
        <div className="w-64 max-sm:hidden">
          <SearchField value={query} onChange={onQuery} count={count} onSubmit={onSubmit} />
        </div>
      )}
      <IconButton label={scanning ? "Checking your folders" : "Check your folders for changes"} icon={ArrowPathIcon} size="sm" onClick={() => void c.rescan()} disabled={scanning !== null} className={clsx(scanning && "[&>svg]:animate-spin")} />
    </header>
  );
}

export type Tab = "library" | "settings";

/** Pages as plain text tabs; the current one in ink with a hairline beneath. */
export function Tabs({ current, onSelect, badges = {} }: { current: Tab | null; onSelect: (t: Tab) => void; badges?: Partial<Record<Tab, ReactNode>> }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "library", label: "Library" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <nav aria-label="Pages" className="shrink-0 overflow-x-auto border-b border-line px-4 sm:px-5">
      <ul role="list" className="flex gap-5">
        {tabs.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              aria-current={current === t.id ? "page" : undefined}
              className={clsx("-mb-px flex items-center gap-1.5 border-b py-2.5 text-sm/5 focus-ring", current === t.id ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink")}
            >
              {t.label}
              {badges[t.id]}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
