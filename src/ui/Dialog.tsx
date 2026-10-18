import { useEffect, useRef, type ReactNode } from "react";

/**
 * A centred dialog on a native <dialog>: a title and one line about it,
 * the body, and a footer with a hint on the left and the actions on the
 * right. Escape and the close event call onClose.
 */
export function Dialog({ open, onClose, title, description, children, hint, actions, labelId }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; hint?: ReactNode; actions: ReactNode; labelId: string }) {
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
      aria-labelledby={labelId}
      className="m-auto hidden max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl flex-col rounded-[10px] bg-surface p-0 text-ink shadow-xl ring-1 ring-line backdrop:bg-black/50 open:flex starting:open:scale-[0.98] starting:open:opacity-0 transition-[scale,opacity] duration-150 ease-out dark:shadow-none dark:ring-line-strong"
    >
      <header className="shrink-0 px-5 pt-5">
        <h2 id={labelId} tabIndex={-1} data-autofocus className="text-base/6 font-semibold text-balance text-ink outline-none">
          {title}
        </h2>
        {description && <p className="mt-1 text-base/6 text-pretty text-ink-2 sm:text-sm/5">{description}</p>}
      </header>
      {children}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
        <div className="min-w-0 text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{hint}</div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </footer>
    </dialog>
  );
}
