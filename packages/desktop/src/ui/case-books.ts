import { useEffect, useMemo, useState } from "react";
import type { CaseBook } from "@ribbon/core/bookcase/case";
import { coverColour, hexOf, nearestCloth, rgb, type Cloth, type RGB } from "@ribbon/core/bookcase/cloth";
import { readerOnly } from "@ribbon/core/ebook";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { addedAt } from "@ribbon/core/view";
import { offTheShelf } from "@ribbon/core/series";
import type { Progress } from "./progress";
import { useAppState, useController } from "./store";

/**
 * How many pixels to the point the bookcase, and the invitation's picture of it, are drawn at: two, whatever the
 * screen, and shown at the screen's own size. Its look was settled on a Mac, whose screen has two pixels to the point.
 * Drawn at one, as most Windows screens have, the cloth's weave (read unsmoothed, bookcase3d/textures.ts) and the threads
 * laid over each spine come out as a coarse grid, and the lettering blurs. Drawn at two and shrunk, each pixel is the
 * average of the four a Mac would show in its place: the Mac's picture, at this screen's size.
 */
export const CASE_SCALE = 2;

/** Every book on the shelf, for the bookcase: all but those a series leaves off it. */
export function useShelvedBooks(): ScannedBook[] {
  const c = useController();
  const state = useAppState((s) => ({ books: s.books, series: s.series, sources: s.sources }));
  return useMemo(() => {
    const hidden = offTheShelf(c.detectedSeries(), state.series);
    return state.books.filter((b) => !hidden.has(b.book.id));
  }, [c, state.books, state.series, state.sources]);
}

/** Narration runs about 9,350 words an hour: the median of the owner's books that have both editions. */
const WORDS_PER_HOUR = 9_350;

/** What a server knows of a book that its files here don't say (the controller's `listedFacts`). */
export interface ListedFacts {
  addedAt: number | null;
  words: number | null;
  ebookBytes: number | null;
}

/**
 * How long a book is in words, which is how thick it stands on the lamp-lit bookcase:
 * - its EPUB's words, where a server has counted them from its text;
 * - for an audiobook, its narration's length at the pace narrators read, which is right to about a fifth;
 * - for an EPUB not counted, its size at about five bytes a word;
 * - and a novel's length when there's nothing to go by.
 */
export function wordsOf(b: ScannedBook, facts: ListedFacts | null): number {
  if (facts?.words && facts.words > 0) return facts.words;
  if (!readerOnly(b.book) && b.book.durationMs > 0) return (b.book.durationMs / 3_600_000) * WORDS_PER_HOUR;
  if (facts?.ebookBytes) return Math.min(400_000, Math.max(20_000, facts.ebookBytes / 5));
  return 90_000;
}

/** A book as the lamp-lit bookcase knows it. A server's book came when the server says; a folder's, when its newest file was written. */
export function caseBookOf(b: ScannedBook, progress: Progress, facts: ListedFacts | null, cloth: Cloth | undefined): CaseBook {
  const came = facts?.addedAt ?? (addedAt(b) || null);
  return {
    id: b.book.id,
    title: b.book.title,
    author: b.book.author,
    words: wordsOf(b, facts),
    fraction: progress.started ? progress.fraction : 0,
    finished: progress.finished,
    addedAt: came,
    ...(cloth ? { cloth } : {}),
  };
}

// Each cover's own colour, by its address, worked out once from a small sample of the picture and kept from one
// launch to the next: the bookcase draws every spine in its own cloth from the start. The pictures aren't kept.
const KEPT = "ribbon.cover-colours";
const colours = new Map<string, RGB>(readKept());
const sampling = new Map<string, Promise<RGB | null>>();

function readKept(): [string, RGB][] {
  try {
    const kept = JSON.parse(localStorage.getItem(KEPT) ?? "{}") as Record<string, string>;
    return Object.entries(kept).map(([url, hex]) => [url, rgb(parseInt(hex.slice(1), 16))]);
  } catch {
    return [];
  }
}

function keep(): void {
  try {
    localStorage.setItem(KEPT, JSON.stringify(Object.fromEntries([...colours].map(([url, c]) => [url, hexOf(c)]))));
  } catch {
    // No room to keep them: they are sampled again next time.
  }
}

/** A picture, loaded so its pixels can be read. Null when it can't be. */
export function loadPicture(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** A cover's colour, from a 24 by 24 sample of it. */
function colourFromCover(url: string): Promise<RGB | null> {
  let asked = sampling.get(url);
  if (!asked) {
    asked = loadPicture(url).then((img) => {
      if (!img) return null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 24;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 24, 24);
        const colour = coverColour(ctx.getImageData(0, 0, 24, 24).data);
        colours.set(url, colour);
        return colour;
      } catch {
        return null;
      }
    });
    sampling.set(url, asked);
  }
  return asked;
}

/** How long the shelves wait for covers' colours before standing the rest in quiet cloths of their own. */
const PATIENCE_MS = 2_500;

/**
 * Each book's cloth, from its cover: null until they are known, so every spine is drawn once, in its own colour.
 * Covers not yet sampled are, six at a time; a cover that is slow or can't be read leaves its book a quiet cloth.
 */
export function useCoverCloths(books: readonly ScannedBook[], coverUrl: (b: ScannedBook) => string | null): ReadonlyMap<string, Cloth> | null {
  const [cloths, setCloths] = useState<ReadonlyMap<string, Cloth> | null>(null);
  useEffect(() => {
    let live = true;
    const urls = new Map<string, string>();
    for (const b of books) {
      const url = coverUrl(b);
      if (url) urls.set(b.book.id, url);
    }
    const settle = () => {
      if (!live) return;
      const found = new Map<string, Cloth>();
      for (const [id, url] of urls) {
        const colour = colours.get(url);
        if (colour) found.set(id, nearestCloth(colour));
      }
      setCloths(found);
    };
    const wanted = [...new Set(urls.values())].filter((url) => !colours.has(url));
    if (wanted.length === 0) {
      settle();
      return;
    }
    const next = async (): Promise<void> => {
      const url = wanted.shift();
      if (!url || !live) return;
      await colourFromCover(url);
      return next();
    };
    const patience = window.setTimeout(settle, PATIENCE_MS);
    void Promise.all(Array.from({ length: 6 }, next)).then(() => {
      window.clearTimeout(patience);
      keep();
      settle();
    });
    return () => {
      live = false;
      window.clearTimeout(patience);
    };
    // The covers' addresses are read when the books change; a cover arriving later is sampled the next time the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books]);
  return cloths;
}
