import { useEffect, useState } from "react";
import { toast } from "sonner";
import { newsSince, type ReleaseNotes } from "@ribbon/core/whats-new";
import { RELEASES } from "../whats-new";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Note } from "./Notices";

declare const __APP_VERSION__: string;

/** The version this Ribbon last started as, kept on this machine: how it knows it has been updated. */
const SEEN = "ribbon.version-seen";
/** The event that asks for the notes, from anywhere on the page (Settings has a row that does). */
const ASKED = "ribbon:whats-new";

/** Show what changed in the versions kept (src/whats-new.ts). */
export function showWhatsNew(): void {
  window.dispatchEvent(new Event(ASKED));
}

/** The version last seen, then this one remembered in its place. Null on a first run, or where nothing can be kept. */
function seenThenRemember(): string | null {
  try {
    const seen = localStorage.getItem(SEEN);
    localStorage.setItem(SEEN, __APP_VERSION__);
    return seen;
  } catch {
    return null;
  }
}

/**
 * What changed, said once after Ribbon has updated itself: a note above the
 * player, "Ribbon is now 0.54.0", with a way to the list, which leaves when
 * it's dismissed and isn't shown again. A first run says nothing. The list
 * is also under Settings, any time. The notes are part of the app, so
 * nothing is asked of the internet (core/whats-new.ts).
 */
export function WhatsNew() {
  const [showing, setShowing] = useState<readonly ReleaseNotes[] | null>(null);
  useEffect(() => {
    const news = newsSince(RELEASES, seenThenRemember(), __APP_VERSION__);
    const onAsked = () => setShowing(RELEASES);
    window.addEventListener(ASKED, onAsked);
    if (news.length > 0) {
      const id = "whats-new";
      toast.custom(
        () => (
          <Note
            title={`Ribbon is now ${__APP_VERSION__}`}
            line={news[0]!.points[0] ?? "It updated itself."}
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => toast.dismiss(id)}>
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    toast.dismiss(id);
                    setShowing(news);
                  }}
                >
                  What’s new
                </Button>
              </>
            }
          />
        ),
        { id, duration: Infinity },
      );
    }
    return () => window.removeEventListener(ASKED, onAsked);
  }, []);
  return (
    <Dialog
      open={showing !== null}
      onClose={() => setShowing(null)}
      labelId="whats-new-title"
      title="What’s new"
      description="What changed in Ribbon lately, the newest first."
      actions={
        <Button variant="primary" onClick={() => setShowing(null)}>
          Done
        </Button>
      }
    >
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pt-5 pb-6">
        {(showing ?? []).map((release) => (
          <section key={release.version} aria-labelledby={`whats-new-${release.version}`}>
            <h3 id={`whats-new-${release.version}`} className="text-sm/5 font-medium text-ink-3 tabular-nums sm:text-[0.8125rem]/5">
              Ribbon {release.version}
            </h3>
            <ul role="list" className="mt-1 divide-y divide-line">
              {release.points.map((point) => (
                <li key={point} className="py-2 text-base/6 text-pretty text-ink sm:text-sm/5">
                  {point}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
