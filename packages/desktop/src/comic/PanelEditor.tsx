import { ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { WHOLE_PAGE, added, moved, redrawn, removed, type Panel } from "@ribbon/core/comic/panels";
import type { ReadyComic } from "@ribbon/core/comic/session";
import { pageBox, type PixelSize } from "@ribbon/core/comic/size";
import type { AppController } from "../app/controller";
import { Button } from "../ui/Button";
import { between, cursorOf, panelAt, pulled, type Grip, type Point } from "./panel-drag";

/**
 * Marking a comic's panels by hand (docs/COMICS.md, section 14): one page
 * at a time, with its panels drawn over it and listed beside it in the
 * order they are read.
 *
 * - A drag on the page draws a panel, read last until it is moved.
 * - A panel is moved by its middle and drawn larger or smaller by an edge
 *   or a corner.
 * - The list puts one earlier or later, or takes it away.
 *
 * Every change is kept on the server as it is made, for every device, in
 * place of what the page had: there is nothing to save and nothing to
 * lose. What a panel may be, and how a list of them is edited, is core's
 * (packages/core/src/comic/panels.ts), the same functions an assistant's
 * marks go through; what a pointer does to one is panel-drag.ts.
 */

/** The colours panels are outlined in, one after another: the ones the server draws them in for an assistant (host-node/page-picture.ts). */
const INKS = ["#ff3b30", "#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#64d2ff"];

/** How near an edge, in pixels of the screen, counts as on it. */
const REACH = 7;

/** What the pointer is in the middle of doing: drawing a new panel, or pulling one by a grip. */
type Pull = { kind: "draw"; from: Point; to: Point } | { kind: "pull"; at: number; grip: Grip; from: Point; was: Panel; now: Panel };

/** Whether the page's panels are kept: being sent, kept, or refused, in the server's words. */
type Kept = { state: "kept" } | { state: "keeping" } | { state: "refused"; why: string };

export function PanelEditor({ comic, title, c, onDone }: { comic: ReadyComic; title: string; c: AppController; onDone: () => void }) {
  const count = comic.pages.length;
  const [at, setAt] = useState(comic.page);
  /** Every marked page's panels, as the server has them and as they are changed here; null until the server answers. */
  const [all, setAll] = useState<Map<number, Panel[]> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [pull, setPull] = useState<Pull | null>(null);
  const [hover, setHover] = useState<Grip | null>(null);
  const [kept, setKept] = useState<Kept>({ state: "kept" });

  useEffect(() => {
    let gone = false;
    c.comicPanels(comic.bookId).then(
      (panels) => !gone && setAll(panels),
      (e: unknown) => !gone && setProblem(e instanceof Error ? e.message : "The server couldn't be asked for this comic's panels."),
    );
    return () => {
      gone = true;
    };
  }, [c, comic.bookId]);

  const panels = all?.get(at) ?? [];
  /** The page's panels as they look now: with the one being pulled where it has been pulled to. */
  const shown = pull?.kind === "pull" ? redrawn(panels, pull.at, pull.now) : panels;

  /** The page's panels become these, here and on the server. The last change sent stands. */
  const keep = (next: Panel[]) => {
    setAll((was) => new Map(was ?? []).set(at, next));
    setKept({ state: "keeping" });
    c.saveComicPanels(comic.bookId, at, next).then(
      () => setKept((k) => (k.state === "keeping" ? { state: "kept" } : k)),
      (e: unknown) => setKept({ state: "refused", why: e instanceof Error ? e.message : "The server didn't keep that." }),
    );
  };

  const turn = (to: number) => {
    if (to < 0 || to >= count || to === at) return;
    setAt(to);
    setChosen(null);
    setPull(null);
  };

  // The page's picture, one at a time: fetched, decoded, drawn, and let go when another page is asked for.
  const picture = usePagePicture(c, at);

  // The room the page has, and its size in it.
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<PixelSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setRoom({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);
  const box = picture && room.width > 0 ? pageBox(picture, 1, { width: room.width - 48, height: room.height - 48 }, "page") : null;

  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !picture || !box) return;
    const density = Math.min(window.devicePixelRatio || 1, picture.width / box.width);
    el.width = Math.max(1, Math.round(box.width * density));
    el.height = Math.max(1, Math.round(box.height * density));
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(picture.bitmap, 0, 0, el.width, el.height);
  }, [picture, box?.width, box?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Where on the page a pointer is, in fractions of it, and how near an edge counts as on it there. */
  const where = (e: PointerEvent<HTMLDivElement>): { point: Point; reach: Point } => {
    const r = e.currentTarget.getBoundingClientRect();
    return { point: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, reach: { x: REACH / r.width, y: REACH / r.height } };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !all) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { point, reach } = where(e);
    const held = panelAt(panels, point, reach, chosen);
    if (held) {
      setChosen(held.at);
      setPull({ kind: "pull", at: held.at, grip: held.grip, from: point, was: panels[held.at]!, now: panels[held.at]! });
    } else {
      setChosen(null);
      setPull({ kind: "draw", from: point, to: point });
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const { point, reach } = where(e);
    if (!pull) return setHover(panelAt(panels, point, reach, chosen)?.grip ?? null);
    if (pull.kind === "draw") setPull({ ...pull, to: point });
    else setPull({ ...pull, now: pulled(pull.was, pull.grip, { x: point.x - pull.from.x, y: point.y - pull.from.y }) });
  };

  const onPointerUp = () => {
    if (!pull) return;
    setPull(null);
    if (pull.kind === "draw") {
      const drawn = between(pull.from, pull.to);
      // A click on the bare page chooses nothing; a drag is a new panel, read last.
      if (!drawn) return;
      keep(added(panels, drawn));
      setChosen(panels.length);
    } else if (pull.now.x !== pull.was.x || pull.now.y !== pull.was.y || pull.now.w !== pull.was.w || pull.now.h !== pull.was.h) {
      keep(redrawn(panels, pull.at, pull.now));
    }
  };

  /** One panel put earlier or later in the order, and still the one chosen. */
  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= panels.length) return;
    keep(moved(panels, from, to));
    setChosen(to);
  };
  const remove = (which: number) => {
    keep(removed(panels, which));
    setChosen(null);
  };

  // The keys, read from what is on screen now.
  const keys = useRef({ at, chosen, panels, reorder, remove, turn, onDone });
  keys.current = { at, chosen, panels, reorder, remove, turn, onDone };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = keys.current;
      const done = () => e.preventDefault();
      if (e.key === "Escape") return done(), k.chosen !== null ? setChosen(null) : k.onDone();
      if (e.key === "PageDown" || e.key === "ArrowRight") return done(), k.turn(k.at + 1);
      if (e.key === "PageUp" || e.key === "ArrowLeft") return done(), k.turn(k.at - 1);
      if (k.chosen === null) return;
      if (e.key === "Delete" || e.key === "Backspace") return done(), k.remove(k.chosen);
      if (e.key === "ArrowUp") return done(), k.reorder(k.chosen, k.chosen - 1);
      if (e.key === "ArrowDown") return done(), k.reorder(k.chosen, k.chosen + 1);
    };
    // Before the reader's own keys, which turn the comic's page: here they are the editor's.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const drawing = pull?.kind === "draw" ? between(pull.from, pull.to) : null;

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2 sm:px-3">
        <Button variant="ghost" size="sm" leading={ArrowLeftIcon} onClick={onDone}>
          Back to reading
        </Button>
        <p className="min-w-0 flex-1 truncate text-center text-[0.8125rem]/5 text-ink-2">
          Panels of <span className="font-medium text-ink">{title}</span>
        </p>
        <p role="status" className={clsx("w-40 shrink-0 truncate text-right text-xs/4", kept.state === "refused" ? "text-red-500" : "text-ink-3")} title={kept.state === "refused" ? kept.why : undefined}>
          {kept.state === "keeping" ? "Keeping…" : kept.state === "refused" ? "Not kept" : all ? "Kept on the server" : ""}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={stage} className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-surface">
          {problem && <p className="max-w-md px-6 text-center text-sm/5 text-ink-2">{problem}</p>}
          {!problem && box && (
            <div className="relative shadow-lg" style={{ width: box.width, height: box.height }}>
              <canvas ref={canvas} role="img" aria-label={`Page ${at + 1}`} style={{ width: box.width, height: box.height }} className="block" />
              <div
                data-panel-page
                className="absolute inset-0 touch-none select-none"
                style={{ cursor: pull?.kind === "pull" ? cursorOf(pull.grip) : cursorOf(hover) }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setPull(null)}
              >
                {shown.map((panel, i) => (
                  <PanelBox key={i} panel={panel} number={i + 1} ink={INKS[i % INKS.length]!} chosen={i === chosen} />
                ))}
                {drawing && <PanelBox panel={drawing} number={panels.length + 1} ink={INKS[panels.length % INKS.length]!} chosen />}
              </div>
            </div>
          )}
        </div>

        <aside className="flex w-64 shrink-0 flex-col border-l border-line">
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
            <Button variant="ghost" size="sm" aria-label="The page before" disabled={at === 0} onClick={() => turn(at - 1)}>
              <ChevronLeftIcon className="size-4 fill-current" aria-hidden="true" />
            </Button>
            <p className="min-w-0 flex-1 text-center text-[0.8125rem]/5 text-ink tabular-nums">
              Page {at + 1} of {count}
            </p>
            <Button variant="ghost" size="sm" aria-label="The next page" disabled={at === count - 1} onClick={() => turn(at + 1)}>
              <ChevronRightIcon className="size-4 fill-current" aria-hidden="true" />
            </Button>
          </div>

          <ol aria-label="This page's panels, in the order they are read" className="min-h-0 flex-1 overflow-y-auto p-2">
            {panels.length === 0 && (
              <li className="px-2 py-3 text-[0.8125rem]/5 text-ink-3">
                {all ? "No panels yet. Drag on the page to draw one. They are read in the order listed here." : problem ? "" : "Asking the server…"}
              </li>
            )}
            {panels.map((_, i) => (
              <li key={i}>
                <div className={clsx("flex items-center gap-1 rounded-md py-1 pr-1 pl-2", i === chosen ? "bg-raised ring-1 ring-line" : "hover:bg-raised")}>
                  <button type="button" onClick={() => setChosen(i)} className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left text-[0.8125rem]/5 text-ink focus-ring" aria-pressed={i === chosen}>
                    <span className="flex size-5 shrink-0 items-center justify-center rounded text-xs/4 font-semibold text-white tabular-nums" style={{ background: INKS[i % INKS.length] }}>
                      {i + 1}
                    </span>
                    Panel {i + 1}
                  </button>
                  <Button variant="ghost" size="sm" aria-label={`Read panel ${i + 1} earlier`} disabled={i === 0} onClick={() => reorder(i, i - 1)}>
                    <ArrowUpIcon className="size-4 fill-current" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={`Read panel ${i + 1} later`} disabled={i === panels.length - 1} onClick={() => reorder(i, i + 1)}>
                    <ArrowDownIcon className="size-4 fill-current" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={`Take panel ${i + 1} away`} onClick={() => remove(i)}>
                    <XMarkIcon className="size-4 fill-current" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ol>

          <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2">
            <Button
              size="sm"
              disabled={!all}
              onClick={() => {
                keep([WHOLE_PAGE]);
                setChosen(null);
              }}
            >
              The whole page is one panel
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={panels.length === 0}
              onClick={() => {
                keep([]);
                setChosen(null);
              }}
            >
              Take this page's panels away
            </Button>
            {kept.state === "refused" && <p className="px-1 text-xs/4 text-red-500">{kept.why}</p>}
          </div>
        </aside>
      </div>
    </>
  );
}

/** One panel over the page: outlined in its colour, its number in the order on a tab, and squares to hold it by when it is the one chosen. */
function PanelBox({ panel, number, ink, chosen }: { panel: Panel; number: number; ink: string; chosen: boolean }) {
  const percent = (n: number) => `${n * 100}%`;
  return (
    <div
      data-panel={number}
      className="pointer-events-none absolute"
      style={{ left: percent(panel.x), top: percent(panel.y), width: percent(panel.w), height: percent(panel.h), outline: `${chosen ? 3 : 2}px solid ${ink}`, outlineOffset: -1, background: chosen ? `${ink}22` : undefined }}
    >
      <span className="absolute top-0 left-0 flex min-w-5 items-center justify-center px-1 text-xs/5 font-semibold text-white tabular-nums" style={{ background: ink }}>
        {number}
      </span>
      {chosen &&
        HANDLES.map(([x, y]) => <span key={`${x}-${y}`} className="absolute size-2 -translate-1/2 rounded-[1px] bg-white" style={{ left: percent(x), top: percent(y), boxShadow: `0 0 0 1.5px ${ink}` }} />)}
    </div>
  );
}

/** Where a chosen panel's eight squares sit: its corners and the middles of its edges, as fractions of it. */
const HANDLES: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [0, 0.5],
  [1, 0.5],
  [0, 1],
  [0.5, 1],
  [1, 1],
];

/**
 * One page's picture, decoded: a comic's from its file, a PDF's drawn out
 * of it. Held one at a time and let go when another page is asked for, as
 * the reader lets go of its pages (ComicView.tsx): left to the web view
 * as image elements, decoded pages pile up in its cache.
 */
function usePagePicture(c: AppController, at: number): (PixelSize & { bitmap: ImageBitmap }) | null {
  const [picture, setPicture] = useState<(PixelSize & { bitmap: ImageBitmap }) | null>(null);
  // A PDF is opened once, when the editor opens, and its pages are drawn out of it.
  const pdf = useRef<Promise<import("./pdf").WebPdf> | null | undefined>(undefined);
  useEffect(
    () => () => {
      void pdf.current?.then(
        (open) => open.close(),
        () => undefined,
      );
    },
    [],
  );
  useEffect(() => {
    let gone = false;
    let made: ImageBitmap | null = null;
    setPicture(null);
    (async () => {
      if (pdf.current === undefined) {
        const document = c.comicDocument();
        pdf.current = document ? import("./pdf").then((m) => m.openWebPdf(document.url, document.bytes)) : null;
      }
      const longest = Math.min(4096, Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1) * 1.6);
      let bitmap: ImageBitmap;
      if (pdf.current) {
        bitmap = await (await pdf.current).picture(at, longest);
      } else {
        const address = c.comicPageUrl(at);
        if (!address) return;
        const answer = await fetch(address);
        if (!answer.ok) return;
        bitmap = await createImageBitmap(await answer.blob());
      }
      if (gone) return bitmap.close();
      made = bitmap;
      setPicture({ bitmap, width: bitmap.width, height: bitmap.height });
    })().catch(() => undefined);
    return () => {
      gone = true;
      made?.close();
    };
  }, [c, at]);
  return picture;
}
