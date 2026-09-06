import { natcompare } from "./natsort";
import { parseNumbered } from "./scan/metadata";
import type { Book } from "./types";

/**
 * Library order follows the folder tree the listener built. Each path
 * segment contributes its leading number when it has one, else its name,
 * and books compare segment by segment: numbers before names, numbers
 * numerically, names naturally. "50. Born of Flame/1. Promethian Sun"
 * therefore lands after "49. …" and before "51. …", with its siblings
 * in their own order beneath it.
 */
export type OrderKey = (number | string)[];

export function orderKey(bookPath: string): OrderKey {
  return bookPath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const n = parseNumbered(segment);
      return n ? n.index : segment;
    });
}

export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
      continue;
    }
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    const c = natcompare(x, y);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Folder-tree order, then title as a final tie-break. */
export function compareBooks(a: Book, b: Book): number {
  const c = compareOrderKeys(orderKey(a.path), orderKey(b.path));
  if (c !== 0) return c;
  return natcompare(a.title, b.title);
}
