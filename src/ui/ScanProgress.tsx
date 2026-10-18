import type { ScanStatus } from "../app/controller";
import { ProgressLine } from "./kit";

/**
 * What the page shows while a first scan runs: a sentence with a live
 * count, a hairline, and placeholder cards so the space reads as
 * "books arriving".
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
  const cards = walking ? 6 : Math.max(4, Math.min(12, Math.ceil(status.walked / 20)));

  return (
    <div role="status" aria-live="polite">
      <p className="text-base/6 font-medium text-ink tabular-nums sm:text-sm/5">{label}</p>
      <p className="mt-0.5 text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">Books appear as they are found. Nothing is copied or changed.</p>
      {walking ? <div className="mt-3 h-[3px] w-1/3 animate-pulse rounded-full bg-place/60" aria-hidden="true" /> : <ProgressLine fraction={fraction} className="mt-3" />}
      <ul role="list" className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-5 gap-y-8" aria-hidden="true">
        {Array.from({ length: cards }, (_, i) => (
          <li key={i}>
            <div className="aspect-square animate-pulse rounded-[4px] bg-raised" />
            <div className="mt-3 h-3 w-4/5 animate-pulse rounded-sm bg-raised" />
            <div className="mt-2 h-3 w-1/2 animate-pulse rounded-sm bg-raised" />
          </li>
        ))}
      </ul>
    </div>
  );
}
