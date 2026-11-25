import { useEffect, useRef, useState } from "react";
import { keyList } from "@ribbon/core/comic/keys";
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
  const go = () => {
    if (to === null) return;
    onGo(to);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelId="comic-jump-title"
      title="Go to page"
      description={`A page from 1 to ${count}.`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
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

/** The reader's keys (`?`, or "Keys…" in the Pages menu), with the arrows the way the open comic reads (core/comic/keys.ts). */
export function ComicKeyList({ open, rightToLeft, onClose }: { open: boolean; rightToLeft: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelId="comic-keys-title"
      title="Keys"
      description={rightToLeft ? "This comic reads right to left, and the arrows go with it." : undefined}
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <dl className="grid min-h-0 grid-cols-[auto_1fr] gap-x-5 gap-y-2 overflow-y-auto px-5 pt-4 pb-5 text-base/6 sm:text-sm/5">
        {keyList(rightToLeft).map((line) => (
          <div key={line.does} className="contents">
            <dt className="flex flex-wrap items-center gap-1">
              {line.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd className="text-ink-2">{line.does}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
