import type { WebGLRenderer } from "three";
import type { CaseItem } from "@ribbon/core/bookcase/case";
import { lampsOnInView, nextToLight, type ShelvesInView } from "@ribbon/core/bookcase/lighting";
import { BookInHand } from "./book-in-hand";
import { hasGraphicsCard, LAMP, makeRenderer, type Develop } from "./lamplight";
import { rowSize, ShelfRow } from "./shelf-row";
import { loadSpineFaces } from "./spine-art";
import { loadBookPictures, makeBookTextures, type BookTextures } from "./textures";

/** One shelf on the page: its books, the canvas its lamp-lit picture is drawn on, and its 3D scene once that is built. */
interface Shelf {
  items: readonly CaseItem[];
  canvas: HTMLCanvasElement;
  row: ShelfRow | null;
  /** Its lamp-lit picture has been drawn; until then its canvas is empty, and the page shows the shelf flat beneath it. */
  lit: boolean;
}

/**
 * Run `then` once the page has had the chance to put a frame on screen. A hidden window draws no frames, so it is
 * not waited for longer than a moment.
 */
function afterAFrame(then: () => void): void {
  let gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    then();
  };
  // A frame's callback runs before the frame is drawn; a timer set inside it runs after.
  requestAnimationFrame(() => window.setTimeout(go, 0));
  window.setTimeout(go, 100);
}

/** What the page gives the case to draw on, and to draw with. */
export interface CaseSetting {
  /** Each shelf's books and the canvas for its lamp-lit picture, top to bottom. */
  shelves: readonly { items: readonly CaseItem[]; canvas: HTMLCanvasElement }[];
  /** How wide a shelf is and how big its books, in points, and the pixels to a point it is drawn at (ui/case-books.ts, `CASE_SCALE`). */
  width: number;
  k: number;
  scale: number;
  /** The shelves on screen, which are lit first. */
  view: ShelvesInView;
}

/**
 * The lamp-lit bookcase, as a page draws it. Each shelf is its own small 3D scene, but it is only drawn when
 * something on it moves: at rest it is a still picture on a canvas, so scrolling the page draws nothing. One book is
 * off its shelf and in your hand at a time; the shelf it came from is redrawn while it tips and slides, and the book
 * in hand while it turns.
 *
 * Two renderers do all of it, however many shelves there are: one draws every shelf in turn and its picture is
 * copied to that shelf's canvas; the other draws the book in hand straight onto its own. (A page may only have a
 * handful of 3D canvases, far fewer than a library has shelves.)
 *
 * Opening is the one time there is a lot to draw at once, and a shelf's first picture is a block of work the page can
 * do nothing else during. So the lamps come on in an order (core/bookcase/lighting.ts): the shelves in view first,
 * each marked `data-lit` for the page to fade in over the flat shelf beneath; then the book asked for is taken down;
 * and the shelves out of view are lit whenever nothing is moving.
 *
 * On a machine with no graphics card nothing is lit: the page's flat shelves are all there is, and there is no book
 * in hand.
 */
export class LamplitCase {
  private shelves: Shelf[] = [];
  private width = 0;
  private k = 1;
  private scale = 1;
  private readonly hand: BookInHand | null;
  /** The book asked for, and the book off its shelf now: the same once the lamps in view are on. */
  private selected: string | null = null;
  private lifted: string | null = null;
  private view: ShelvesInView = { first: 0, last: 0 };
  private frame = 0;
  /** A shelf is being lit now, and how many times the case has been laid: a shelf lit for an older laying is dropped. */
  private lighting = false;
  private laid = 0;
  private closed = false;
  /** Asks for the book in hand, newest last: an answer to an older ask than the last is thrown away. */
  private asks = 0;
  /** Covers being fetched for the book in hand: it is about to move. */
  private fetching = 0;
  /**
   * How long things took, in milliseconds, for the measurement build: opening the case, then, from the moment the
   * shelves were last laid out, lighting the first, and lighting the last.
   */
  readonly times: { opened: number; firstLit?: number; allLit?: number } = { opened: 0 };
  /** The gaps between the frames drawn since this was last emptied, in milliseconds. */
  frames: number[] = [];
  private laidAt = 0;
  private lastFrame = 0;

  private constructor(
    private readonly develop: Develop,
    private readonly shelfRenderer: WebGLRenderer | null,
    private readonly handRenderer: WebGLRenderer | null,
    private readonly shelfTextures: BookTextures | null,
    handTextures: BookTextures | null,
    private readonly coverOf: (item: CaseItem) => Promise<CanvasImageSource | null>,
  ) {
    this.hand = handTextures ? new BookInHand(handTextures, develop) : null;
  }

  /** The canvas the book in hand is drawn on, for the page to put where the book goes. Null when the case stays flat. */
  get handCanvas(): HTMLCanvasElement | null {
    return this.handRenderer?.domElement ?? null;
  }

  /**
   * Open the case: load the spines' faces and, where there's a graphics card, the cloth and the studio.
   * `coverOf` fetches a book's cover for its front board.
   */
  static async open(coverOf: (item: CaseItem) => Promise<CanvasImageSource | null>, develop: Develop = LAMP): Promise<LamplitCase> {
    const began = performance.now();
    await loadSpineFaces();
    if (!hasGraphicsCard()) return new LamplitCase(develop, null, null, null, null, coverOf);
    try {
      const shelfRenderer = makeRenderer(document.createElement("canvas"), develop), handRenderer = makeRenderer(document.createElement("canvas"), develop, false, true);
      // Each renderer has its own graphics-card memory, so each makes its own textures, from pictures loaded once.
      const pictures = await loadBookPictures();
      const shelfTextures = makeBookTextures(shelfRenderer, pictures), handTextures = makeBookTextures(handRenderer, pictures);
      pictures.studio.dispose();
      const opened = new LamplitCase(develop, shelfRenderer, handRenderer, shelfTextures, handTextures, coverOf);
      // Not waited for: the shelves are laid meanwhile, and a book taken down before it is done waits only for what's left.
      void opened.hand?.prepare(handRenderer);
      opened.times.opened = performance.now() - began;
      return opened;
    } catch (error) {
      console.warn("The bookcase stays flat: its 3D picture couldn't be set up.", error);
      return new LamplitCase(develop, null, null, null, null, coverOf);
    }
  }

  /** Whether the shelves are lit in 3D, or flat for want of a graphics card. */
  get lit(): boolean {
    return this.shelfRenderer !== null;
  }

  /**
   * Lay the case out on the page's canvases, and light it: the shelves in view first. Called again when the page
   * changes size, or the books do.
   */
  lay(setting: CaseSetting): void {
    for (const shelf of this.shelves) shelf.row?.dispose();
    this.laid++;
    this.lighting = false;
    this.laidAt = performance.now();
    delete this.times.firstLit;
    delete this.times.allLit;
    this.width = setting.width;
    this.k = setting.k;
    this.scale = setting.scale;
    this.view = setting.view;
    const { height } = rowSize(this.k);
    this.shelves = setting.shelves.map(({ items, canvas }) => {
      // Sizing a canvas empties it, so the flat shelf beneath shows until this one is lit again.
      canvas.width = Math.round(this.width * this.scale);
      canvas.height = Math.round(height * this.scale);
      delete canvas.dataset.lit;
      return { items, canvas, row: null, lit: false };
    });
    this.shelfRenderer?.setPixelRatio(this.scale);
    this.shelfRenderer?.setSize(this.width, Math.round(height * this.scale) / this.scale, false);
    // The shelves are new, so no book is off them, and a cover on its way was for the old ones.
    this.lifted = null;
    this.asks++;
    this.light();
  }

  /** The page was scrolled: these shelves are in view now. */
  look(view: ShelvesInView): void {
    this.view = view;
    this.light();
  }

  /** Whether anything is moving, or about to: a book on its way off a shelf, or turning in hand. */
  private get moving(): boolean {
    return this.frame !== 0 || this.fetching > 0;
  }

  /**
   * Light the next shelf whose turn it is, and the one after once this one's picture is on screen, so each lamp is
   * seen to come on and the page can answer in between. With none left to light in view, the book asked for comes
   * down, and the shelves out of view wait until it has.
   */
  private light(): void {
    if (this.lighting || this.closed) return;
    // The book first, if the lamps in view are on: then it is moving, and the shelves out of view wait for it.
    this.bring();
    const lit = this.shelves.map((shelf) => shelf.lit);
    const next = this.shelfRenderer ? nextToLight(lit, this.view, this.moving) : null;
    if (next === null) {
      if (this.shelfRenderer && lit.every(Boolean)) this.times.allLit ??= performance.now() - this.laidAt;
      return;
    }
    const laid = this.laid;
    this.lighting = true;
    void this.lightShelf(this.shelves[next]!).then(() => {
      if (laid !== this.laid || this.closed) return;
      this.times.firstLit ??= performance.now() - this.laidAt;
      afterAFrame(() => {
        if (laid !== this.laid) return;
        this.lighting = false;
        this.light();
      });
    });
  }

  /** Build a shelf, draw it under its lamps, and mark its canvas lit for the page to fade in. */
  private async lightShelf(shelf: Shelf): Promise<void> {
    const renderer = this.shelfRenderer!, laid = this.laid;
    const row = this.rowOf(shelf);
    // The programs a shelf is drawn with are compiled alongside the page where the browser can
    // (KHR_parallel_shader_compile), not in the frame it is first drawn. Only the first shelf has any to compile.
    await renderer.compileAsync(row.scene, row.camera);
    if (laid !== this.laid || this.closed) return;
    row.settle();
    this.draw(shelf);
    shelf.canvas.dataset.lit = "";
  }

  /** A shelf's 3D scene, built the first time it is wanted. */
  private rowOf(shelf: Shelf): ShelfRow {
    shelf.row ??= new ShelfRow(shelf.items, this.width, this.k, this.scale, this.shelfTextures!, this.develop);
    return shelf.row;
  }

  /** Draw a shelf under its lamps and copy the picture to its canvas. */
  private draw(shelf: Shelf): void {
    const renderer = this.shelfRenderer;
    if (!renderer) return;
    const row = this.rowOf(shelf);
    renderer.render(row.scene, row.camera);
    const ctx = shelf.canvas.getContext("2d")!;
    ctx.drawImage(renderer.domElement, 0, 0, shelf.canvas.width, shelf.canvas.height);
    shelf.lit = true;
  }

  /** The book now off its shelf, by its id. */
  get taken(): string | null {
    return this.selected;
  }

  /**
   * Take a book down: off its shelf, tipped then drawn out, and into your hand. The book taken before goes back.
   * It waits for the lamps in view to come on.
   */
  takeDown(id: string): void {
    if (id === this.selected || this.closed) return;
    this.selected = id;
    this.bring();
  }

  /**
   * Bring the book asked for down, unless a shelf in view is still to be lit: `light` calls this again when they
   * all are. Its cover is fetched and the book in hand built before anything moves, so the building, a long frame's
   * work, falls before the movement and not in the middle of it.
   */
  private bring(): void {
    const id = this.selected;
    if (id === this.lifted || id === null || this.closed) return;
    if (this.shelfRenderer && !lampsOnInView(this.shelves.map((shelf) => shelf.lit), this.view)) return;
    this.lifted = id;
    const item = this.shelves.flatMap((shelf) => shelf.items).find((it) => it.book.id === id);
    const hand = this.hand, ask = ++this.asks;
    if (!item || !hand) return this.lift(id);
    this.fetching++;
    void this.coverOf(item)
      .catch(() => null)
      .then((cover) => {
        this.fetching--;
        // A newer ask has taken over, or the case was laid again and will ask again.
        if (ask !== this.asks || this.closed) return this.light();
        hand.show(item, cover, this.k, this.scale);
        this.lift(id);
      });
  }

  /** Start the book's movement off its shelf, and the last one's back onto it. */
  private lift(id: string): void {
    const now = performance.now();
    for (const shelf of this.shelves) {
      const holds = shelf.items.some((it) => it.book.id === id);
      // A shelf not yet built has nothing to put back, and is built only to take a book from it.
      if (holds && this.shelfRenderer) this.rowOf(shelf).lift(id, now);
      else shelf.row?.lift(null, now);
    }
    this.run();
  }

  /** The book in hand turned by the pointer, by `dx` points. */
  turnInHand(dx: number): void {
    this.hand?.turnBy(dx);
    this.run();
  }

  /** The book in hand's canvas changed size on the page. */
  sizeHand(width: number, height: number): void {
    if (!this.handRenderer || !this.hand || width < 1 || height < 1) return;
    this.handRenderer.setPixelRatio(this.scale);
    this.handRenderer.setSize(width, height, false);
    this.hand.camera.aspect = width / height;
    this.hand.camera.updateProjectionMatrix();
    this.run();
  }

  /** Draw frames while anything is moving, and stop when everything has come to rest. */
  private run(): void {
    if (this.frame || this.closed) return;
    this.lastFrame = 0;
    const tick = (now: number) => {
      this.frame = 0;
      if (this.lastFrame) this.frames.push(now - this.lastFrame);
      this.lastFrame = now;
      let moving = false;
      for (const shelf of this.shelves) {
        if (!shelf.row) continue;
        const was = shelf.row.step(now);
        // A shelf still to be lit for the first time is left to its turn, when its books will be where they've come to.
        if (shelf.lit) this.drawIfMoved(shelf, was);
        moving ||= was;
      }
      if (this.hand && this.handRenderer) {
        moving = this.hand.step(now) || moving;
        this.handRenderer.render(this.hand.scene, this.hand.camera);
      }
      if (moving) this.frame = requestAnimationFrame(tick);
      else this.rest();
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Shelves whose books moved this frame, and those that have just stopped, are drawn; the rest keep their picture. */
  private readonly moved = new Set<Shelf>();
  private drawIfMoved(shelf: Shelf, moving: boolean): void {
    if (!moving && !this.moved.has(shelf)) return;
    this.draw(shelf);
    if (moving) this.moved.add(shelf);
    else this.moved.delete(shelf);
  }

  /**
   * Everything has come to rest: shelves with no book out let their lamps' shadow maps go, and the shelves out of
   * view that were waiting for the page to be still are lit.
   */
  private rest(): void {
    for (const shelf of this.shelves) {
      if (shelf.row && !shelf.items.some((it) => it.book.id === this.lifted)) shelf.row.restLamps();
    }
    this.light();
  }

  /** Close the case: stop drawing and let everything go from the graphics card. */
  close(): void {
    this.closed = true;
    cancelAnimationFrame(this.frame);
    for (const shelf of this.shelves) shelf.row?.dispose();
    this.hand?.dispose();
    for (const renderer of [this.shelfRenderer, this.handRenderer]) {
      renderer?.dispose();
      renderer?.forceContextLoss();
    }
  }
}
