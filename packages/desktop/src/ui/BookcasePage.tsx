import { BookOpenIcon, ChevronRightIcon, MagnifyingGlassIcon, PauseIcon, PlayIcon, XCircleIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { layOutCase, type CaseItem } from "@ribbon/core/bookcase/case";
import { findOnShelf } from "@ribbon/core/bookcase/search";
import { readerOnly } from "@ribbon/core/ebook";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { LamplitCase } from "../bookcase3d/lamplit-case";
import { frameOnRow, rowSize } from "../bookcase3d/shelf-row";
import { loadSpineFaces, measureRun } from "../bookcase3d/spine-art";
import { Button, pressed } from "./Button";
import { CASE_SCALE, caseBookOf, loadPicture, useCoverCloths, useShelvedBooks } from "./case-books";
import { Cover } from "./Cover";
import { howFar, lengthOf, progressOf, useShelfProgress } from "./progress";
import { useAppState, useController, useCovers } from "./store";
import { isPlaying } from "@ribbon/core/playback";

declare const __RIBBON_MEASURE__: boolean;

/** The books' size on the desktop, the lectern's width beside the shelves, and the room for the book in hand. */
const K = 1, LECTERN = 280, HAND_HEIGHT = 330;
/** The book last in hand, so coming back from its page finds it in hand still, its shelf in view. */
let lastTaken: string | null = null;
/** A day, for "Added this week". */
const DAY = 86_400_000;

/** An element's width, once it has stopped changing: a window being dragged wider doesn't lay the case out at every step. */
function useSettledWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const watching = useRef<{ observer: ResizeObserver; timer: number } | null>(null);
  const ref = useCallback((el: T | null) => {
    watching.current?.observer.disconnect();
    window.clearTimeout(watching.current?.timer);
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => {
      window.clearTimeout(watching.current?.timer);
      watching.current!.timer = window.setTimeout(() => setWidth(el.clientWidth), 150);
    });
    watching.current = { observer, timer: 0 };
    observer.observe(el);
  }, []);
  return [ref, width];
}

/**
 * The bookcase as a page of its own, reached from the invitation at the foot of the library: every book on the shelf
 * standing spine-out under the lamp, the newest first, each in a cloth matched to its cover. The book the pointer is
 * on comes off its shelf into your hand at the left, with what it is and how far you are; a click on it opens its
 * page. A search finds a book and brings it into view.
 *
 * It is always a room at night, whatever the app's own light or dark. The Apple app's page is
 * packages/apple/Ribbon/Bookcase/BookcaseView.swift; the drawing is in src/bookcase3d (lamplit-case.ts is the map).
 */
export default function BookcasePage() {
  const c = useController();
  useCovers();
  const books = useShelvedBooks();
  const progress = useShelfProgress();
  const cloths = useCoverCloths(books, (b) => c.coverUrl(b));
  const [caseBox, width] = useSettledWidth<HTMLDivElement>();

  const [facesReady, setFacesReady] = useState(false);
  useEffect(() => {
    let live = true;
    void loadSpineFaces().then(() => live && setFacesReady(true));
    return () => {
      live = false;
    };
  }, []);

  // How far you are in each book is read when the books or their cloths change, not as a book plays: the shelves'
  // order and the ribbons on them hold still while you listen.
  const progressNow = useRef(progress);
  progressNow.current = progress;
  const byId = useMemo(() => new Map(books.map((b) => [b.book.id, b])), [books]);
  const shelves = useMemo(() => {
    if (!facesReady || !cloths || width < 200) return null;
    const reading = (id: string) => c.readingProgress(id);
    const caseBooks = books.map((b) => caseBookOf(b, progressOf(b, progressNow.current, reading), c.listedFacts(b), cloths.get(b.book.id)));
    return layOutCase(caseBooks, width, K, measureRun, Date.now());
  }, [books, cloths, facesReady, width, c]);

  // The case itself, opened once, drawing the book in hand on its own canvas.
  const coverOf = useRef<(item: CaseItem) => Promise<CanvasImageSource | null>>(async () => null);
  coverOf.current = async (item) => {
    const book = byId.get(item.book.id), url = book ? c.coverUrl(book) : null;
    return url ? loadPicture(url) : null;
  };
  const [lamplit, setLamplit] = useState<LamplitCase | null>(null);
  useEffect(() => {
    let live = true, opened: LamplitCase | null = null;
    void LamplitCase.open((item) => coverOf.current(item)).then((made) => {
      opened = made;
      // The measurement build puts the case on the page, for a check to read how long it took.
      if (live && (import.meta.env.DEV || __RIBBON_MEASURE__)) (window as unknown as { __ribbonBookcase: LamplitCase }).__ribbonBookcase = made;
      if (live) setLamplit(made);
      else made.close();
    });
    return () => {
      live = false;
      opened?.close();
    };
  }, []);

  // The shelves laid on their canvases whenever the layout changes, lit from the one in view.
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const takeDown = useCallback(
    (id: string) => {
      lamplit?.takeDown(id);
      setTaken(id);
      lastTaken = id;
    },
    [lamplit],
  );
  const { height: rowHeight } = rowSize(K);
  useEffect(() => {
    if (!lamplit || !shelves) return;
    const first = Math.max(0, Math.floor((scroller.current?.scrollTop ?? 0) / rowHeight));
    lamplit.lay({ shelves: shelves.map((items, i) => ({ items, canvas: canvases.current[i]! })), width, k: K, scale: CASE_SCALE, first });
    lamplit.sizeHand(LECTERN, HAND_HEIGHT);
    // The shelf opens at its start, on the newest book, unless a book is already in hand.
    const all = shelves.flat();
    const back = lamplit.taken === null ? all.find((it) => it.book.id === lastTaken) : undefined;
    const keep = all.find((it) => it.book.id === lamplit.taken) ?? back ?? all[0];
    if (keep) takeDown(keep.book.id);
    if (back) canvases.current[shelves.findIndex((shelf) => shelf.includes(back))]?.scrollIntoView({ block: "center" });
  }, [lamplit, shelves, width, rowHeight, takeDown]);

  // The pointer resting on a book takes it down; passing over on the way elsewhere doesn't.
  const resting = useRef(0);
  const rest = (id: string) => {
    window.clearTimeout(resting.current);
    resting.current = window.setTimeout(() => takeDown(id), 90);
  };
  useEffect(() => () => window.clearTimeout(resting.current), []);

  const [query, setQuery] = useState("");
  const items = useMemo(() => shelves?.flat() ?? [], [shelves]);
  const found = useMemo(() => (query.trim() ? findOnShelf(query, items, (it) => it.book) : []), [query, items]);
  /** A book picked from the search: put the search away, take the book down, and bring its shelf into view. */
  const choose = (item: CaseItem) => {
    setQuery("");
    takeDown(item.book.id);
    const row = shelves?.findIndex((shelf) => shelf.includes(item)) ?? -1;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (row >= 0) canvases.current[row]?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  };

  const inHand = taken ? (byId.get(taken) ?? null) : null;
  const flat = lamplit !== null && !lamplit.lit;
  return (
    <section className="lamplit flex h-full gap-8 bg-canvas px-4 pt-6 text-ink sm:px-8" aria-label="Bookcase">
      <aside className="flex shrink-0 flex-col gap-3.5" style={{ width: LECTERN }}>
        <FindABook query={query} onQuery={setQuery} onSubmit={() => found[0] && choose(found[0])} />
        <Lectern book={inHand} canvas={lamplit?.handCanvas ?? null} flat={flat} onTurn={(dx) => lamplit?.turnInHand(dx)} />
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="pb-3.5">
          <h1 className="text-lg/7 font-semibold text-ink">Bookcase</h1>
          <p className="text-sm/5 text-ink-2">{books.length === 1 ? "Your book, on the shelf." : `All ${books.length} books, newest first.`}</p>
        </header>
        {/* The shelves' edges dissolve into the page, so the bookcase reads as a pool of light, not a box pasted on. */}
        <div ref={scroller} className="case-fade min-h-0 flex-1 overflow-y-auto quiet-scroll">
          <div ref={caseBox} className="pb-10">
            {shelves?.map((shelf, i) => (
              <div key={i} className="relative" style={{ height: rowHeight }}>
                <canvas
                  ref={(el) => {
                    canvases.current[i] = el;
                  }}
                  aria-hidden="true"
                  className="block"
                  style={{ width, height: rowHeight }}
                />
                {shelf.map((item) => {
                  const f = frameOnRow(item, K), id = item.book.id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-label={`${item.book.title}, ${item.book.author}`}
                      aria-pressed={taken === id}
                      onPointerEnter={(e) => e.pointerType === "mouse" && rest(id)}
                      onPointerLeave={() => window.clearTimeout(resting.current)}
                      onFocus={() => takeDown(id)}
                      onClick={() => (taken === id ? c.openReader(id) : takeDown(id))}
                      // With no graphics card no book comes off the shelf, so the one in hand is outlined instead.
                      className={clsx("absolute cursor-pointer rounded-sm focus-ring", flat && taken === id && "ring-1 ring-place")}
                      style={{ left: f.x, top: f.y, width: f.width, height: f.height }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {found.length > 0 && (
          <ul role="list" className="absolute top-16 left-5 z-10 w-96 overflow-hidden rounded-xl bg-raised shadow-2xl ring-1 ring-line">
            {found.map((item) => (
              <li key={item.book.id} className="border-b border-line last:border-b-0">
                <button type="button" onClick={() => choose(item)} className="block w-full px-4 py-2.5 text-left focus-ring hover:bg-surface">
                  <span className="block truncate text-sm/5 font-semibold text-ink">{item.book.title}</span>
                  <span className="block truncate text-[0.8125rem]/5 text-ink-2 tabular-nums">
                    {item.book.author} · {byId.get(item.book.id) ? lengthOf(byId.get(item.book.id)!) : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Finding a book on the shelves by what you remember of it. */
function FindABook({ query, onQuery, onSubmit }: { query: string; onQuery: (q: string) => void; onSubmit: () => void }) {
  return (
    <form
      role="search"
      className="flex h-9 items-center gap-2 rounded-lg bg-raised px-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <MagnifyingGlassIcon className="size-4 shrink-0 fill-ink-3" aria-hidden="true" />
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onQuery("")}
        placeholder="Find a book"
        aria-label="Find a book on the shelves"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-sm/5 text-ink outline-none placeholder:text-ink-3"
      />
      {query && (
        <button type="button" onClick={() => onQuery("")} aria-label="Clear the search" className="rounded-full focus-ring">
          <XCircleIcon className="size-4 fill-ink-3" aria-hidden="true" />
        </button>
      )}
    </form>
  );
}

/**
 * The book you're on, in your hand, and what it is: its title, its author, how long it is and how far you are. The
 * book turns under the pointer, and a click on it, or on its title, opens its page. Start it or carry on with it
 * right there, without leaving the bookcase.
 */
function Lectern({ book, canvas, flat, onTurn }: { book: ScannedBook | null; canvas: HTMLCanvasElement | null; flat: boolean; onTurn: (dx: number) => void }) {
  const c = useController();
  const progress = useShelfProgress();
  const playing = useAppState((s) => isPlaying(s.player.status));
  // The case draws the book in hand on a canvas of its own making; it is put on the page here.
  const hand = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const holder = hand.current;
    if (!canvas || !holder) return;
    canvas.style.cssText = `display: block; width: ${LECTERN}px; height: ${HAND_HEIGHT}px`;
    holder.append(canvas);
    return () => canvas.remove();
  }, [canvas]);
  const drag = useRef<{ x: number; moved: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, moved: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    drag.current = { x: e.clientX, moved: drag.current.moved + Math.abs(dx) };
    onTurn(dx);
  };
  const onUp = () => {
    // A press that didn't turn the book opens it.
    if (drag.current && drag.current.moved < 3 && book) c.openReader(book.book.id);
    drag.current = null;
  };

  const p = book ? progressOf(book, progress, (id) => c.readingProgress(id)) : null;
  const toRead = book ? readerOnly(book.book) : false;
  const here = book !== null && progress.current?.book.book.id === book.book.id && playing;
  const came = book ? (c.listedFacts(book)?.addedAt ?? null) : null;
  const standing = !p ? "" : p.finished ? "Finished." : p.started ? `${howFar(book!, p)}.` : came !== null && Date.now() - came < 7 * DAY ? "Added this week." : "Not started.";
  return (
    <div className="flex flex-col gap-3.5">
      <div className="relative" style={{ width: LECTERN, height: HAND_HEIGHT }}>
        {flat ? (
          // No graphics card, so no book to turn: its cover instead.
          book && (
            <button type="button" onClick={() => c.openReader(book.book.id)} className="absolute inset-0 flex items-center justify-center focus-ring" aria-label={`${book.book.title}: open its page`}>
              <Cover url={c.coverUrl(book)} title={book.book.title} className="w-44" />
            </button>
          )
        ) : (
          <div ref={hand} aria-hidden="true" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => (drag.current = null)} className="cursor-grab touch-none active:cursor-grabbing" />
        )}
      </div>
      {book && p && (
        <div className="flex flex-col gap-0.5">
          <button type="button" onClick={() => c.openReader(book.book.id)} className="group rounded-sm text-left focus-ring" title="Open its page">
            <span className="line-clamp-3 text-lg/6 font-semibold text-pretty text-ink">
              {book.book.title}
              <ChevronRightIcon className="ml-1 inline size-4 fill-ink-3 group-hover:fill-ink" aria-hidden="true" />
            </span>
          </button>
          <p className="truncate text-sm/5 text-ink-2">{book.book.author || "Unknown author"}</p>
          <p className="mt-1 text-[0.8125rem]/5 text-ink-3 tabular-nums">{toRead ? "EPUB" : `Audiobook · ${lengthOf(book)}`}</p>
          <p className="text-[0.8125rem]/5 text-ink-2 tabular-nums">{standing}</p>
          {p.started && !p.finished && (
            <div className="mt-1.5 h-0.5 w-60 overflow-hidden rounded-full bg-white/15">
              <div className="h-full rounded-full bg-place" style={{ width: `${Math.round(p.fraction * 100)}%` }} />
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2">
            {toRead ? (
              <Button variant="primary" leading={BookOpenIcon} className={pressed} onClick={() => void c.openReading(book.book.id)}>
                {p.started && !p.finished ? "Continue reading" : "Read"}
              </Button>
            ) : (
              <Button variant="primary" leading={here ? PauseIcon : PlayIcon} className={pressed} onClick={() => (here ? c.pause() : void c.playBook(book))}>
                {here ? "Pause" : p.finished ? "Listen again" : p.started ? "Continue listening" : "Start listening"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
