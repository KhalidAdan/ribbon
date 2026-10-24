import { XMarkIcon } from "@heroicons/react/16/solid";
import { useRef, type ReactNode } from "react";
import { IconButton } from "./Button";
import { showModal, useModal } from "./modal";

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
 * on a narrow one it rises from the bottom, with a margin to the
 * screen's sides. It leaves the way it came (modal.ts).
 */
export function Drawer({ open, onClose, title, children }: Props) {
  const openRef = useRef(open);
  openRef.current = open;
  const { ref, closing } = useModal(open, {
    show: (el) => {
      const show = () => {
        if (el.open || !el.isConnected || !openRef.current) return;
        showModal(el);
      };
      // Opened together with the dialog around it (the player and its chapters
      // at once), React runs this effect first: wait for that one to open, or
      // this panel lands underneath it, open but out of reach.
      const parent = el.parentElement?.closest("dialog");
      if (parent && !parent.open) queueMicrotask(show);
      else show();
    },
  });

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
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
      className="fixed inset-x-2 top-auto bottom-0 m-0 hidden max-h-[85dvh] w-auto max-w-none flex-col rounded-t-[10px] bg-surface p-0 text-ink ring-1 ring-line backdrop:bg-black/40 open:flex sm:inset-y-0 sm:right-0 sm:left-auto sm:h-dvh sm:max-h-none sm:w-[26rem] sm:rounded-none sm:ring-0 sm:border-l sm:border-line transition-[translate,opacity] duration-200 ease-out backdrop:transition-opacity backdrop:duration-150 starting:open:backdrop:opacity-0 data-closing:duration-150 data-closing:backdrop:opacity-0 motion-safe:starting:open:max-sm:translate-y-full motion-safe:starting:open:sm:translate-x-8 starting:open:sm:opacity-0 motion-safe:data-closing:max-sm:translate-y-full motion-safe:data-closing:sm:translate-x-8 data-closing:sm:opacity-0 motion-reduce:starting:open:opacity-0 motion-reduce:data-closing:opacity-0"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4">
        <h2 tabIndex={-1} data-autofocus className="min-w-0 flex-1 truncate text-base/6 font-semibold text-ink outline-none sm:text-sm/5">{title}</h2>
        <IconButton size="sm" label="Close" icon={XMarkIcon} onClick={onClose} />
      </div>
      {/* Sized by what it holds, up to the drawer's height, then scrolling. A zero basis (flex-1) collapses it to nothing in WebKit when the drawer rises from the bottom, where its height is not set. */}
      <div className="min-h-0 flex-auto overflow-y-auto quiet-scroll px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{(open || closing) && children}</div>
    </dialog>
  );
}
