import type { AppState } from "../app/controller";
import { Button } from "./Button";
import { ProgressLine } from "./kit";

type Wait = NonNullable<AppState["readAlongWait"]>;

/** How long the wait has left, as people say it. */
function left(ms: number | null): string {
  if (ms === null) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute left";
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}${rest >= 5 ? ` ${rest} minutes` : ""} left`;
}

/** The player bar's line while a book's playback waits for its read-along. */
export function readAlongLine(w: Wait): string {
  return `Read-along getting ready · ${Math.floor((w.done / Math.max(1, w.total)) * 100)}%`;
}

/**
 * Over the page while a book's playback waits for its read-along (Settings,
 * "Wait for read-along before playing"): how far the transcribing has got,
 * how long is left, and the way out.
 */
export function ReadAlongWaitCard({ wait, onPlayAnyway }: { wait: Wait; onPlayAnyway: () => void }) {
  const fraction = wait.done / Math.max(1, wait.total);
  const rest = left(wait.leftMs);
  return (
    <div role="status" className="pointer-events-auto w-full max-w-md rounded-[10px] bg-surface p-3 pl-4 shadow-lg ring-1 ring-line dark:shadow-none dark:ring-line-strong">
      <p className="flex items-baseline justify-between gap-3 text-base/6 text-ink sm:text-sm/5">
        <span className="font-medium">Getting read-along ready</span>
        <span className="shrink-0 text-ink-3 tabular-nums">
          {Math.floor(fraction * 100)}%{rest ? ` · ${rest}` : ""}
        </span>
      </p>
      <p className="mt-0.5 text-base/6 text-pretty text-ink-2 sm:text-sm/5">Ribbon is transcribing the narration on this computer, once, so the text can follow every sentence. Playback waits until it’s done.</p>
      <ProgressLine fraction={fraction} className="mt-2.5" />
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={onPlayAnyway}>
          Play anyway
        </Button>
      </div>
    </div>
  );
}
