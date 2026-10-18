import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The full player, over everything, on a native dialog: Escape and the
 * back button close it, focus stays inside, and the bar underneath keeps
 * playing. Opens from the bar; the shelf is what you come back to.
 */
export function PlayerSheet({ open, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal focuses the first control; the title is the calmer place to start.
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    else if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={(e) => {
        // React passes a nested dialog's close up the tree; only our own closes us.
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      aria-label="Player"
      className="fixed inset-0 m-0 hidden h-full max-h-none w-full max-w-none bg-canvas p-0 font-sans text-ink antialiased open:block starting:open:translate-y-4 starting:open:opacity-0 transition-[translate,opacity] duration-200 ease-out"
    >
      {open && children}
    </dialog>
  );
}
