import { MoonIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { formatDuration } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";

const MINUTES = [15, 30, 45, 60];

/** The sleep timer as one row: the choices, or what is left with a way to add time or stop. */
export function SleepControl() {
  const state = useAppState();
  const c = useController();
  const s = state.sleep;
  const active = s.state.mode !== null;
  const left = s.state.mode?.kind === "chapter" ? "At the end of this chapter" : s.remainingMs !== null ? `${formatDuration(s.remainingMs)} left` : "On";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <MoonIcon className={clsx("size-4 shrink-0", active ? "fill-ink" : "fill-ink-3")} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-base/6 font-medium text-ink sm:text-sm/5">Sleep timer</p>
          <p className="text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5" aria-live="polite">
            {active ? `${left}${s.gain < 1 ? ", fading out" : ""}` : "Fades out, and stops at a chapter's end if you like."}
          </p>
        </div>
      </div>
      {active ? (
        <div className="flex gap-1">
          <Button size="sm" onClick={() => c.extendSleep(15 * 60_000)}>
            +15 min
          </Button>
          <Button size="sm" variant="ghost" onClick={() => c.cancelSleep()}>
            Turn off
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Sleep timer">
          {MINUTES.map((m) => (
            <Button key={m} size="sm" variant="ghost" onClick={() => c.startSleep({ kind: "duration", ms: m * 60_000 })} className="tabular-nums">
              {m}m
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => c.startSleep({ kind: "chapter" })}>
            Chapter end
          </Button>
        </div>
      )}
    </div>
  );
}
