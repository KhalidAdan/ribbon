import { CanvasTexture, Group, PerspectiveCamera, Scene, SRGBColorSpace, type WebGLRenderer } from "three";
import { CASE_SHELF_HEIGHT, SPINE_FACES, type CaseItem, type SpineFace } from "@ribbon/core/bookcase/case";
import { CREAM, hexOf, type Cloth } from "@ribbon/core/bookcase/cloth";
import { makeBook, roundness, type BookLook } from "./book-model";
import { letGo, lightInHand, type Develop } from "./lamplight";
import { spineDress, swallowtail } from "./shelf-row";
import { baselineAbout, drawRun, measureRun } from "./spine-art";
import { canvasOf, type BookTextures } from "./textures";

/** Turned to show its cover, a little more than square-on so the spine still shows. */
const COVER_ON = (-58 * Math.PI) / 180;

/** How long a cover takes to come into focus on the front board once its picture has arrived, in milliseconds. */
const DEVELOP_MS = 520;
/** How small the cover is drawn, against its full size, when it is at its softest. */
const SOFTEST = 1 / 28;

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/** The front board's picture while its cover comes into focus: the board as it was, and as it will be. */
interface Developing {
  start: number;
  plain: HTMLCanvasElement;
  finished: HTMLCanvasElement;
  soft: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
}

/** The front board of the book in hand: the canvas its picture is drawn on, and what it is drawn at. */
interface FrontBoard {
  item: CaseItem;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  width: number;
  height: number;
  scale: number;
}

/**
 * The lectern's book: the one you're on, in your hand. It comes spine-on, as it left the shelf, and turns to its
 * cover; it can be turned by hand. The Apple app's is packages/apple/Ribbon/Bookcase/BookInHand.swift.
 */
export class BookInHand {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(22, 1, 10, 5000);
  private book: Group | null = null;
  private shown: string | null = null;
  /** How far round it is now, and the turn to its cover it is in the middle of. */
  private yaw = 0;
  private turning: { start: number; from: number } | null = null;
  /** Its front board, and the cover coming into focus on it, if one is. */
  private front: FrontBoard | null = null;
  private developing: Developing | null = null;
  /**
   * A hardback and a paperback that are never drawn, kept so the shader programs every book in hand is drawn with stay
   * compiled. Three.js lets a program go once no material uses it, so without them each book put down took its
   * programs with it, and the next was compiled afresh in the frame it was taken down: on Windows, where WebGL runs on
   * Direct3D and compiling is slow, half a second the first time and a tenth of a second every time after.
   */
  private readonly standIns = new Group();

  constructor(private readonly textures: BookTextures, develop: Develop) {
    lightInHand(this.scene, textures.studio, develop);
  }

  /**
   * Compile the programs every book in hand is drawn with, before any is taken down: with the stand-ins, under this
   * scene's lights. The browser compiles them alongside the page where it can (KHR_parallel_shader_compile).
   */
  prepare(renderer: WebGLRenderer): Promise<unknown> {
    // The stand-ins wear plain pictures: what a program is depends on which pictures a book wears, not what is on them.
    const plain = new CanvasTexture(canvasOf(1, 1).canvas);
    for (const paperback of [false, true]) {
      const look: BookLook = { spine: plain, front: plain, cloth: CREAM, headband: [CREAM, CREAM] };
      if (!paperback) look.spineFoil = plain;
      this.standIns.add(makeBook(30, 200, 136, look, this.textures, paperback));
    }
    // And the ribbon of your place.
    this.standIns.add(swallowtail(5, 30));
    return renderer.compileAsync(this.standIns, this.camera, this.scene);
  }

  /** The book now in hand, by its id. */
  get holding(): string | null {
    return this.shown;
  }

  /**
   * Take a book in hand: spine-on at first, turning to its front a moment later. It comes bound in its cloth with its
   * title on the board, as a book with no cover is; its picture is fetched only now that it is in hand, and `develop`
   * puts it on the board when it arrives. The turn is timed from when the book has been built, which takes a frame
   * or several.
   */
  show(item: CaseItem, k: number, scale: number): void {
    const fit = (CASE_SHELF_HEIGHT * k) / 0.95;
    this.camera.position.set(0, fit * 0.18, fit / (2 * Math.tan((11 * Math.PI) / 180)));
    this.camera.lookAt(0, 0, 0);
    this.clear();
    this.book = this.build(item, k, scale);
    this.shown = item.book.id;
    this.scene.add(this.book);
    this.yaw = 0;
    this.turning = { start: performance.now() + 140, from: 0 };
  }

  /** Put the book down, and let it go from the graphics card. */
  clear(): void {
    if (!this.book) return;
    this.scene.remove(this.book);
    letGo(this.book);
    this.book = null;
    this.shown = null;
    this.front = null;
    this.developing = null;
  }

  /**
   * The cover of the book in hand has arrived: bring it into focus on the front board, out of a blur, over the cloth
   * that stood for it. Nothing happens if another book has been taken up since. With reduced motion it is simply there.
   */
  develop(id: string, cover: CanvasImageSource, now: number): void {
    const f = this.front;
    if (!f || this.shown !== id) return;
    const plain = canvasOf(f.canvas.width, f.canvas.height), finished = canvasOf(f.canvas.width, f.canvas.height);
    plain.ctx.drawImage(f.canvas, 0, 0);
    finished.ctx.scale(f.scale, f.scale);
    drawFront(finished.ctx, f.width, f.height, f.item.book.title, f.item.book.author, cover, f.item.cloth);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.developing = { start: still ? now - DEVELOP_MS : now, plain: plain.canvas, finished: finished.canvas, soft: canvasOf(1, 1) };
  }

  /**
   * Draw the front board as it is at this time: the finished cover over the plain board, small and stretched back to
   * size while it is soft (a blur every browser draws the same, where a canvas filter is Chromium's alone), sharper
   * and more solid as it comes. True while it is still coming.
   */
  private focus(now: number): boolean {
    const d = this.developing, f = this.front;
    if (!d || !f) return false;
    const t = Math.min(1, Math.max(0, (now - d.start) / DEVELOP_MS)), { width, height } = f.canvas;
    f.ctx.save();
    f.ctx.setTransform(1, 0, 0, 1, 0, 0);
    f.ctx.drawImage(d.plain, 0, 0);
    if (t >= 1) f.ctx.drawImage(d.finished, 0, 0);
    else {
      const size = SOFTEST + (1 - SOFTEST) * Math.pow(easeOut(t), 3);
      d.soft.canvas.width = Math.max(2, Math.round(width * size));
      d.soft.canvas.height = Math.max(2, Math.round(height * size));
      d.soft.ctx.imageSmoothingQuality = "high";
      d.soft.ctx.drawImage(d.finished, 0, 0, d.soft.canvas.width, d.soft.canvas.height);
      f.ctx.globalAlpha = Math.min(1, t * 2.5);
      f.ctx.imageSmoothingQuality = "high";
      f.ctx.drawImage(d.soft.canvas, 0, 0, width, height);
    }
    f.ctx.restore();
    f.texture.needsUpdate = true;
    if (t >= 1) this.developing = null;
    return t < 1;
  }

  /** Put everything down for good, the stand-ins too. */
  dispose(): void {
    this.clear();
    letGo(this.standIns);
  }

  /**
   * Turn the book to where it should be at this time, and bring its cover as far into focus as it should be. True
   * while either is still under way, so it needs drawing again.
   */
  step(now: number): boolean {
    const focusing = this.focus(now);
    if (!this.book || !this.turning) return focusing;
    const t = Math.min(1, Math.max(0, (now - this.turning.start) / 560));
    this.yaw = this.turning.from + (COVER_ON - this.turning.from) * easeOut(t);
    this.book.rotation.y = this.yaw;
    if (t >= 1) this.turning = null;
    return this.turning !== null || focusing;
  }

  /** Turned by hand: `dx` is how far the pointer has moved since the last call, in points. */
  turnBy(dx: number): void {
    if (!this.book) return;
    this.turning = null;
    this.yaw += dx * 0.01;
    this.book.rotation.y = this.yaw;
  }

  /** The book in hand: its title on the front board until its cover comes, its spine as on the shelf, its ribbon at your place. */
  private build(item: CaseItem, k: number, scale: number): Group {
    const b = item.book, W = item.spine.width, H = item.spine.height, D = Math.round(H * 0.68);
    // Drawn finer than the shelf: the book in hand is about twice its size there.
    const s = Math.min(3, scale * 1.25);
    const front = canvasOf(D * s, H * s);
    front.ctx.scale(s, s);
    drawFront(front.ctx, D, H, b.title, b.author, null, item.cloth);
    const art = new CanvasTexture(front.canvas);
    art.colorSpace = SRGBColorSpace;
    art.anisotropy = 8;
    this.front = { item, canvas: front.canvas, ctx: front.ctx, texture: art, width: D, height: H, scale: s };
    const model = makeBook(W, H, D, spineDress(item, art, k, s, this.textures).look, this.textures, item.paperback);
    // Turned about its own middle.
    model.position.set(-W / 2, -H / 2, (D - roundness(W, item.paperback)) / 2);
    const held = new Group();
    held.add(model);
    // Your place: the ribbon hangs out of the pages, as far through the book as you are, counted from the front board.
    if (b.fraction > 0 && !b.finished) {
      const board = Math.min(Math.max(H * 0.011, 1.0), W * 0.12);
      const ribbon = swallowtail(5 * k, H * 0.16);
      ribbon.rotation.y = Math.PI / 2;
      ribbon.position.set(W - board - b.fraction * (W - 2 * board), H * 0.012 + 1, -D * 0.5);
      model.add(ribbon);
    }
    return held;
  }
}

const COVER_TITLE: SpineFace = { serif: true, weight: 500, upper: false, tracking: 0, lineHeight: 1.1 };

/**
 * A book's front board: its own cover. Square audiobook art sits at the top of a book-shaped cover with the title on
 * a band below, as a jacket would set it; with no cover, the title on its cloth.
 */
function drawFront(ctx: CanvasRenderingContext2D, w: number, h: number, title: string, author: string, cover: CanvasImageSource | null, cloth: Cloth): void {
  ctx.fillStyle = hexOf(cloth.ground);
  ctx.fillRect(0, 0, w, h);
  const size = cover ? sizeOf(cover) : null;
  const square = size ? Math.abs(size.width / size.height - 1) < 0.15 : false;
  if (cover && size && (!square || h <= w * 1.1)) return fill(ctx, cover, size, 0, 0, w, h);
  if (cover && size) fill(ctx, cover, size, 0, 0, w, w);
  const band = cover ? h - w : h, top = cover ? w : 0, most = cover ? 2 : 4;
  let type = band * (cover ? 0.26 : 0.1), lines = [title];
  while (type > band * 0.04) {
    lines = wrapWords(title, type, w * 0.84);
    if (lines.length <= most && lines.every((l) => measureRun(l, COVER_TITLE) * type <= w * 0.86)) break;
    type *= 0.93;
  }
  const shown = lines.slice(0, most), ink = hexOf(cloth.ink), cy = top + band * 0.42;
  shown.forEach((line, i) => drawRun(ctx, line, COVER_TITLE, type, w / 2, baselineAbout(cy + (i - (shown.length - 1) / 2) * type * 1.1, COVER_TITLE, type), ink));
  const by = author.toUpperCase();
  const authorSize = Math.min(band * (cover ? 0.11 : 0.035), (w * 0.8) / Math.max(1, measureRun(by, SPINE_FACES.label)));
  drawRun(ctx, by, SPINE_FACES.label, authorSize, w / 2, h - band * 0.14, `rgba(${cloth.ink.r}, ${cloth.ink.g}, ${cloth.ink.b}, 0.8)`);
}

function sizeOf(picture: CanvasImageSource): { width: number; height: number } {
  const p = picture as { naturalWidth?: number; naturalHeight?: number; width: number; height: number };
  return { width: p.naturalWidth || p.width, height: p.naturalHeight || p.height };
}

/** A picture filling a rectangle, cropped to its shape. */
function fill(ctx: CanvasRenderingContext2D, picture: CanvasImageSource, size: { width: number; height: number }, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / size.width, h / size.height), cw = w / scale, ch = h / scale;
  ctx.drawImage(picture, (size.width - cw) / 2, (size.height - ch) / 2, cw, ch, x, y, w, h);
}

function wrapWords(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const longer = line ? `${line} ${word}` : word;
    if (line && measureRun(longer, COVER_TITLE) * size > maxWidth) {
      lines.push(line);
      line = word;
    } else line = longer;
  }
  if (line) lines.push(line);
  return lines;
}
