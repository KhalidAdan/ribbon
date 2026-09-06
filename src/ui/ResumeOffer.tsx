import { useAppState, useController } from "./store";
import { Button } from "./Button";

function describeAway(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 14) return `${Math.floor(days / 7)} weeks`;
  if (days >= 2) return `${days} days`;
  return "a day";
}

export function ResumeOffer() {
  const state = useAppState();
  const c = useController();
  const offer = state.resumeOffer;
  if (!offer) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-neutral-950/5 p-4 sm:flex-row sm:items-center dark:bg-white/5">
      <p className="min-w-0 flex-1 text-base/6 text-pretty text-neutral-950 sm:text-sm/6 dark:text-white">You were away for {describeAway(offer.awayMs)}. Start this chapter over?</p>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" onClick={() => c.restartChapter()}>
          Restart chapter
        </Button>
        <Button size="sm" variant="ghost" onClick={() => c.dismissResumeOffer()}>
          Keep going
        </Button>
      </div>
    </div>
  );
}
