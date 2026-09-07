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
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      aria-label="Player"
      className="fixed inset-0 m-0 hidden h-full max-h-none w-full max-w-none bg-white p-0 text-neutral-950 open:block dark:bg-neutral-950 dark:text-white"
    >
      {open && children}
    </dialog>
  );
}
