import { clsx } from "clsx";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { transcribingIn, type AppState, type Notice } from "../app/controller";
import { offersRestart } from "../app/updates";
import { Button } from "./Button";
import { useAppState, useController } from "./store";
import { isPlaying } from "@ribbon/core/playback";

/** How long a note that asks nothing of you stays before it goes on its own. Hovering over it holds it. */
const BRIEF_MS = 6_000;

/** The toaster at the top, for notes that ask nothing of you; the one at the bottom has no name. */
const TOP = "top";

/** Where the top notes sit, over the top bar's middle; and the bottom ones, above the player bar. Both clear an iPhone's notch and home indicator. */
const TOP_GAP = "calc(env(safe-area-inset-top) + 0.75rem)";
const BOTTOM_GAP = "calc(env(safe-area-inset-bottom) + 5rem)";

/**
 * Every note Ribbon puts over the page, drawn by Sonner, which stacks them,
 * times them, holds them while the pointer is over them, lets a phone swipe
 * them away and has a screen reader say them.
 *
 * The controller keeps what's true (`error`, `speechNudge`, `update`,
 * `goalMet`, `notices`); this shows each as a toast, and tells the
 * controller when one goes. They come in two places. At the top, for a few
 * seconds, what asks nothing of you: the daily goal met, a book's
 * transcribing begun or done. At the bottom, above the player, until you
 * answer, what does: an error, the offer of a speech model, a new version of
 * Ribbon ready to restart into, a book that couldn't be transcribed. Every
 * note shows whole, one above another, rather than tucked behind the newest
 * as Sonner stacks them by default: a note you can't read is easy to miss.
 */
export function Notices() {
  const c = useController();
  const { error, nudge, restart, goalMet, notices } = useAppState((s) => ({ error: s.error, nudge: s.speechNudge, restart: restartOffered(s), goalMet: s.goalMet, notices: s.notices }));

  // An error, until it's dismissed or put right; a new one takes its place.
  useNoteWhile(
    "error",
    error,
    (message, id, gone) =>
      toast.custom(
        () => (
          <Note
            alert
            line={message}
            actions={
              <Button size="sm" variant="ghost" onClick={() => c.clearError()}>
                Dismiss
              </Button>
            }
          />
        ),
        { id, duration: Infinity, onDismiss: gone },
      ),
    () => c.clearError(),
  );

  // Said once per computer, the first time a book with both its text and its audio opens without a speech model.
  useNoteWhile(
    "speech-nudge",
    nudge || null,
    (_, id, gone) =>
      toast.custom(
        () => (
          <Note
            title="Read along sentence by sentence"
            line={`With a speech model, Ribbon matches the narration to the text on ${c.here}, sentence by sentence; without one, only chapter by chapter. About 190 MB, downloaded once. Nothing is sent anywhere.`}
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => c.dismissSpeechNudge()}>
                  Not now
                </Button>
                <Button size="sm" variant="primary" onClick={() => void c.downloadSpeechModelFromNudge()}>
                  Download
                </Button>
              </>
            }
          />
        ),
        { id, duration: Infinity, onDismiss: gone },
      ),
    () => c.dismissSpeechNudge(),
  );

  // A new version of Ribbon, downloaded: offered while restarting would cut nothing short, and gone while a book plays or
  // a book is transcribed (app/updates.ts). "Later" puts it off for the session; closing Ribbon installs it regardless.
  useNoteWhile(
    "update",
    restart,
    (version, id, gone) =>
      toast.custom(
        () => (
          <Note
            title={`Ribbon ${version} is ready`}
            line="Restart to update now, or it updates the next time you close Ribbon. Your place is kept either way."
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => c.putOffUpdate()}>
                  Later
                </Button>
                <Button size="sm" variant="primary" onClick={() => void c.restartToUpdate()}>
                  Restart to update
                </Button>
              </>
            }
          />
        ),
        { id, duration: Infinity, onDismiss: gone },
      ),
    () => c.putOffUpdate(),
  );

  // The daily goal just met, as Apple Books says it, once a day (core/goal.ts): the book plays on.
  useNoteWhile(
    "goal-met",
    goalMet,
    (met, id, gone) =>
      toast.custom(() => <Brief place title="Daily goal met" line={goalLine(met.minutes, met.streakDays)} onClose={() => toast.dismiss(id)} />, {
        id,
        toasterId: TOP,
        duration: BRIEF_MS,
        onDismiss: gone,
        onAutoClose: gone,
      }),
    () => c.dismissGoalMet(),
  );

  // Each transcribing note once, as it comes; the controller lets it go when its toast goes.
  const shown = useRef(new Set<number>());
  useEffect(() => {
    for (const n of notices) {
      if (shown.current.has(n.id)) continue;
      shown.current.add(n.id);
      const id = `notice-${n.id}`;
      const gone = () => c.dismissNotice(n.id);
      const { title, line } = noticeWords(n);
      if (n.what === "not-transcribed")
        toast.custom(
          () => (
            <Note
              title={title}
              line={line}
              actions={
                <Button size="sm" variant="ghost" onClick={() => toast.dismiss(id)}>
                  Dismiss
                </Button>
              }
            />
          ),
          { id, duration: Infinity, onDismiss: gone },
        );
      else toast.custom(() => <Brief title={title} line={line} onClose={() => toast.dismiss(id)} />, { id, toasterId: TOP, duration: BRIEF_MS, onDismiss: gone, onAutoClose: gone });
    }
  }, [c, notices]);

  return (
    <>
      <Toaster id={TOP} position="top-center" expand hotkey={[]} gap={8} offset={{ top: TOP_GAP }} mobileOffset={{ top: TOP_GAP, left: 16, right: 16 }} style={{ "--width": "24rem" } as CSSProperties} />
      <Toaster position="bottom-center" expand gap={8} offset={{ bottom: BOTTOM_GAP }} mobileOffset={{ bottom: BOTTOM_GAP, left: 16, right: 16 }} style={{ "--width": "32rem" } as CSSProperties} />
    </>
  );
}

/**
 * A note for one piece of the controller's state, shown while it's set: a
 * toast of its own each time it's set anew, and the controller told when
 * that toast goes (dismissed, swiped away, its time up). Sonner tells a
 * toast it has gone a moment after it goes, by when the state may have been
 * cleared and set again, so only the toast showing now may clear it.
 */
function useNoteWhile<T>(name: string, value: T | null, show: (value: T, id: string, gone: () => void) => void, clear: () => void): void {
  const showing = useRef<string | null>(null);
  const count = useRef(0);
  useEffect(() => {
    if (showing.current) toast.dismiss(showing.current);
    showing.current = null;
    if (value === null) return;
    const id = `${name}-${++count.current}`;
    showing.current = id;
    show(value, id, () => {
      if (showing.current !== id) return;
      showing.current = null;
      clear();
    });
    // What's shown follows the value alone: `show` and `clear` are made anew on every render.
  }, [value]);
}

/** The new version to offer restarting into now, or null: see `offersRestart`. */
export function restartOffered(s: AppState): string | null {
  const u = s.update;
  if (!u) return null;
  return offersRestart({ ready: u.ready, putOff: u.putOff, playing: isPlaying(s.player.status), transcribing: transcribingIn(s) !== null }) ? u.ready : null;
}

/** What a transcribing note says: a line in bold, and one under it. */
export function noticeWords(n: Notice): { title: string; line: string } {
  switch (n.what) {
    case "transcribing":
      return {
        title: `Transcribing ${n.title}`,
        line: n.forServer ? "For the server, so every device reads it along. The top bar says how far it has got." : "It reads along once its whole narration is heard.",
      };
    case "reads-along":
      return {
        title: `${n.title} reads along now`,
        line: n.forServer ? "Its transcript is on the server, so every device reads it along." : "Its whole narration is heard and found in the text.",
      };
    case "not-transcribed":
      return { title: `Couldn't transcribe ${n.title}`, line: n.why };
  }
}

/** "20 minutes with your books today. 5 days in a row." */
export function goalLine(minutes: number, streakDays: number): string {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} with your books today.${streakDays > 1 ? ` ${streakDays} days in a row.` : ""}`;
}

/** The card every note is: a surface with a hairline, as a dialog is, and a shadow only in light (docs/DESIGN.md §1). */
const card = "w-full rounded-[10px] bg-surface shadow-lg ring-1 ring-line dark:shadow-none dark:ring-line-strong";

/**
 * A note that asks something of you, until you answer: what happened, and
 * the buttons that answer it. With a title, the line beneath is muted; on
 * its own, the line is the thing to read.
 */
function Note({ title, line, actions, alert = false }: { title?: string; line: string; actions: ReactNode; alert?: boolean }) {
  return (
    <div role={alert ? "alert" : undefined} className={clsx(card, "flex flex-col gap-3 p-3 pl-4 sm:flex-row sm:items-center")}>
      <div className="min-w-0 flex-1 py-0.5">
        {title && <p className="text-base/6 font-medium text-pretty text-ink sm:text-sm/5">{title}</p>}
        <p className={clsx("text-base/6 text-pretty sm:text-sm/5", title ? "mt-0.5 text-ink-2" : "text-ink")}>{line}</p>
      </div>
      <div className="flex shrink-0 gap-1 self-end sm:self-center">{actions}</div>
    </div>
  );
}

/** A note that asks nothing, gone in a few seconds or at a click. `place` marks it with the place colour, as the daily goal is. */
function Brief({ title, line, onClose, place = false }: { title: string; line: string; onClose: () => void; place?: boolean }) {
  return (
    <button type="button" onClick={onClose} className={clsx(card, "flex items-center gap-3 px-4 py-2.5 text-left focus-ring")}>
      {place && <span className="size-2 shrink-0 rounded-full bg-place" aria-hidden="true" />}
      <span className="min-w-0">
        <span className="block text-base/6 font-medium text-pretty text-ink sm:text-sm/5">{title}</span>
        <span className="block text-sm/5 text-pretty text-ink-2 tabular-nums sm:text-[0.8125rem]/5">{line}</span>
      </span>
    </button>
  );
}
