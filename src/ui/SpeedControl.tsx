import { MinusIcon, PlusIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { SPEED_STEP, formatSpeed } from "../core/speed";
import { useAppState, useController } from "./store";
import { Button } from "./Button";

const PRESETS = [1, 1.25, 1.5, 1.75, 2];

export function SpeedControl() {
  const state = useAppState();
  const c = useController();
  const speed = state.player.speed;
  const trim = state.current?.settings.trimSilence ?? false;
  return (
    <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-base/6 text-neutral-600 sm:text-sm/6 dark:text-neutral-400">Speed</span>
      <div className="flex items-center gap-1">
        <Button icon size="sm" variant="ghost" aria-label="Slower" onClick={() => void c.setSpeed(speed - SPEED_STEP)}>
          <MinusIcon className="size-4 fill-current" />
        </Button>
        <span className="w-12 text-center text-base/6 font-medium text-neutral-950 tabular-nums sm:text-sm/6 dark:text-white" aria-live="polite">
          {formatSpeed(speed)}
        </span>
        <Button icon size="sm" variant="ghost" aria-label="Faster" onClick={() => void c.setSpeed(speed + SPEED_STEP)}>
          <PlusIcon className="size-4 fill-current" />
        </Button>
      </div>
      <div className="flex gap-1" role="group" aria-label="Speed presets">
        {PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void c.setSpeed(s)}
            aria-pressed={Math.abs(speed - s) < 0.001}
            className={clsx(
              "rounded-md px-2 py-1 text-sm/5 tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
              Math.abs(speed - s) < 0.001 ? "bg-neutral-950/10 text-neutral-950 dark:bg-white/15 dark:text-white" : "text-neutral-500 hover:bg-neutral-950/5 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white",
            )}
          >
            {formatSpeed(s)}
          </button>
        ))}
      </div>
    </div>
    <label htmlFor="trim-silence" className="flex cursor-pointer items-start gap-3">
      <input
        id="trim-silence"
        type="checkbox"
        role="switch"
        checked={trim}
        onChange={(e) => void c.setTrimSilence(e.target.checked)}
        className="mt-1 size-4 shrink-0 accent-amber-500"
      />
      <span>
        <span className="block text-base/6 text-neutral-950 sm:text-sm/6 dark:text-white">Trim silences</span>
        <span className="block text-sm/5 text-pretty text-neutral-500 dark:text-neutral-400">Shorten pauses longer than a second to about half a second. Off unless you turn it on.</span>
      </span>
    </label>
    </div>
  );
}
