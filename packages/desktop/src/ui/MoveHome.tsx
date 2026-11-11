import { fits, MOVE_HEADROOM_BYTES, type HomeMove } from "@ribbon/core/home-move";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { ProgressLine } from "./kit";
import { useKept } from "./modal";
import { formatBytes } from "./Servers";

/**
 * Moving the Ribbon folder to another place on this computer, from Settings
 * (core/home-move.ts): asked about with where it goes and how much it holds,
 * then copied with its progress, then Ribbon starts again. It can't be
 * closed half way: a copy finishes, or fails and is taken back.
 */
export function MoveHome() {
  const c = useController();
  const live = useAppState((s) => s.homeMove);
  // Redrawn as downloads come and go, which a move waits for.
  useAppState((s) => s.downloads);
  useAppState((s) => s.speech.downloading);
  const [shown, closed] = useKept(live.status === "none" ? null : live);
  if (!shown) return null;
  const open = live.status !== "none";
  const busy = shown.status === "moving" || shown.status === "restarting";
  const close = () => {
    if (live.status === "asking" || live.status === "refused") c.cancelHomeMove();
  };
  return (
    <Dialog open={open} onClose={close} onClosed={closed} labelId="move-home-title" {...content(shown)} actions={<Actions move={shown} busy={busy} />}>
      <Body move={shown} />
    </Dialog>
  );
}

/** The title and the line under it, for each step of the move. */
function content(move: Exclude<HomeMove, { status: "none" }>): { title: string; description: string } {
  switch (move.status) {
    case "asking":
      return { title: "Move the Ribbon folder?", description: "Everything in it is copied to the new place: your places, the covers, a copy of each library’s records, the books downloaded from servers and the speech model. Ribbon then starts again from there and deletes the old copy." };
    case "refused":
      return { title: "The Ribbon folder can’t go there", description: move.why };
    case "moving":
      return { title: "Moving the Ribbon folder", description: "Ribbon starts again once it’s done. Playing and transcribing have stopped until then." };
    case "failed":
      return { title: "The Ribbon folder couldn’t be moved", description: "Nothing has moved: the copy was taken back, and Ribbon starts again where it was." };
    case "restarting":
      return { title: "Moved", description: "Ribbon is starting again from its new place." };
  }
}

function Body({ move }: { move: Exclude<HomeMove, { status: "none" }> }) {
  const c = useController();
  const pad = "min-h-0 flex-1 overflow-y-auto quiet-scroll px-5 pt-4 pb-5";
  switch (move.status) {
    case "asking": {
      const { plan } = move;
      const waits = c.homeMoveWaitsFor();
      return (
        <div className={pad}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-[10px] px-3 py-2.5 ring-1 ring-line">
            <dt className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">From</dt>
            <dd className="break-all font-mono text-[0.8125rem]/5 text-ink-2">{plan.from}</dd>
            <dt className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">To</dt>
            <dd className="break-all font-mono text-[0.8125rem]/5 text-ink">{plan.to}</dd>
          </dl>
          <p className="mt-3 text-sm/5 text-pretty text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
            {formatBytes(plan.bytes)} in {plan.files.toLocaleString()} {plan.files === 1 ? "file" : "files"}; {formatBytes(plan.freeBytes)} free there.
          </p>
          {!fits(plan) && <p className="mt-2 text-sm/5 text-pretty text-ink sm:text-[0.8125rem]/5">There isn’t room for it there: it needs {formatBytes(plan.bytes + MOVE_HEADROOM_BYTES - plan.freeBytes)} more. Choose another place, or make room first.</p>}
          {waits && <p className="mt-2 text-sm/5 text-pretty text-ink sm:text-[0.8125rem]/5">{waits} Move the folder once it’s done.</p>}
        </div>
      );
    }
    case "moving":
      return (
        <div className={pad}>
          <p className="break-all font-mono text-[0.8125rem]/5 text-ink-2">{move.plan.to}</p>
          <ProgressLine fraction={move.total > 0 ? move.done / move.total : 0} className="mt-3" />
          <p className="mt-2 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">
            {formatBytes(move.done)} of {formatBytes(move.total)}
          </p>
        </div>
      );
    case "failed":
      return (
        <div className={pad}>
          <p className="text-sm/5 text-pretty break-words text-ink-2 sm:text-[0.8125rem]/5">{move.why}</p>
        </div>
      );
    case "restarting":
      return (
        <div className={pad}>
          <p className="break-all font-mono text-[0.8125rem]/5 text-ink-2">{move.to}</p>
        </div>
      );
    case "refused":
      return null;
  }
}

function Actions({ move, busy }: { move: Exclude<HomeMove, { status: "none" }>; busy: boolean }) {
  const c = useController();
  if (busy) return null;
  switch (move.status) {
    case "asking":
      return (
        <>
          <Button variant="ghost" onClick={() => c.cancelHomeMove()}>
            Cancel
          </Button>
          <Button onClick={() => void c.chooseHomePlace()}>Choose another place…</Button>
          <Button variant="primary" disabled={!fits(move.plan) || c.homeMoveWaitsFor() !== null} onClick={() => void c.moveHome()}>
            Move
          </Button>
        </>
      );
    case "refused":
      return (
        <>
          <Button variant="ghost" onClick={() => c.cancelHomeMove()}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void c.chooseHomePlace()}>
            Choose another place…
          </Button>
        </>
      );
    case "failed":
      return (
        <Button variant="primary" onClick={() => void c.restartAfterMove()}>
          Start Ribbon again
        </Button>
      );
    default:
      return null;
  }
}
