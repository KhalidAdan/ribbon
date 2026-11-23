/**
 * Pages shown two at a time, as a printed comic opens (docs/COMICS.md,
 * section 5; the rule is Panels'). The cover stands alone, so every pair
 * after it is the two pages that face each other in print; a page drawn
 * across both (a wide one) stands alone too.
 */
export type Spread = { kind: "solo"; page: number } | { kind: "pair"; first: number; second: number };

/** The spreads of a comic, from whether each page is wide. Pages count from 0. */
export function spreads(wide: readonly boolean[]): Spread[] {
  const out: Spread[] = [];
  if (wide.length === 0) return out;
  out.push({ kind: "solo", page: 0 });
  let i = 1;
  while (i < wide.length) {
    const pairs = !wide[i] && i + 1 < wide.length && !wide[i + 1];
    if (pairs) {
      out.push({ kind: "pair", first: i, second: i + 1 });
      i += 2;
    } else {
      out.push({ kind: "solo", page: i });
      i += 1;
    }
  }
  return out;
}

/** The index of the spread a page is on; the first when the page is out of range. */
export function spreadOf(all: readonly Spread[], page: number): number {
  const i = all.findIndex((s) => (s.kind === "solo" ? s.page === page : s.first === page || s.second === page));
  return i < 0 ? 0 : i;
}

/** The page a spread is kept as: its first, which is the place written when it is on screen. */
export function firstPage(spread: Spread): number {
  return spread.kind === "solo" ? spread.page : spread.first;
}

/** Every page of a spread, in reading order. */
export function pagesOf(spread: Spread): number[] {
  return spread.kind === "solo" ? [spread.page] : [spread.first, spread.second];
}

/** A page drawn across two: wider than it is tall. */
export function isWide(width: number, height: number): boolean {
  return width > 0 && height > 0 && width > height;
}
