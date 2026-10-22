import { ChevronLeftIcon, ChevronRightIcon, ListBulletIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type SVGProps } from "react";
import type { AppController } from "../app/controller";
import type { BookText, TextPlace } from "../core/reading/booktext";
import { IconButton } from "../ui/Button";
import { Menu, type MenuItem } from "../ui/kit";
import { PlayButton } from "../ui/PlayerBar";
import { useAppState } from "../ui/store";
import { useListening, type Visible } from "./listening";

/** A place as the page number counts it: its page in the whole book once every chapter is laid out, how far through until then. */
export type Folio = { page: number; of: number } | { percent: number };

/**
 * The reader on a phone (docs/READING.md, section 6): the page is the
 * book's, and this is its one control. On the left, under the text, the
 * page number, or, while the narrator reads on another page, where it is,
 * which goes back to it. On the right, the capsule:
 *
 * - reading, with nothing playing: the contents and the menu;
 * - this book's audio loaded: the listening bar. Back, play, forward, the
 *   menu. A swipe up opens the full player;
 * - another book playing: its play button and its title, then the menu.
 *
 * The controls are 40px, as big as a thumb sees them, 4px apart. Under a
 * finger each is a 48px target (IconButton) that reaches only into the
 * gaps beside it, never over its neighbour.
 */
export function Dock({ bookId, text, visible, place, folioAt, inset, title, menu, onContents, c }: { bookId: string; text: BookText | null; visible: Visible | null; place: TextPlace | null; folioAt: ((p: TextPlace) => Folio) | null; inset: number; title: string; menu: MenuItem[]; onContents: (() => void) | null; c: AppController }) {
  const n = useListening(bookId, text, visible, c);
  const mode = n.here ? "bar" : n.loaded ? "other" : "menu";
  const own = place && folioAt ? folioAt(place) : null;

  // The narrator reading on another page while the page doesn't follow it: where it is, in the page number's own terms,
  // and which way. Paused, the page number stays: the reader is reading.
  const away = n.here && n.playing && !n.onPage && !n.following;
  const narrator = useAppState(() => {
    if (!away || !text || !visible || !folioAt) return null;
    const p = c.narratorInText();
    return p ? { ...folioAt(p), behind: text.chars(p) < text.chars(visible.from) } : null;
  });

  // The capsule grows into the bar and back from one width to the other, rather than jumping.
  const capsule = useRef<HTMLDivElement>(null);
  const shape = useRef<{ mode: string; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = capsule.current;
    if (!el) return;
    const was = shape.current;
    shape.current = { mode, width: el.offsetWidth };
    if (!was || was.mode === mode || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.style.overflow = "hidden";
    el.animate([{ width: `${was.width}px` }, { width: `${el.offsetWidth}px` }], { duration: 240, easing: "cubic-bezier(.2, .8, .2, 1)" }).onfinish = () => (el.style.overflow = "");
  });

  // A swipe up the capsule opens the full player, as a phone's own players do. The button the swipe began on is then not pressed.
  // The swipe is followed at the window: a finger's moves stay with what it touched, a mouse's leave with it.
  const swiped = useRef(false);
  const lift = mode === "menu" ? {} : {
    onPointerDown: (e: ReactPointerEvent) => {
      swiped.current = false;
      const { pointerId: id, clientX: x0, clientY: y0 } = e;
      const move = (m: PointerEvent) => {
        if (m.pointerId !== id) return;
        const dy = m.clientY - y0;
        if (dy < -24 && -dy > Math.abs(m.clientX - x0)) {
          swiped.current = true;
          done();
          c.expandPlayer();
        }
      };
      const done = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", done);
        removeEventListener("pointercancel", done);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", done);
      addEventListener("pointercancel", done);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!swiped.current) return;
      swiped.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };

  return (
    <div className="flex h-16 shrink-0 items-center justify-between gap-2" style={{ paddingInline: inset }}>
      {narrator ? (
        // On a narrow phone with a long book, the words give way before the page number does.
        <button
          type="button"
          onClick={() => void c.goToNarrator()}
          disabled={n.finding}
          aria-busy={n.finding || undefined}
          aria-label={"page" in narrator ? `Narrator on ${narrator.page}` : `Narrator at ${narrator.percent}%`}
          className="flex h-11 min-w-0 items-center gap-0.5 rounded-md text-[0.8125rem]/5 font-medium whitespace-nowrap text-ink tabular-nums focus-ring active:opacity-60 disabled:opacity-40"
        >
          {narrator.behind && <ChevronLeftIcon className="-ml-1 size-4 shrink-0 fill-current text-ink-2" aria-hidden="true" />}
          <span className="min-w-0 truncate">{"page" in narrator ? "Narrator on" : "Narrator at"}</span>
          <span className="ml-0.5 shrink-0">{"page" in narrator ? narrator.page : `${narrator.percent}%`}</span>
          {!narrator.behind && <ChevronRightIcon className="-mr-1 size-4 shrink-0 fill-current text-ink-2" aria-hidden="true" />}
        </button>
      ) : (
        <p className="min-w-0 text-[0.8125rem]/5 font-medium whitespace-nowrap text-ink-2 tabular-nums">{!own ? "" : "page" in own ? `${own.page} of ${own.of}` : `${own.percent}%`}</p>
      )}
      <div
        ref={capsule}
        role={mode === "menu" ? undefined : "group"}
        aria-label={mode === "menu" ? undefined : "Listening. Swipe up for the player"}
        className={clsx("flex h-12 items-center gap-1 rounded-[10px] bg-surface px-0.5 ring-1 ring-line dark:ring-line-strong", mode === "other" ? "min-w-0" : "shrink-0", mode !== "menu" && "touch-none")}
        {...lift}
      >
        {mode === "menu" && onContents && <IconButton className="size-10" glyph="size-5" label="Contents" icon={ListBulletIcon} onClick={onContents} />}
        {mode === "bar" && (
          <>
            <IconButton className="size-10" glyph="size-6" label="Back 30 seconds" icon={Back30} onClick={() => c.skip(-30_000)} />
            <PlayButton size="dock" />
            <IconButton className="size-10" glyph="size-6" label="Forward 30 seconds" icon={Forward30} onClick={() => c.skip(30_000)} />
            <span className="h-5 w-px shrink-0 bg-line-strong" aria-hidden="true" />
          </>
        )}
        {mode === "other" && (
          <>
            <PlayButton size="dock" />
            <span className="min-w-0 truncate border-r border-line-strong px-2.5 text-[0.8125rem]/5 font-medium text-ink-2">
              {n.playing ? "Playing " : "Paused, "}
              {n.title}
            </span>
          </>
        )}
        <Menu label="Menu" title={title} size="dock" items={menu} />
      </div>
    </div>
  );
}

/** Back thirty seconds: a circling arrow around the number, as phones draw it. */
function Back30(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" {...props}>
      <path d="M10 3.5a6.5 6.5 0 1 1-6.3 4.9" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <path d="M10.4 1.7 8.6 3.5l1.8 1.8" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      <text x="10" y="12.8" textAnchor="middle" fontSize="7" fontWeight="650" fontFamily="inherit">
        30
      </text>
    </svg>
  );
}

function Forward30(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" {...props}>
      <path d="M10 3.5a6.5 6.5 0 1 0 6.3 4.9" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <path d="M9.6 1.7l1.8 1.8-1.8 1.8" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      <text x="10" y="12.8" textAnchor="middle" fontSize="7" fontWeight="650" fontFamily="inherit">
        30
      </text>
    </svg>
  );
}
