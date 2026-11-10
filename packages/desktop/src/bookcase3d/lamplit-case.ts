import type { WebGLRenderer } from "three";
import type { CaseItem } from "@ribbon/core/bookcase/case";
import { BookInHand } from "./book-in-hand";
import { hasGraphicsCard, LAMP, makeRenderer, type Develop } from "./lamplight";
import { drawFlatShelf, rowSize, ShelfRow } from "./shelf-row";
import { loadSpineFaces } from "./spine-art";
import { loadBookTextures, type BookTextures } from "./textures";

/** One shelf on the page: its books, the canvas its picture is drawn on, and its 3D scene once that is built. */
interface Shelf {
  items: readonly CaseItem[];
  canvas: HTMLCanvasElement;
  row: ShelfRow | null;
  /** Its lamp-lit picture has been drawn; until then the canvas shows it flat. */
  lit: boolean;
}

/** What the page gives the case to draw on, and to draw with. */
export interface CaseSetting {
  /** The canvas of each shelf, top to bottom. */
  shelves: readonly { items: readonly CaseItem[]; canvas: HTMLCanvasElement }[];
  /** How wide a shelf is and how big its books, in points, and the screen's pixels to a point. */
  width: number;
  k: number;
  scale: number;
  /** Which shelf to light first: the one in view. */
  first: number;
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
 * On a machine with no graphics card the shelves stay as they are first drawn, flat, and there is no book in hand.
 */
export class LamplitCase {
  private shelves: Shelf[] = [];
  private width = 0;
  private k = 1;
  private scale = 1;
  private readonly hand: BookInHand | null;
  private selected: string | null = null;
  private frame = 0;
  private building = 0;
  private closed = false;
  /** Asks for the book in hand, newest last: an answer to an older ask than the last is thrown away. */
  private asks = 0;
  /**
   * How long things took, in milliseconds, for the measurement build: opening the case, then, from the moment the
   * shelves were last laid out, drawing them all flat, lighting the first, and lighting the last.
   */
  readonly times: { opened: number; flat?: number; firstLit?: number; allLit?: number } = { opened: 0 };
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
      // Each renderer has its own graphics-card memory, so each loads the cloth and the studio for itself.
      const [shelfTextures, handTextures] = await Promise.all([loadBookTextures(shelfRenderer), loadBookTextures(handRenderer)]);
      const opened = new LamplitCase(develop, shelfRenderer, handRenderer, shelfTextures, handTextures, coverOf);
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
   * Lay the case out on the page's canvases: every shelf flat at once, then each lit in turn, the one in view first.
   * Called again when the page changes size, or the books do.
   */
  lay(setting: CaseSetting): void {
    window.clearTimeout(this.building);
    for (const shelf of this.shelves) shelf.row?.dispose();
    this.laidAt = performance.now();
    delete this.times.firstLit;
    delete this.times.allLit;
    this.width = setting.width;
    this.k = setting.k;
    this.scale = setting.scale;
    const { height } = rowSize(this.k);
    this.shelves = setting.shelves.map(({ items, canvas }) => {
      canvas.width = Math.round(this.width * this.scale);
      canvas.height = Math.round(height * this.scale);
      drawFlatShelf(canvas.getContext("2d")!, items, this.width, this.k, this.scale);
      return { items, canvas, row: null, lit: false };
    });
    this.times.flat = performance.now() - this.laidAt;
    this.shelfRenderer?.setPixelRatio(this.scale);
    this.shelfRenderer?.setSize(this.width, Math.round(height * this.scale) / this.scale, false);
    const taken = this.selected;
    this.selected = null;
    if (taken) this.takeDown(taken);
    this.lightFrom(setting.first);
  }

  /** Light the shelves one at a time, nearest `first` first, leaving the page free to answer between each. */
  private lightFrom(first: number): void {
    if (!this.shelfRenderer) return;
    const order = this.shelves.map((_, i) => i).sort((a, b) => Math.abs(a - first) - Math.abs(b - first));
    const next = () => {
      const i = order.find((n) => !this.shelves[n]!.lit);
      if (this.closed) return;
      if (i === undefined) {
        this.times.allLit ??= performance.now() - this.laidAt;
        return;
      }
      this.draw(this.shelves[i]!);
      this.times.firstLit ??= performance.now() - this.laidAt;
      this.building = window.setTimeout(next, 0);
    };
    this.building = window.setTimeout(next, 0);
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

  /** Take a book down: off its shelf, tipped then drawn out, and into your hand. The book taken before goes back. */
  takeDown(id: string): void {
    if (id === this.selected || this.closed) return;
    this.selected = id;
    const now = performance.now();
    for (const shelf of this.shelves) {
      const item = shelf.items.find((it) => it.book.id === id);
      // A shelf not yet built has nothing to put back, and is built only to take a book from it.
      if (item && this.shelfRenderer) this.rowOf(shelf).lift(id, now);
      else shelf.row?.lift(null, now);
      if (item) this.hold(item);
    }
    this.run();
  }

  private hold(item: CaseItem): void {
    const hand = this.hand, ask = ++this.asks;
    if (!hand) return;
    void this.coverOf(item)
      .catch(() => null)
      .then((cover) => {
        if (ask !== this.asks || this.closed) return;
        hand.show(item, cover, this.k, this.scale, performance.now());
        this.run();
      });
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
        if (was || shelf.lit) this.drawIfMoved(shelf, was);
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

  /** Everything has come to rest: shelves with no book out let their lamps' shadow maps go. */
  private rest(): void {
    for (const shelf of this.shelves) {
      if (shelf.row && !shelf.items.some((it) => it.book.id === this.selected)) shelf.row.restLamps();
    }
  }

  /** Close the case: stop drawing and let everything go from the graphics card. */
  close(): void {
    this.closed = true;
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.building);
    for (const shelf of this.shelves) shelf.row?.dispose();
    this.hand?.clear();
    for (const renderer of [this.shelfRenderer, this.handRenderer]) {
      renderer?.dispose();
      renderer?.forceContextLoss();
    }
  }
}
