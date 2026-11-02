import { clsx } from "clsx";
import type { ReactNode } from "react";
import { useModal } from "./modal";

/**
 * A centred dialog on a native <dialog>: a title and one line about it,
 * the body, and a footer with a hint on the left and the actions on the
 * right. Escape and the close event call onClose. It grows in from just
 * smaller, and leaves the same way (modal.ts); onClosed hears when it's gone.
 */
export function Dialog({ open, onClose, onClosed, title, description, children, hint, actions, labelId, wide = false }: { open: boolean; onClose: () => void; onClosed?: (() => void) | undefined; title: ReactNode; description?: ReactNode; children: ReactNode; hint?: ReactNode; actions: ReactNode; labelId: string; wide?: boolean }) {
  const { ref, closing } = useModal(open, { onClosed });
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
      aria-labelledby={labelId}
      className={clsx("m-auto hidden max-h-[90dvh] w-[calc(100%-2rem)] flex-col rounded-[10px] bg-surface p-0 text-ink shadow-xl ring-1 ring-line backdrop:bg-black/50 open:flex transition-[scale,opacity] duration-150 ease-out backdrop:transition-opacity backdrop:duration-150 starting:open:opacity-0 starting:open:backdrop:opacity-0 motion-safe:starting:open:scale-[0.98] data-closing:opacity-0 data-closing:backdrop:opacity-0 motion-safe:data-closing:scale-[0.98] dark:shadow-none dark:ring-line-strong", wide ? "max-w-3xl" : "max-w-xl")}
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
