import { useEffect, useRef, useState } from "react";
import { keyCaps, keyGroups } from "@ribbon/core/comic/keys";
import { pageTyped } from "@ribbon/core/comic/zoom";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/kit";

/**
 * "Go to page" (docs/COMICS.md, section 15): `G`, or the Pages menu. A
 * small box with the page being read in it, chosen, so a number typed
 * takes its place; Enter goes, and a number past either end goes to that
 * end. Escape closes it.
 */
export function JumpToPage({ open, page, count, onGo, onClose }: { open: boolean; page: number; count: number; onGo: (page: number) => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // The dialog has opened and put the focus on its title by the time this runs. The page's number goes in the box,
  // and once it is there (the next task, after React has drawn it), the box takes the focus with the number chosen.
  useEffect(() => {
    if (!open) return;
    setTyped(String(page + 1));
    const chosen = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
    return () => clearTimeout(chosen);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = pageTyped(typed, count);
  // The box gives up the keys as it goes, so the reader has them back at once, not when the box has faded out.
  const close = () => {
    input.current?.blur();
    onClose();
  };
  const go = () => {
    if (to === null) return;
    onGo(to);
    close();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      labelId="comic-jump-title"
      title="Go to page"
      description={`A page from 1 to ${count}.`}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={to === null} onClick={go}>
            Go
          </Button>
        </>
      }
    >
      <form
        className="px-5 pt-4 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <label htmlFor="comic-jump-page" className="sr-only">
          Page
        </label>
        <input
          ref={input}
          id="comic-jump-page"
          name="comic-jump-page"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full rounded-md bg-raised px-3 py-1.5 text-base/6 text-ink tabular-nums ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6"
        />
      </form>
    </Dialog>
  );
}

/**
 * The reader's keys (`?`, or "All keys…" under View), grouped by what
 * they're for, with the arrows the way the open comic reads
 * (core/comic/keys.ts). Each line says what happens first, since that is
 * what a person looks for, and the keys that do it on the right; keys
 * that do the same are side by side, keys held together are joined by a
 * plus.
 */
export function ComicKeyList({ open, rightToLeft, onClose }: { open: boolean; rightToLeft: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelId="comic-keys-title"
      title="Keys"
      description={rightToLeft ? "This comic reads right to left, so the arrows do too." : "For reading a comic. The arrows go the way it reads."}
      hint={
        <span className="inline-flex items-center gap-1.5">
          Press <Kbd>?</Kbd> to see them again.
        </span>
      }
      wide
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="grid min-h-0 gap-x-10 gap-y-6 overflow-y-auto px-5 pt-5 pb-6 sm:grid-cols-2">
        {keyGroups(rightToLeft).map((group, i) => (
          <section key={group.title} aria-labelledby={`comic-keys-${i}`} className="flex flex-col gap-1">
            <h3 id={`comic-keys-${i}`} className="text-sm/5 font-medium text-ink-3 sm:text-[0.8125rem]/5">
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
