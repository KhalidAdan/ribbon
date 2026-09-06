import type { ScanStatus } from "../app/controller";

/**
 * What the library pane shows while a first scan runs: a live count, a
 * bar, and placeholder rows so the space reads as "books arriving".
 */
export function ScanProgress({ status }: { status: ScanStatus }) {
  const walking = status.walked === 0;
  const fraction = walking ? 0 : Math.min(1, status.done / status.walked);
  const label = status.stage
    ? status.stage
    : walking
      ? status.found
        ? `Found ${status.found.toLocaleString()} files so far…`
        : "Looking through your folder…"
      : `Reading ${status.done.toLocaleString()} of ${status.walked.toLocaleString()} files…`;
  const rows = walking ? 5 : Math.max(3, Math.min(12, Math.ceil(status.walked / 20)));

  return (
    <div className="px-4 sm:px-5" role="status" aria-live="polite">
      <p className="text-base/6 text-neutral-950 tabular-nums sm:text-sm/6 dark:text-white">{label}</p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-neutral-950/10 dark:bg-white/15" aria-hidden="true">
        <div
          className={walking ? "h-full w-1/3 animate-pulse rounded-full bg-amber-500/60 dark:bg-amber-400/60" : "h-full w-(--progress) rounded-full bg-amber-500 dark:bg-amber-400"}
          style={{ "--progress": `${(fraction * 100).toFixed(1)}%` } as React.CSSProperties}
        />
      </div>
      <ul role="list" className="mt-4 flex flex-col gap-1" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3 p-2">
            <div className="size-14 shrink-0 animate-pulse rounded-[min(1vw,10px)] bg-neutral-950/5 dark:bg-white/5" />
            <div className="min-w-0 flex-1">
              <div className="h-3.5 w-3/5 animate-pulse rounded bg-neutral-950/5 dark:bg-white/5" />
              <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-neutral-950/5 dark:bg-white/5" />
              <div className="mt-2.5 h-1 w-full animate-pulse rounded-full bg-neutral-950/5 dark:bg-white/5" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
