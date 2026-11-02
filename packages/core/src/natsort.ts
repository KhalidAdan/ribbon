/**
 * Natural, case-insensitive comparison: "Chapter 2" < "Chapter 10".
 * Only ASCII digit runs are numeric; everything else compares as text
 * with locale-independent case folding. Ties fall back to the raw
 * string so the sort is total and stable.
 */

const DIGITS = /(\d+)/;

export function natcompare(a: string, b: string): number {
  const pa = a.toLowerCase().split(DIGITS);
  const pb = b.toLowerCase().split(DIGITS);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x === y) continue;
    const numeric = i % 2 === 1;
    if (numeric) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      // Equal value, different text (leading zeros): shorter first.
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  if (pa.length !== pb.length) return pa.length < pb.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function natsort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => natcompare(key(a), key(b)));
}
