import { MoonIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { formatDuration } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";

const MINUTES = [15, 30, 45, 60];

export function SleepControl() {
  const state = useAppState();
  const c = useController();
  const s = state.sleep;
  const active = s.state.mode !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-base/6 text-neutral-600 sm:text-sm/6 dark:text-neutral-400">
        <MoonIcon className="size-4 shrink-0 fill-current" />
        Sleep
      </span>
      {active ? (
        <>
          <span className="text-base/6 font-medium text-neutral-950 tabular-nums sm:text-sm/6 dark:text-white" aria-live="polite">
            {s.state.mode?.kind === "chapter" ? "End of chapter" : s.remainingMs !== null ? formatDuration(s.remainingMs) : "…"}
            {s.gain < 1 ? " · fading" : ""}
          </span>
          <Button size="sm" onClick={() => c.extendSleep(15 * 60_000)}>
            +15 min
          </Button>
          <Button icon size="sm" variant="ghost" aria-label="Cancel sleep timer" onClick={() => c.cancelSleep()}>
            <XMarkIcon className="size-4 fill-current" />
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Sleep timer">
          {MINUTES.map((m) => (
            <Button key={m} size="sm" variant="ghost" onClick={() => c.startSleep({ kind: "duration", ms: m * 60_000 })}>
              {m} min
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => c.startSleep({ kind: "chapter" })}>
            End of chapter
          </Button>
        </div>
      )}
    </div>
  );
}
