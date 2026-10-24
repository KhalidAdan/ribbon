import { useEffect, useRef, useState } from "react";

/**
 * How long a closing dialog waits for its way out to finish before it
 * closes anyway: a hidden or covered window runs no transitions, so their
 * end may never come.
 */
const LEAVE_WITHIN_MS = 250;

/** Open a dialog as a modal, with the focus on its title: showModal focuses the first control, and the title is the calmer place to start. */
export function showModal(el: HTMLDialogElement): void {
  el.showModal();
  el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
}

/**
 * A native <dialog> opened and closed by `open`, that leaves the way it
 * came. Asked to close, it's marked `closing` first, which the dialog
 * shows as `data-closing`: its entrance in reverse, a little quicker. It
 * closes for real when that's over. Meanwhile what it holds stays drawn,
 * so it doesn't go blank on its way out; opened again before it's gone, it
 * simply comes back. `show` opens it (`showModal` unless the dialog needs
 * more, as a drawer inside another dialog does).
 */
export function useModal(open: boolean, show: (el: HTMLDialogElement) => void = showModal) {
  const ref = useRef<HTMLDialogElement>(null);
  // Shown from opening until it has closed for real. Closing is worked out
  // from it as it renders, not set afterwards, so the render that takes
  // `open` away already keeps what the dialog holds, for its way out.
  const [shown, setShown] = useState(false);
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      setShown(true);
      if (!el.open) showRef.current(el);
      return;
    }
    if (!el.open) return;
    let gone = false;
    const close = () => {
      if (gone) return;
      gone = true;
      el.close();
      setShown(false);
    };
    // Its own transition, not one inside it (a button's press, a cover fading in).
    const ended = (e: TransitionEvent) => {
      if (e.target === el) close();
    };
    el.addEventListener("transitionend", ended);
    const timer = setTimeout(close, LEAVE_WITHIN_MS);
    return () => {
      el.removeEventListener("transitionend", ended);
      clearTimeout(timer);
    };
  }, [open]);

  return { ref, closing: shown && !open };
}
