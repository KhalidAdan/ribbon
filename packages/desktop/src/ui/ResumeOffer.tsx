import { useAppState, useController } from "./store";
import { Button } from "./Button";

function describeAway(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 14) return `${Math.floor(days / 7)} weeks`;
  if (days >= 2) return `${days} days`;
  return "a day";
}

/** After a long break: offer the start of the chapter, once, quietly. */
export function ResumeOffer() {
  const state = useAppState();
  const c = useController();
  const offer = state.resumeOffer;
  if (!offer) return null;
  return (
    <div className="rounded-[10px] bg-surface p-1 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-3 rounded-md bg-raised px-3 py-2.5">
        <p className="min-w-0 flex-1 text-base/6 text-pretty text-ink sm:text-sm/5">You were away for {describeAway(offer.awayMs)}. Start this chapter over?</p>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={() => c.dismissResumeOffer()}>
            Keep going
          </Button>
          <Button size="sm" onClick={() => c.restartChapter()}>
            Start it over
          </Button>
        </div>
      </div>
    </div>
  );
}
