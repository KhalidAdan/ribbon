import { MinusIcon, PlusIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { SPEED_STEP, formatLeft, formatSpeed, remainingAtSpeed } from "../core/speed";
import { useAppState, useController } from "./store";
import { IconButton } from "./Button";
import { Group, Row, Toggle } from "./kit";

const PRESETS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

/** Speed for this book: a stepper, the usual choices, and how long the book is at each. */
export function SpeedControl() {
  const state = useAppState();
  const c = useController();
  const p = state.player;
  const speed = p.speed;
  const left = p.durationMs - p.positionMs;
  const trim = state.current?.settings.trimSilence ?? false;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <IconButton variant="secondary" label="Slower" icon={MinusIcon} onClick={() => void c.setSpeed(speed - SPEED_STEP)} />
        <div className="text-center">
          <p className="text-2xl font-semibold text-ink tabular-nums" aria-live="polite">
            {formatSpeed(speed)}
          </p>
          <p className="text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{formatLeft(remainingAtSpeed(left, speed))} left at this speed</p>
        </div>
        <IconButton variant="secondary" label="Faster" icon={PlusIcon} onClick={() => void c.setSpeed(speed + SPEED_STEP)} />
      </div>
      <Group label="Choices">
        <div className="grid grid-cols-4 gap-1" role="group" aria-label="Speed choices">
          {PRESETS.map((s) => {
            const on = Math.abs(speed - s) < 0.001;
            return (
              <button
                key={s}
                type="button"
                onClick={() => void c.setSpeed(s)}
                aria-pressed={on}
                className={clsx("rounded-md py-2 text-center focus-ring", on ? "bg-primary text-on-primary" : "bg-raised text-ink hover:bg-line")}
              >
                <span className="block text-base/6 font-medium tabular-nums sm:text-sm/5">{formatSpeed(s)}</span>
                <span className={clsx("block text-xs/4 tabular-nums", on ? "opacity-70" : "text-ink-3")}>{formatLeft(remainingAtSpeed(left, s)).replace(/ \d+m$/, "")}</span>
              </button>
            );
          })}
        </div>
      </Group>
      <Group footer="Off unless you turn it on. Speech stays at its own pace; only the gaps get shorter.">
        <Row title="Trim silences" description="Pauses longer than a second become about half a second." aside={<Toggle label="Trim silences" checked={trim} onChange={(on) => void c.setTrimSilence(on)} />} />
      </Group>
    </div>
  );
}
