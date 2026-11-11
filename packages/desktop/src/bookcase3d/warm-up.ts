import { isPaperback, layOutCase, type CaseBook } from "@ribbon/core/bookcase/case";
import { BookInHand } from "./book-in-hand";
import { hasGraphicsCard, LAMP, lampCount, makeRenderer } from "./lamplight";
import { rowSize, ShelfRow } from "./shelf-row";
import { loadSpineFaces, measureRun } from "./spine-art";
import { loadBookPictures, makeBookTextures } from "./textures";

declare const __APP_VERSION__: string;

/**
 * The bookcase's shaders, compiled ahead of the first time it is opened, as a game compiles its own before you play.
 *
 * A graphics card runs small programs (shaders) to draw the books, and they are compiled from text the first time
 * they are used: on a Mac that took the bookcase about two and a half seconds, the first time ever. The browser keeps
 * what it compiled, for this app, so it is only ever slow once; this spends that once in the background, while the
 * library is on screen, by drawing a stand-in shelf and a stand-in book in hand that nobody sees.
 *
 * Which programs a shelf needs depends on how many lamps hang over it (lamplight.ts, `lampCount`), and so on how wide
 * the window is: they are compiled for the window as it is now, and again, once, if the bookcase would have a
 * different number of lamps in a later window. What has been done is remembered beside the browser's own cache, for
 * this version of Ribbon: a new version may draw differently.
 *
 * It is only done while the library is on screen, and stops if anything else is opened.
 */

/** Where the lamp counts already compiled for are remembered, as "version/count" entries. */
const REMEMBERED = "ribbon:bookcase-warmed";

function remembered(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(REMEMBERED) ?? "[]") as string[]).filter((entry) => entry.startsWith(`${__APP_VERSION__}/`));
  } catch {
    return [];
  }
}

/** Books that stand in for a library's: between them, everything a shelf can hold. */
function standIns(): CaseBook[] {
  const books: CaseBook[] = [];
  const book = (id: string, extra: Partial<CaseBook>): CaseBook => ({ id, title: "A Stand-in", author: "Nobody", words: 90_000, fraction: 0, finished: false, addedAt: null, ...extra });
  // A hardback's spine is stamped in foil and a paperback's is printed: one of each, whichever ids make them.
  for (const paperback of [false, true]) {
    let n = 0;
    while (isPaperback(`stand-in-${n}`) !== paperback) n++;
    books.push(book(`stand-in-${n}`, {}));
  }
  // One you are in the middle of, for the ribbon of your place, and one finished.
  books.push(book("stand-in-reading", { fraction: 0.4 }), book("stand-in-read", { fraction: 1, finished: true }));
  return books;
}

let warming = false;

/**
 * Compile the bookcase's shaders for shelves `width` points wide, unless that has been done before. `k` and `scale`
 * are the bookcase page's own (ui/case-books.ts). Quietly does nothing on a machine with no graphics card, or if
 * anything goes wrong: the bookcase compiles for itself when it is opened, as it always could.
 *
 * `idle` says whether the library is still what's on screen. It is asked before each piece of work, and the rest is
 * left the moment it says no: some pieces hold the page for a third of a second, which nobody notices on a library
 * standing still, and anybody would in a book being read or a bookcase opening. Left unfinished, it is not
 * remembered as done, and starts again the next time the library is shown.
 */
export async function warmBookcaseOnce(width: number, k: number, scale: number, idle: () => boolean): Promise<void> {
  const entry = `${__APP_VERSION__}/${lampCount(width, k)}`, done = remembered();
  if (warming || !idle() || width < 200 || done.includes(entry) || !hasGraphicsCard()) return;
  const stopped = () => !idle();
  warming = true;
  // The bookcase's own two renderers, made the same way: a program compiled for one is the same text for the other.
  const shelfRenderer = makeRenderer(document.createElement("canvas"), LAMP), handRenderer = makeRenderer(document.createElement("canvas"), LAMP, false, true);
  try {
    await loadSpineFaces();
    const pictures = await loadBookPictures();
    if (stopped()) return;
    const shelfTextures = makeBookTextures(shelfRenderer, pictures), handTextures = makeBookTextures(handRenderer, pictures);
    pictures.studio.dispose();

    // A shelf, compiled alongside the page and then drawn once: drawing is what makes the graphics card's own half.
    const items = layOutCase(standIns(), width, k, measureRun, Date.now())[0] ?? [];
    const row = new ShelfRow(items, width, k, scale, shelfTextures, LAMP);
    shelfRenderer.setPixelRatio(scale);
    shelfRenderer.setSize(width, rowSize(k).height, false);
    await shelfRenderer.compileAsync(row.scene, row.camera);
    if (!stopped()) shelfRenderer.render(row.scene, row.camera);
    row.dispose();
    if (stopped()) return;

    // The book in hand, a hardback and then a paperback.
    const hand = new BookInHand(handTextures, LAMP);
    await hand.prepare(handRenderer);
    handRenderer.setPixelRatio(scale);
    handRenderer.setSize(280, 330, false);
    for (const item of items.slice(0, 3)) {
      if (stopped()) break;
      hand.show(item, null, k, scale);
      await handRenderer.compileAsync(hand.scene, hand.camera);
      handRenderer.render(hand.scene, hand.camera);
    }
    hand.dispose();
    if (!stopped()) localStorage.setItem(REMEMBERED, JSON.stringify([...done, entry]));
  } catch (error) {
    console.warn("The bookcase's shaders weren't compiled ahead: it will compile them when it is opened.", error);
  } finally {
    warming = false;
    for (const renderer of [shelfRenderer, handRenderer]) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}
