import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { caseOrder } from "@ribbon/core/bookcase/case";
import type { Cloth } from "@ribbon/core/bookcase/cloth";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { pressedCard } from "./Button";
import { CASE_K, CASE_SCALE, caseBookOf, caseWidthIn, useCoverCloths, useShelvedBooks } from "./case-books";
import { progressOf, useShelfProgress } from "./progress";
import { useController, useCovers } from "./store";

/** How many books stand in the picture (bookcase3d/vignette.ts, which is fetched only when the picture is drawn). */
const PICTURE_BOOKS = 22;
/** How long the library is left alone before the bookcase's shaders are compiled ahead, in milliseconds. */
const WARM_AFTER = 3000;

/**
 * The way into the bookcase, at the foot of the library below the series and the books: a picture of your newest
 * books standing under the lamp, one of them tipped out towards you, and a few words asking you in. Choosing it opens
 * the bookcase, a page of its own, so going there is a choice.
 * The Apple app's is packages/apple/Ribbon/Bookcase/BookcaseInvitation.swift.
 */
export function BookcaseInvitation() {
  const c = useController();
  const books = useShelvedBooks();
  const count = books.length;
  // The bookcase's shaders are compiled ahead, once, a few seconds after the library is on screen and its own
  // picture is drawn, so the bookcase's first opening doesn't wait for them (bookcase3d/warm-up.ts). Only while the
  // library is what's on screen: a book's page, the reader and the bookcase all take this invitation off it.
  const any = count > 0;
  useEffect(() => {
    if (!any) return;
    let onScreen = true;
    const waited = window.setTimeout(() => void import("../bookcase3d/warm-up").then((m) => m.warmBookcaseOnce(caseWidthIn(window.innerWidth), CASE_K, CASE_SCALE, () => onScreen)), WARM_AFTER);
    return () => {
      onScreen = false;
      window.clearTimeout(waited);
    };
  }, [any]);
  if (!any) return null;
  return (
    <button
      type="button"
      onClick={() => c.openBookcase()}
      aria-label={`The bookcase, all ${count} books. Opens it.`}
      className={clsx("lamplit flex flex-col gap-5 rounded-[10px] bg-canvas p-4 text-left ring-1 ring-line focus-ring hover:ring-line-strong sm:flex-row sm:items-center sm:gap-10 sm:p-6", pressedCard)}
    >
      <BookcasePicture books={books} />
      <span className="flex shrink-0 flex-col items-start gap-1 sm:w-80">
        <span className="text-lg/7 font-semibold text-ink">{count === 1 ? "Your book, on the shelf" : `All ${count} of your books, on the shelf`}</span>
        <span className="text-base/6 text-pretty text-ink-2 sm:text-sm/5">Newest first, under the lamp. Take one down and start it there.</span>
        {/* The look of a button, inside the one button the whole invitation is. */}
        <span className="mt-4 rounded-full bg-raised px-4 py-2 text-base/6 font-medium text-ink ring-1 ring-line sm:text-sm/5">Browse the bookcase</span>
      </span>
    </button>
  );
}

/** The last picture drawn, kept for when the library is shown again: the same books at the same size are the same picture. */
let kept: { key: string; url: string } | null = null;

/**
 * The invitation's picture, as wide as there is room for, in the proportions of a shelf seen from a little to one
 * side. Until it is drawn, and on a machine with no graphics card, the lamp's glow alone, where the books will stand.
 */
function BookcasePicture({ books }: { books: readonly ScannedBook[] }) {
  const c = useController();
  useCovers();
  const progress = useShelfProgress();
  // How far you are in each book is read when the books change, not as one plays: the picture is drawn once.
  const progressNow = useRef(progress);
  progressNow.current = progress;
  const byId = useMemo(() => new Map(books.map((b) => [b.book.id, b])), [books]);
  const asCaseBook = useCallback((b: ScannedBook, cloths?: ReadonlyMap<string, Cloth>) => caseBookOf(b, progressOf(b, progressNow.current, (id) => c.readingProgress(id)), c.listedFacts(b), cloths?.get(b.book.id)), [c]);
  const newest = useMemo(
    () =>
      caseOrder(
        books.map((b) => asCaseBook(b)),
        Date.now(),
      )
        .slice(0, PICTURE_BOOKS)
        .map((b) => byId.get(b.id)!),
    [books, byId, asCaseBook],
  );
  const cloths = useCoverCloths(newest, (b) => c.coverUrl(b));

  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const box = useCallback((el: HTMLSpanElement | null) => {
    if (el) setSize({ width: el.clientWidth, height: el.clientHeight });
  }, []);
  const [picture, setPicture] = useState<string | null>(null);
  useEffect(() => {
    if (!size || size.width < 50 || !cloths) return;
    const key = `${newest.map((b) => b.book.id).join(",")} ${size.width}x${size.height}`;
    if (kept?.key === key) {
      setPicture(kept.url);
      return;
    }
    let live = true;
    // The library comes first: what you were in the middle of is on screen before any of this is fetched or drawn.
    const waited = window.setTimeout(async () => {
      const { drawVignette } = await import("../bookcase3d/vignette");
      if (!live) return;
      const drawn = await drawVignette(newest.map((b) => asCaseBook(b, cloths)), size.width, size.height, CASE_SCALE).catch(() => null);
      drawn?.toBlob((blob) => {
        if (!blob) return;
        if (kept) URL.revokeObjectURL(kept.url);
        kept = { key, url: URL.createObjectURL(blob) };
        if (live) setPicture(kept.url);
      });
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(waited);
    };
  }, [size, cloths, newest, asCaseBook]);

  return (
    <span ref={box} aria-hidden="true" className="picture-fade relative block aspect-[1.55] w-full min-w-0 sm:aspect-[2.1] sm:flex-1">
      <span className="absolute inset-0 bg-[radial-gradient(circle_at_36%_50%,rgb(59_42_28/0.55),transparent_55%)]" />
      {picture && <img src={picture} alt="" className="absolute inset-0 size-full animate-[fade-in_0.4s_ease-out]" />}
    </span>
  );
}
