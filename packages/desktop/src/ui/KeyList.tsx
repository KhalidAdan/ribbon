import type { ReactNode } from "react";
import { keyCaps, type KeyGroup } from "@ribbon/core/comic/keys";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Kbd } from "./kit";

/**
 * A list of keys in a dialog, grouped by what they're for: Ribbon's own
 * (ui/AppKeys.tsx) and the comic reader's (comic/ComicDialogs.tsx). Each
 * line says what happens first, since that is what a person looks for, and
 * the keys that do it on the right; keys that do the same are side by side,
 * keys held together are joined by a plus.
 */
export function KeyList({ open, onClose, id, description, hint, groups }: { open: boolean; onClose: () => void; id: string; description: string; hint?: ReactNode; groups: KeyGroup[] }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelId={`${id}-title`}
      title="Keys"
      description={description}
      hint={hint}
      wide
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="grid min-h-0 gap-x-10 gap-y-6 overflow-y-auto px-5 pt-5 pb-6 sm:grid-cols-2">
        {groups.map((group, i) => (
          <section key={group.title} aria-labelledby={`${id}-${i}`} className="flex flex-col gap-1">
            <h3 id={`${id}-${i}`} className="text-sm/5 font-medium text-ink-3 sm:text-[0.8125rem]/5">
              {group.title}
            </h3>
            <dl className="divide-y divide-line">
              {group.lines.map((line) => (
                <div key={line.does} className="flex items-center justify-between gap-4 py-2">
                  <dt className="min-w-0 text-base/6 text-ink sm:text-sm/5">{line.does}</dt>
                  <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    {line.keys.map((key) => (
                      <KeyCaps key={key} keyName={key} />
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
            {group.note && <p className="pt-1 text-sm/5 text-ink-3 sm:text-xs/4">{group.note}</p>}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/** One key, or keys held together, as caps: "Shift+Space" is two caps with a plus between them. */
function KeyCaps({ keyName }: { keyName: string }) {
  const caps = keyCaps(keyName);
  return (
    <span className="inline-flex items-center gap-0.5">
      {caps.map((cap, i) => (
        <span key={cap} className="inline-flex items-center gap-0.5">
          {i > 0 && (
            <span className="text-xs/4 text-ink-3" aria-hidden="true">
              +
            </span>
          )}
          <Kbd>{cap}</Kbd>
        </span>
      ))}
    </span>
  );
}
