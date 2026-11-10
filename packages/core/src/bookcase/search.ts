// Finding a book on the lamp-lit bookcase by what you remember of it: a few letters of the title or the author, in
// any order, forgiving a slip of the finger. Every word typed must match something; the closer the matches, the
// higher the book. The Apple app's copy is packages/apple/Ribbon/Bookcase/ShelfSearch.swift.

/** Lower case, accents folded, punctuation to spaces: "The High Kâhl's Oath" becomes "the high kahl s oath". */
export function foldForSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, " ");
}

function wordsOf(s: string): string[] {
  return foldForSearch(s).split(" ").filter((w) => w.length > 0);
}

/** Every letter of `q` found in `w`, in order. */
function inOrder(q: string, w: string): boolean {
  let at = 0;
  for (const c of q) {
    at = w.indexOf(c, at);
    if (at < 0) return false;
    at += c.length;
  }
  return true;
}

function atMostOneEdit(x: string, y: string): boolean {
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (x.length > y.length) i++;
    else if (x.length < y.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

function swapped(x: string, y: string): boolean {
  if (x.length !== y.length) return false;
  const differ: number[] = [];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ.push(i);
  return differ.length === 2 && differ[1] === differ[0]! + 1 && x[differ[0]!] === y[differ[1]!] && x[differ[1]!] === y[differ[0]!];
}

/**
 * One letter added, dropped or changed, or two neighbours swapped: the slips a finger makes. Compared with the start
 * of the word, since people type the beginnings of words.
 */
function oneOff(q: string, w: string): boolean {
  return [q.length - 1, q.length, q.length + 1].some((n) => {
    const start = w.slice(0, Math.max(0, n));
    return atMostOneEdit(q, start) || swapped(q, start);
  });
}

/** How well one word typed matches one word of the book: the start of it best, then inside it, then one letter off, then its letters in order. */
export function matchWord(q: string, w: string): number {
  if (w.startsWith(q)) return q.length === w.length ? 12 : 10;
  if (q.length >= 3 && w.includes(q)) return 6;
  if (q.length >= 3 && inOrder(q, w)) return 3;
  if (q.length >= 4 && oneOff(q, w)) return 4;
  return 0;
}

/** A book's score for what was typed, or null when some word matches nothing. The title counts more than the author. */
export function searchScore(query: string, book: { title: string; author: string }): number | null {
  const typed = wordsOf(query);
  if (typed.length === 0) return null;
  const title = wordsOf(book.title), author = wordsOf(book.author);
  let total = 0;
  for (const q of typed) {
    const t = Math.max(0, ...title.map((w) => matchWord(q, w))), a = Math.max(0, ...author.map((w) => matchWord(q, w)));
    if (t === 0 && a === 0) return null;
    total += Math.max(t + 2, a);
  }
  // A title that starts with what was typed goes first.
  if (foldForSearch(book.title).trim().startsWith(foldForSearch(query).trim())) total += 8;
  return total;
}

/** The best few for what was typed, the closest first. */
export function findOnShelf<T>(query: string, items: readonly T[], bookOf: (item: T) => { title: string; author: string }, limit = 6): T[] {
  const scored: { item: T; score: number; title: string }[] = [];
  for (const item of items) {
    const book = bookOf(item), score = searchScore(query, book);
    if (score !== null) scored.push({ item, score, title: book.title });
  }
  scored.sort((a, b) => b.score - a.score || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.item);
}
