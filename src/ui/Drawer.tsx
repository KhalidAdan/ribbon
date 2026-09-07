import { XMarkIcon } from "@heroicons/react/16/solid";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * A bottom sheet on a native dialog: focus is trapped, Escape closes,
 * the backdrop closes, and screen readers see a modal. It rises from
 * the bottom edge and is at most 85% of the viewport tall, so the
 * player stays in view behind it.
 */
export function Drawer({ open, onClose, title, children }: Props) {
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
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
      className="fixed inset-x-0 top-auto bottom-0 m-0 mx-auto hidden max-h-[85dvh] open:flex w-full max-w-lg flex-col rounded-t-2xl bg-white p-0 text-neutral-950 shadow-2xl ring-1 ring-neutral-950/10 transition-transform duration-200 ease-out backdrop:bg-neutral-950/40 backdrop:backdrop-blur-sm open:translate-y-0 starting:open:translate-y-full dark:bg-neutral-900 dark:text-white dark:ring-white/10"
    >
      <div className="flex shrink-0 flex-col items-center px-4 pt-2">
        <span className="mb-2 h-1 w-10 rounded-full bg-neutral-950/15 dark:bg-white/20" aria-hidden="true" />
        <div className="flex w-full items-center">
          <span className="size-9" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 truncate text-center text-base/6 font-semibold sm:text-sm/6">{title}</h2>
          <Button icon size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <XMarkIcon className="size-4 fill-current" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">{open && children}</div>
    </dialog>
  );
}
