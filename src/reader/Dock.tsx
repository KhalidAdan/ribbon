import { Bars3Icon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type SVGProps } from "react";
import type { AppController } from "../app/controller";
import type { BookText } from "../core/reading/booktext";
import { IconButton } from "../ui/Button";
import { Menu, type MenuItem } from "../ui/kit";
import { PlayButton } from "../ui/PlayerBar";
import { useListening, type Visible } from "./listening";

/**
 * The reader on a phone (docs/READING.md, section 6): the page is the
 * book's, and this is its one control. On the left, under the text, the
 * page number, with an amber dot while the narrator is on this page and a
 * ring when it is on another. On the right, the capsule:
 *
 * - reading, with nothing playing: only the menu;
 * - this book's audio loaded: the listening bar. Back, play, forward; the
 *   narrator's two buttons (follow it, or listen from the top of this
 *   page); the menu. A swipe up opens the full player;
 * - another book playing: its play button and its title, then the menu.
 */
export function Dock({ bookId, text, visible, folio, inset, listen, title, menu, c }: { bookId: string; text: BookText | null; visible: Visible | null; folio: string; inset: number; listen: boolean; title: string; menu: MenuItem[]; c: AppController }) {
  const n = useListening(bookId, text, visible, c);
  const mode = n.here ? "bar" : n.loaded ? "other" : "menu";
  const away = n.here && !n.onPage;
  const dot = n.here && n.playing ? (n.following || n.onPage ? "on" : "away") : null;

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

  // One button for the narrator, as a map's location button: filled while the page follows it, a ring when it is on another page (tap to go back to it).
  const follow = !listen
    ? { label: "Follow along, once read-along is ready", icon: FollowGlyph, onClick: undefined }
    : away
      ? { label: "Go to the narrator", icon: NarratorAwayGlyph, onClick: () => void c.goToNarrator() }
      : n.following
        ? { label: "Following along. Stop following", icon: FollowingGlyph, onClick: () => c.setFollowing(false) }
        : { label: "Follow along", icon: FollowGlyph, onClick: () => void c.goToNarrator() };

  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3" style={{ paddingInline: inset }}>
      <p className="flex min-w-0 items-center text-[0.8125rem]/5 font-medium whitespace-nowrap text-ink-2 tabular-nums">
        <span aria-hidden="true" className={clsx("h-1.5 shrink-0 rounded-full transition-[width,margin] duration-200", dot ? "mr-2 w-1.5" : "w-0", dot === "on" ? "bg-place motion-safe:animate-pulse" : dot === "away" ? "ring-[1.5px] ring-place ring-inset" : "")} />
        {folio}
      </p>
      <div className={clsx("flex min-w-0 justify-end", mode === "bar" && "flex-1")}>
        <div
          ref={capsule}
          role={mode === "menu" ? undefined : "group"}
          aria-label={mode === "menu" ? undefined : "Listening. Swipe up for the player"}
          className={clsx("flex h-9 items-center rounded-lg bg-surface p-[3px] ring-1 ring-line dark:ring-line-strong", mode === "bar" && "w-full", mode !== "menu" && "touch-none")}
          {...lift}
        >
          {mode === "bar" && (
            <div className="flex min-w-0 flex-1 items-center pl-0.5">
              <div className="flex items-center gap-0.5">
                <IconButton size="sm" glyph="size-5" label="Back 30 seconds" icon={Back30} onClick={() => c.skip(-30_000)} />
                <PlayButton size="xs" />
                <IconButton size="sm" glyph="size-5" label="Forward 30 seconds" icon={Forward30} onClick={() => c.skip(30_000)} />
              </div>
              <span className="mx-auto h-4 w-px shrink-0 bg-line-strong" aria-hidden="true" />
              <div className="flex items-center gap-0.5">
                <IconButton size="sm" glyph="size-5" label={follow.label} icon={follow.icon} aria-pressed={n.following && !away} disabled={!follow.onClick || n.finding} aria-busy={n.finding || undefined} onClick={follow.onClick} />
                <IconButton size="sm" glyph="size-5" label={listen ? "Listen from the top of this page" : "Listen from here, once read-along is ready"} icon={ListenHereGlyph} disabled={!listen || n.finding} onClick={() => void c.listenFromHere()} />
              </div>
              <span className="mx-auto h-4 w-px shrink-0 bg-line-strong" aria-hidden="true" />
            </div>
          )}
          {mode === "other" && (
            <div className="flex min-w-0 items-center">
              <PlayButton size="xs" />
              <span className="min-w-0 truncate border-r border-line-strong px-2.5 text-xs/4 font-medium text-ink-2">
                {n.playing ? "Playing " : "Paused, "}
                {n.title}
              </span>
            </div>
          )}
          <Menu label="Menu" title={title} icon={Bars3Icon} size="md" items={menu} />
        </div>
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
      <text x="10" y="12.6" textAnchor="middle" fontSize="6.2" fontWeight="600" fontFamily="inherit">
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
      <text x="10" y="12.6" textAnchor="middle" fontSize="6.2" fontWeight="600" fontFamily="inherit">
        30
      </text>
    </svg>
  );
}

/** A target: the narrator's place. Its middle says whether the page follows it. */
function Target({ middle, ...props }: SVGProps<SVGSVGElement> & { middle: "filled" | "ring" | "none" }) {
  return (
    <svg viewBox="0 0 20 20" {...props}>
      <circle cx="10" cy="10" r="5.75" fill="none" stroke="currentColor" strokeWidth={1.4} />
      <path d="M10 1.75v2.5M10 15.75v2.5M1.75 10h2.5M15.75 10h2.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      {middle !== "none" && <circle cx="10" cy="10" r="2.5" className={middle === "filled" ? "fill-place" : "fill-none stroke-place"} strokeWidth={1.4} />}
    </svg>
  );
}

const FollowingGlyph = (props: SVGProps<SVGSVGElement>) => <Target middle="filled" {...props} />;
const NarratorAwayGlyph = (props: SVGProps<SVGSVGElement>) => <Target middle="ring" {...props} />;
const FollowGlyph = (props: SVGProps<SVGSVGElement>) => <Target middle="none" {...props} />;

/** Lines of text with a play mark: listen from the page you are on. */
function ListenHereGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" {...props}>
      <path d="M3 5.5h9M3 10h6M3 14.5h6" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <path d="M12.5 9.5v6l5-3-5-3Z" />
    </svg>
  );
}
