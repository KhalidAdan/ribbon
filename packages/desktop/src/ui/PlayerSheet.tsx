import type { ReactNode } from "react";
import { useModal } from "./modal";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The full player, over everything, on a native dialog: Escape and the
 * back button close it, focus stays inside, and the bar underneath keeps
 * playing. Opens from the bar; the shelf is what you come back to. It
 * rises a little as it comes in, and sinks the same way as it goes
 * (modal.ts).
 */
export function PlayerSheet({ open, onClose, children }: Props) {
  const { ref, closing } = useModal(open);
  return (
    <dialog
      ref={ref}
      data-closing={closing || undefined}
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
      className="fixed inset-0 m-0 hidden h-full max-h-none w-full max-w-none bg-canvas safe-area font-sans text-ink antialiased open:block transition-[translate,opacity] duration-200 ease-out starting:open:opacity-0 motion-safe:starting:open:translate-y-4 data-closing:opacity-0 data-closing:duration-150 motion-safe:data-closing:translate-y-4"
    >
      {(open || closing) && children}
    </dialog>
  );
}
