import { useEffect } from "react";
import { useAppState, useController } from "./store";

/** How long the note stays before it goes on its own. */
const SHOWN_MS = 6_000;

/**
 * The daily goal just met: a small note at the top for a few seconds, as
 * Apple Books has one, never over the words being read, and the book plays
 * on. "Daily goal met. 20 minutes with your books today. 5 days in a row."
 * Once a day, when it's met here (core/goal.ts, `GoalWatch`).
 */
export function GoalMet() {
  const c = useController();
  const met = useAppState((s) => s.goalMet);
  useEffect(() => {
    if (!met) return;
    const gone = setTimeout(() => c.dismissGoalMet(), SHOWN_MS);
    return () => clearTimeout(gone);
  }, [c, met]);
  if (!met) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-4 top-3 z-50 mx-auto flex max-w-sm justify-center">
      <button
        type="button"
        onClick={() => c.dismissGoalMet()}
        className="pointer-events-auto flex items-center gap-3 rounded-[10px] bg-surface px-4 py-2.5 text-left shadow-lg ring-1 ring-line focus-ring transition-[translate,opacity] duration-300 starting:-translate-y-2 starting:opacity-0"
      >
        <span className="size-2 shrink-0 rounded-full bg-place" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-base/6 font-medium text-ink sm:text-sm/5">Daily goal met</span>
          <span className="block text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">{goalLine(met.minutes, met.streakDays)}</span>
        </span>
      </button>
    </div>
  );
}

/** "20 minutes with your books today. 5 days in a row." */
export function goalLine(minutes: number, streakDays: number): string {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} with your books today.${streakDays > 1 ? ` ${streakDays} days in a row.` : ""}`;
}
