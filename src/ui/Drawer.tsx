import { XMarkIcon } from "@heroicons/react/16/solid";
import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./Button";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * A panel on a native dialog: focus is trapped, Escape and the backdrop
 * close it, and screen readers see a modal. On a wide window it is a
 * column along the right edge, so the player stays in view beside it;
 * on a narrow one it rises from the bottom.
 */
export function Drawer({ open, onClose, title, children }: Props) {
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
      className="fixed inset-x-0 top-auto bottom-0 m-0 hidden max-h-[85dvh] w-full max-w-none flex-col rounded-t-[10px] bg-surface p-0 text-ink ring-1 ring-line backdrop:bg-black/40 open:flex sm:inset-y-0 sm:right-0 sm:left-auto sm:h-dvh sm:max-h-none sm:w-[26rem] sm:rounded-none sm:ring-0 sm:border-l sm:border-line starting:open:max-sm:translate-y-full starting:open:sm:translate-x-8 starting:open:sm:opacity-0 transition-[translate,opacity] duration-200 ease-out"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4">
        <h2 tabIndex={-1} data-autofocus className="min-w-0 flex-1 truncate text-base/6 font-semibold text-ink outline-none sm:text-sm/5">{title}</h2>
        <IconButton size="sm" label="Close" icon={XMarkIcon} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto quiet-scroll px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{open && children}</div>
    </dialog>
  );
}
