import { clsx } from "clsx";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { readerOnly } from "@ribbon/core/ebook";
import { formatLeft } from "@ribbon/core/speed";
import { addedAt } from "@ribbon/core/view";
import {
  AUTHOR_FACE,
  hueOfHex,
  isLight,
  isNewThisWeek,
  layOutSpine,
  leanRoom,
  LEAN_DEGREES,
  packShelves,
  SHELF_HEIGHT,
  shelfLabel,
  spineBookOf,
  spineColours,
  TITLE_FACE,
  SHELF_ORDERS,
  type Face,
  type Measure,
  type ShelfChoice,
  type ShelfOrder,
  type Spine,
} from "@ribbon/core/shelf";
import { progressOf, useShelfProgress, type Progress } from "./progress";
import { shallowEqual, useAppState, useController, useCovers } from "./store";
import { useCompact } from "./useCompact";
import { hueFromImage } from "./tint";
import { Cover } from "./Cover";
import { Button } from "./Button";
import { ProgressLine } from "./kit";
// The bookcase's own stylesheet: the shelves, the bindings and the lift, flat and matte.
import "./bookcase.css";

const ORDER_LABELS: Record<ShelfOrder, string> = { added: "Added", title: "Title", author: "Author", length: "Length" };

/** The order the books outside a series stand in, as the app's tabs are drawn: plain words, the chosen one underlined. */
export function ShelfOrderTabs() {
  const c = useController();
  const shelf = useAppState((s) => s.shelf);
  return (
    <div role="group" aria-label="Order" className="flex gap-5 overflow-x-auto border-b border-line">
      {SHELF_ORDERS.map((order) => (
        <button
          key={order}
          type="button"
          aria-pressed={shelf.order === order}
          onClick={() => c.setShelf({ ...shelf, order })}
          className={clsx("-mb-px shrink-0 border-b py-2 text-base/6 focus-ring sm:text-sm/5", shelf.order === order ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink")}
        >
          {ORDER_LABELS[order]}
        </button>
      ))}
    </div>
  );
}

/** Spines on shelves, or covers in a grid: the same books in the same order. */
export function ShelfLookSwitch() {
  const c = useController();
  const shelf = useAppState((s) => s.shelf);
  return (
    <div role="group" aria-label="Show the books as" className="flex gap-1">
      {(["spines", "covers"] as const).map((look) => (
        <Button key={look} size="sm" variant={shelf.look === look ? "secondary" : "ghost"} aria-pressed={shelf.look === look} onClick={() => c.setShelf({ ...shelf, look })}>
          {look === "spines" ? "Spines" : "Covers"}
        </Button>
      ))}
    </div>
  );
}

/** What the section says under its title: how many books, and in what order. */
export function shelfDescription(count: number, inSeries: boolean, shelf: ShelfChoice): string {
  const books = `${count} ${count === 1 ? "book" : "books"}${inSeries ? " outside a series" : ""}`;
  const spines = shelf.look === "spines";
  switch (shelf.order) {
    case "added":
      return spines ? `${books}, newest first. This week’s stand face-out at the front.` : `${books}, newest first.`;
    case "title":
      return `${books}, A to Z by title.`;
    case "author":
      return `${books}, by author.`;
    case "length":
      return spines ? `${books}, shortest first. A spine is as thick as its book is long.` : `${books}, shortest first.`;
  }
}

/**
 * The books outside a series, stood on shelves spine-out (core/shelf.ts
 * decides how each spine looks and where it stands): this week's face-out
 * at the front, a bookend, then the rest in the order the tabs chose. The
 * book under the pointer, or under a finger run along a shelf, slides up
 * and the lectern beside the shelves says what it is; a click opens its
 * page. On a phone the first tap chooses a book and the second opens it.
 */
export function Bookcase({ books, order }: { books: ScannedBook[]; order: ShelfOrder }) {
  const c = useController();
  useCovers();
  const compact = useCompact();
  const scale = compact ? 0.8 : 1;
  const fonts = useShelfFonts();
  const [caseRef, width] = useWidth<HTMLDivElement>();
  const shelfProgress = useShelfProgress();
  const readerOpen = useAppState((s) => s.reading !== null);
  const progress = useMemo(
    () => new Map(books.map((b) => [b.book.id, progressOf(b, shelfProgress, (id) => c.readingProgress(id))])),
    // Closing the reader may have moved a book along (`c.readingProgress` reads the kept reading places).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [books, shelfProgress, readerOpen],
  );
  const hues = useCoverHues(books);
  const now = useMemo(() => Date.now(), [books]);

  // What stands on the shelves, in order: this week's books face-out, as many as fit on the first shelf beside a few
  // spines, then a bookend, then every other book's spine.
  const layout = useMemo(() => {
    if (!fonts || width === 0) return null;
    const side = Math.round(12 * scale);
    const avail = width - 2 * side;
    const faceWidth = Math.round(SHELF_HEIGHT * scale * 0.64);
    const room = Math.max(1, Math.floor((avail - 26 * scale - 70 * scale) / (faceWidth + 8 * scale)));
    const fresh = books.filter((b) => isNewThisWeek(b, now)).sort((a, b) => addedAt(b) - addedAt(a)).slice(0, room);
    const rest = books.filter((b) => !fresh.includes(b));
    const gap = Math.max(1, Math.round(1.5 * scale));
    const items: Item[] = [
      ...fresh.map((b, i): Item => ({ kind: "face", book: b, width: faceWidth, gapAfter: Math.round(8 * scale), label: i === 0 ? "This week" : null })),
      ...(fresh.length ? [{ kind: "end", width: Math.round(26 * scale), gapAfter: Math.round(4 * scale), label: null } as Item] : []),
      ...rest.map((b, i): Item => {
        const spine = spineOf(b, progress.get(b.book.id)?.finished ?? false, scale);
        const label = i === 0 || shelfLabel(b, order, now) !== shelfLabel(rest[i - 1]!, order, now) ? shelfLabel(b, order, now) : null;
        return { kind: "spine", book: b, spine, width: spine.width, gapAfter: gap, label };
      }),
    ];
    return { side, shelves: packShelves(items, avail), first: fresh[0] ?? rest[0] ?? null, avail };
  }, [books, order, progress, fonts, width, scale, now]);

  const [chosen, setChosen] = useState<string | null>(null);
  const active = (chosen && books.some((b) => b.book.id === chosen) ? chosen : layout?.first?.book.id) ?? null;
  const activeBook = books.find((b) => b.book.id === active) ?? null;

  // A finger run along a shelf chooses each book it passes; a mouse chooses what it's over.
  const pointer = useRef<{ type: string; wasActive: boolean }>({ type: "mouse", wasActive: false });
  const bookAt = (target: EventTarget | null): string | null => (target instanceof Element ? (target.closest<HTMLElement>("[data-book]")?.dataset.book ?? null) : null);
  const onPointerDown = (e: ReactPointerEvent) => {
    const id = bookAt(e.target);
    pointer.current = { type: e.pointerType, wasActive: id === active };
    if (id) setChosen(id);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const id = e.pointerType === "mouse" ? bookAt(e.target) : e.buttons ? bookAt(document.elementFromPoint(e.clientX, e.clientY)) : null;
    if (id && id !== active) setChosen(id);
  };
  const open = useCallback(
    (id: string, byKeyboard: boolean) => {
      // On a touch screen the first tap only chooses the book; the lectern says what it is, and the next tap opens it.
      if (!byKeyboard && pointer.current.type !== "mouse" && !pointer.current.wasActive) return;
      c.openReader(id);
    },
    [c],
  );

  return (
    <div className={clsx("grid items-start", compact ? "grid-cols-1 gap-3" : "grid-cols-[15rem_minmax(0,1fr)] gap-10")}>
      {activeBook ? <Lectern book={activeBook} progress={progress.get(activeBook.book.id)!} coverUrl={c.coverUrl(activeBook)} compact={compact} now={now} /> : <div />}
      <div ref={caseRef} className="bookcase" style={{ "--k": scale } as CSSProperties} onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
        {layout?.shelves.map((shelf, n) => (
          <Shelf key={n} shelf={shelf} side={layout.side} avail={layout.avail} scale={scale} active={active} progress={progress} hues={hues} onOpen={open} onChoose={setChosen} />
        ))}
        {!layout && <div style={{ height: `${SHELF_HEIGHT * scale}px` }} />}
      </div>
    </div>
  );
}

/** Something on a shelf: a book face-out, the bookend after them, or a spine. `label` is what the shelf's edge says where it starts. */
type Item =
  | { kind: "face"; book: ScannedBook; width: number; gapAfter: number; label: string | null }
  | { kind: "end"; width: number; gapAfter: number; label: string | null }
  | { kind: "spine"; book: ScannedBook; spine: Spine; width: number; gapAfter: number; label: string | null };

type Open = (id: string, byKeyboard: boolean) => void;

function Shelf({ shelf, side, avail, scale, active, progress, hues, onOpen, onChoose }: { shelf: { item: Item; x: number }[]; side: number; avail: number; scale: number; active: string | null; progress: Map<string, Progress>; hues: ReadonlyMap<string, number | null>; onOpen: Open; onChoose: (id: string) => void }) {
  const c = useController();
  // A shelf with room at its end lets its last book lean on the one before.
  const last = shelf[shelf.length - 1]!;
  const lean = last.item.kind === "spine" && avail - (last.x + last.item.width) > leanRoom(last.item.spine.height) + 4;
  // The shelf's edge names each run of books where it begins, unless the run before hasn't room for its own name.
  let labelledTo = -Infinity;
  const labels = shelf.flatMap(({ item, x }) => {
    if (!item.label) return [];
    const at = side + x;
    if (at < labelledTo) return [];
    labelledTo = at + measureOnCanvas(item.label.toUpperCase(), LABEL_FACE) * 8 * scale + 8 * scale;
    return [{ at, text: item.label }];
  });
  return (
    <div className="bookcase-shelf">
      <div className="bookcase-books" style={{ "--shelf": `${Math.round(SHELF_HEIGHT * scale)}px`, "--side": `${side}px` } as CSSProperties}>
        {shelf.map(({ item }, i) => {
          const leans = lean && i === shelf.length - 1;
          const gap = i < shelf.length - 1 ? item.gapAfter : 0;
          if (item.kind === "end") return <span key="end" className="bookcase-end" style={{ marginRight: gap }} aria-hidden="true" />;
          const id = item.book.book.id;
          if (item.kind === "face") return <FaceOut key={id} book={item.book} coverUrl={c.coverUrl(item.book)} width={item.width} gap={gap} active={active === id} onOpen={onOpen} onChoose={onChoose} />;
          return <SpineView key={id} book={item.book} spine={item.spine} hue={hues.get(id)} progress={progress.get(id)!} gap={gap} lean={leans ? leanRoom(item.spine.height) : 0} active={active === id} onOpen={onOpen} onChoose={onChoose} />;
        })}
      </div>
      <div className="bookcase-board">
        {labels.map((l) => (
          <span key={l.at} className="bookcase-label" style={{ left: l.at }}>
            {l.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A book this week, standing face-out. */
function FaceOut({ book, coverUrl, width, gap, active, onOpen, onChoose }: { book: ScannedBook; coverUrl: string | null; width: number; gap: number; active: boolean; onOpen: Open; onChoose: (id: string) => void }) {
  const id = book.book.id;
  return (
    <button type="button" data-book={id} data-active={active || undefined} className="bookcase-face focus-ring" style={{ width, marginRight: gap }} onClick={(e) => onOpen(id, e.detail === 0)} onFocus={() => onChoose(id)} aria-label={`${book.book.title}, ${book.book.author || "unknown author"}, added this week`}>
      <span className="bookcase-lift">
        <Cover url={coverUrl} title={book.book.title} className="w-full" />
      </span>
    </button>
  );
}

interface SpineProps {
  book: ScannedBook;
  spine: Spine;
  hue: number | null | undefined;
  progress: Progress;
  gap: number;
  lean: number;
  active: boolean;
  onOpen: Open;
  onChoose: (id: string) => void;
}

/** A spine, drawn as core/shelf.ts laid it out. Redrawn only when it changes: a playing book moves its own spine, not the shelf's. */
const SpineView = memo(SpineDrawing, (a, b) => {
  const { progress: pa, ...ra } = a;
  const { progress: pb, ...rb } = b;
  return shallowEqual(ra, rb) && shallowEqual(pa, pb);
});

/** The decoration at its head and foot, the sticker, the title, the author, and the ribbon if you're in the middle of it. */
function SpineDrawing({ book, spine, hue, progress, gap, lean, active, onOpen, onChoose }: SpineProps) {
  const id = book.book.id;
  const colours = spineColours(hue ?? null, spine.binding, id);
  const face = TITLE_FACE[spine.binding];
  const leather = spine.binding === "leather";
  const paperback = spine.binding === "paperback";
  // The sticker shows light on a dark spine and dark on a light one.
  const stickerDark = isLight(paperback ? colours.paper : colours.ground);
  const title = (
    <span className="spine-title" style={faceStyle(face, spine.title.size)}>
      {spine.title.lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line}
        </Fragment>
      ))}
    </span>
  );
  const standing = progress.finished ? ", finished" : progress.started ? `, ${Math.max(1, Math.round(progress.fraction * 100))}% ${readerOnly(book.book) ? "read" : "in"}` : "";
  return (
    <button
      type="button"
      data-book={id}
      data-active={active || undefined}
      className={clsx("spine focus-ring", `spine-${spine.binding}`, lean > 0 && "spine-lean", progress.finished && "spine-finished")}
      style={{ width: spine.width, height: spine.height, marginRight: gap, marginLeft: lean || undefined, "--spine-ground": colours.ground, "--spine-ink": colours.ink, "--spine-paper": colours.paper, "--lean": `-${LEAN_DEGREES}deg` } as CSSProperties}
      onClick={(e) => onOpen(id, e.detail === 0)}
      onFocus={() => onChoose(id)}
      aria-label={`${book.book.title}, ${book.book.author || "unknown author"}${standing}`}
    >
      <span className="bookcase-lift">
        <span className="spine-body">
          <span className="spine-zone spine-head" style={{ height: spine.head }} />
          {spine.sticker > 0 && (
            <span className="spine-zone" style={{ height: spine.stickerZone }}>
              <span className={clsx("spine-sticker", stickerDark && "spine-sticker-dark")} style={{ width: spine.sticker, height: spine.sticker }}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" />
                </svg>
              </span>
            </span>
          )}
          <span className="spine-zone spine-words" style={{ padding: leather ? `${spine.padY}px 0` : `${spine.padY}px ${spine.padX}px` }}>
            {leather ? (
              <span className="spine-label" style={{ width: spine.width - 2 * spine.labelInset, padding: `${spine.labelPad * 1.5}px ${spine.labelPad}px` }}>
                {title}
              </span>
            ) : (
              title
            )}
          </span>
          {spine.author && (
            <span className="spine-zone" style={{ height: spine.author.zone }}>
              <span className="spine-author" style={faceStyle(AUTHOR_FACE, spine.author.size)}>
                {spine.author.text}
              </span>
            </span>
          )}
          <span className="spine-zone spine-foot" style={{ height: spine.foot }} />
        </span>
        {progress.started && !progress.finished && <span className="spine-ribbon" aria-hidden="true" />}
      </span>
    </button>
  );
}

/** The face a spine's words are set in, as CSS variables, so what's drawn is exactly what was measured. */
function faceStyle(face: Face, size: number): CSSProperties {
  return { "--face": `"${face.family}"`, "--weight": face.weight, "--tracking": `${face.tracking}em`, "--size": `${size.toFixed(2)}px`, "--leading": face.lineHeight } as CSSProperties;
}

/**
 * The chosen book: its cover, what it is, where you are in it, and the way
 * in. Beside the shelves on a computer; a row above them on a phone.
 */
function Lectern({ book, progress, coverUrl, compact, now }: { book: ScannedBook; progress: Progress; coverUrl: string | null; compact: boolean; now: number }) {
  const c = useController();
  const text = readerOnly(book.book);
  const kind = text ? "EPUB" : book.book.ebook ? `Audiobook and EPUB · ${formatLeft(book.book.durationMs)}` : `Audiobook · ${formatLeft(book.book.durationMs)}`;
  const action = text ? "Read" : progress.started && !progress.finished ? "Continue" : "Play";
  const act = () => (text ? void c.openReading(book.book.id) : void c.playBook(book));
  return (
    <div className={clsx("sticky z-10", compact ? "-mx-4 top-0 flex items-center gap-3 border-b border-line bg-canvas px-4 py-2" : "top-4 flex flex-col gap-3.5")}>
      <Cover url={coverUrl} title={book.book.title} className={compact ? "w-16" : "w-full"} />
      <div className="min-w-0">
        <p className={clsx("text-ink", compact ? "truncate text-base/6 font-medium" : "text-xl/7 font-semibold tracking-tight text-balance")}>{book.book.title}</p>
        <p className="truncate text-sm/5 text-ink-2">{book.book.author || "Unknown author"}</p>
        {!compact && <p className="mt-2 text-[0.8125rem]/5 text-ink-3 tabular-nums">{kind}</p>}
        <p className={clsx("text-ink-2 tabular-nums", compact ? "truncate text-sm/5" : "text-[0.8125rem]/5")}>{standingSentence(book, progress, now)}</p>
        {progress.started && !progress.finished && <ProgressLine fraction={progress.fraction} className="mt-2" />}
        {!compact && (
          <div className="mt-3.5 flex gap-2">
            <Button size="sm" onClick={() => c.openReader(book.book.id)}>
              Open
            </Button>
            <Button size="sm" variant="ghost" onClick={act}>
              {action}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Where a book stands, as a sentence: "41% in, 2h 32m left.", "Added Wednesday.", "Not started. On the shelf since March 2025." */
export function standingSentence(book: ScannedBook, p: Progress, now: number): string {
  if (p.finished) return "Finished.";
  if (p.started) {
    const percent = Math.max(1, Math.round(p.fraction * 100));
    return readerOnly(book.book) ? `${percent}% read.` : `${percent}% in, ${formatLeft(book.book.durationMs - p.posMs)} left.`;
  }
  const added = addedAt(book);
  const days = Math.floor((now - added) / 86_400_000);
  if (added && days < 14) return days <= 0 ? "Added today." : days === 1 ? "Added yesterday." : days < 7 ? `Added ${new Date(added).toLocaleDateString(undefined, { weekday: "long" })}.` : `Added ${days} days ago.`;
  return added ? `Not started. On the shelf since ${new Date(added).toLocaleDateString(undefined, { month: "long", year: "numeric" })}.` : "Not started.";
}

// ---------- Measuring words with the real fonts ----------

/** The shelf edge's lettering. */
const LABEL_FACE: Face = { family: AUTHOR_FACE.family, weight: 600, upper: true, tracking: 0.1, lineHeight: 1 };

const measured = new Map<string, number>();
let canvas: CanvasRenderingContext2D | null | undefined;

/** How long a run of text is per pixel of font size, measured on a canvas once each and kept. */
const measureOnCanvas: Measure = (text, face) => {
  const key = `${face.family}|${face.weight}|${face.tracking}|${text}`;
  let w = measured.get(key);
  if (w === undefined) {
    canvas ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (canvas) canvas.font = `${face.weight} 100px "${face.family}"`;
    w = (canvas ? canvas.measureText(text).width / 100 : text.length * 0.55) + face.tracking * Math.max(0, text.length - 1);
    measured.set(key, w);
  }
  return w;
};

/** Spines, once laid out, kept for the session: the same book at the same size never fits its words twice. */
const spines = new Map<string, Spine>();
function spineOf(b: ScannedBook, finished: boolean, scale: number): Spine {
  const key = `${b.book.id}|${b.book.title}|${b.book.author}|${b.book.durationMs}|${finished}|${scale}`;
  let s = spines.get(key);
  if (!s) {
    s = layOutSpine(spineBookOf(b, finished), scale, measureOnCanvas);
    spines.set(key, s);
  }
  return s;
}

let fontsLoaded: Promise<void> | null = null;

/** Ready once the spines' fonts have loaded, so nothing is measured in a stand-in font and drawn in the real one. */
function useShelfFonts(): boolean {
  const [ready, setReady] = useState(() => typeof document === "undefined" || !document.fonts);
  useEffect(() => {
    if (ready) return;
    const faces = [...Object.values(TITLE_FACE), AUTHOR_FACE].map((f) => `${f.weight} 16px "${f.family}"`);
    fontsLoaded ??= Promise.all([...new Set(faces)].map((f) => document.fonts.load(f))).then(
      () => {
        measured.clear();
        spines.clear();
      },
      () => undefined,
    );
    let live = true;
    void fontsLoaded.then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/** An element's width, kept up to date as the window is resized. */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.current.observe(el);
  }, []);
  return [ref, width];
}

/**
 * Each cover's hue, for its spine's colours: a server's book says it, a
 * book in a folder has its cover sampled, a few at a time, after the shelf
 * has drawn. Until a hue arrives a spine is a quiet neutral.
 */
function useCoverHues(books: ScannedBook[]): ReadonlyMap<string, number | null> {
  const c = useController();
  const [hues, setHues] = useState<ReadonlyMap<string, number | null>>(new Map());
  useEffect(() => {
    let live = true;
    const found = new Map<string, number | null>();
    let flush = 0;
    const keep = (id: string, hue: number | null) => {
      found.set(id, hue);
      // Hues arrive one by one; the shelf redraws with a batch of them, not with each.
      flush ||= window.setTimeout(() => {
        flush = 0;
        if (live) setHues(new Map(found));
      }, 120);
    };
    const queue: { id: string; url: string }[] = [];
    for (const b of books) {
      const colour = b.remote?.cover?.colour;
      if (colour) keep(b.book.id, hueOfHex(colour));
      else {
        const url = c.coverUrl(b);
        if (url) queue.push({ id: b.book.id, url });
      }
    }
    const next = async (): Promise<void> => {
      const job = queue.shift();
      if (!job || !live) return;
      const hue = await hueFromImage(job.url);
      if (hue !== undefined) keep(job.id, hue);
      return next();
    };
    for (let i = 0; i < 4; i++) void next();
    return () => {
      live = false;
      window.clearTimeout(flush);
    };
  }, [books, c]);
  return hues;
}
