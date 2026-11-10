import { BoxGeometry, CanvasTexture, DoubleSide, Group, Mesh, MeshStandardMaterial, NoColorSpace, PerspectiveCamera, PlaneGeometry, Scene, Shape, ShapeGeometry, type SpotLight, SRGBColorSpace, type Texture } from "three";
import { CASE_SHELF_HEIGHT, SPINE_FACES, type CaseItem } from "@ribbon/core/bookcase/case";
import { CREAM, hexOf, rgb, type RGB } from "@ribbon/core/bookcase/cloth";
import { colourOf, makeBook, material, roundness, tiled, type BookLook } from "./book-model";
import { CASE_BACK, CASE_BOARD, letGo, lightShelf, type Develop } from "./lamplight";
import { baselineAbout, drawRun, measureRun, spineArt, spineFoil } from "./spine-art";
import { canvasOf, type BookTextures } from "./textures";

/** How far the camera looks down on a shelf, in degrees: enough to see the books' tops and the shelf's depth. */
export const SHELF_TILT = 6;

/** The app's own background, behind the case, so nothing shows where the scene ends. */
const CANVAS = rgb(0x0a0a0a);
/** The ribbon of your place: amber silk. */
const PLACE = rgb(0xf5a524);

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** A picture as a texture in colour, sharp when seen small or at a slant. */
function pictureTexture(canvas: HTMLCanvasElement, colour = true): Texture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** A book standing where the layout puts it. `pivot` is the book itself, for taking it down. */
interface Standing {
  pivot: Group;
  depth: number;
  /** Its spine drawn flat, for the shelf before its 3D picture is ready. */
  art: HTMLCanvasElement;
  /** How far it is tipped and drawn out now, each 0 to 1, and the movement it is in the middle of. */
  tip: number;
  out: number;
  moving: Movement[];
}

/** One part of a book's movement: tipping or sliding, from where it was to where it's going. */
interface Movement {
  part: "tip" | "out";
  from: number;
  to: number;
  /** When it starts, in milliseconds, and how long it takes. */
  start: number;
  lasts: number;
  ease: (t: number) => number;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/**
 * A spine's art and its foil: the lettering and rules stamped in metal and smoother than the cloth around them.
 * A paperback's spine is printed, so it has no foil; a hardback's headband is in its foil's colour and cream.
 * `flat` is the same art as a picture, for drawing the shelf flat.
 */
export function spineDress(item: CaseItem, front: BookLook["front"], k: number, scale: number, textures: BookTextures): { look: BookLook; flat: HTMLCanvasElement } {
  const { spine, cloth, paperback } = item;
  const flat = spineArt(spine, cloth, k, scale, paperback ? null : textures.clothFibresPicture);
  const look: BookLook = { spine: pictureTexture(flat), front, cloth: cloth.ground, headband: [cloth.foil, CREAM] };
  if (!paperback) look.spineFoil = pictureTexture(spineFoil(spine, k, Math.max(1, scale / 2)), false);
  return { look, flat };
}

/** The case's wood: its colour with the grain running along the shelf. Matte, as old wood is. */
export function caseWood(textures: BookTextures, colour: RGB, rough: number, along: number): MeshStandardMaterial {
  return material({ colour: colourOf(colour), map: tiled(textures.woodGrain, along / 420, 1), rough });
}

/**
 * A book standing spine-out where the layout puts it, with the ribbon of your place hanging over the shelf's edge.
 * `node` holds both, ready to add to a scene; `pivot` is the book itself, for taking it down; `art` is its spine drawn flat.
 * `front` is how far the shelf's board stands in front of the spines.
 */
export function standBook(item: CaseItem, k: number, scale: number, front: number, textures: BookTextures): { node: Group; pivot: Group; depth: number; art: HTMLCanvasElement } {
  const { spine: s, cloth, book: b, paperback } = item;
  const depth = Math.min(Math.round(s.height * 0.66), Math.round(144 * k));
  const { look, flat: art } = spineDress(item, cloth.ground, k, scale, textures);
  const book = makeBook(s.width, s.height, depth, look, textures, paperback);
  // The spine's crown at the shelf's front line, where the flat spine stood.
  book.position.set(0, 0, -roundness(s.width, paperback));
  const pivot = new Group();
  pivot.name = b.id;
  pivot.position.set(item.x, 0, 0);
  if (item.lean) pivot.rotation.z = radians(8);
  pivot.add(book);
  const node = new Group();
  node.add(pivot);
  // Your place: the ribbon hangs over the shelf's edge.
  if (b.fraction > 0 && !b.finished) {
    const cx = item.x + s.width / 2, w = 5 * k;
    const hang = swallowtail(w, 22 * k);
    hang.position.set(cx, 0, front + 0.4);
    const flat = new Mesh(new PlaneGeometry(w, front + 2), hang.material);
    flat.castShadow = flat.receiveShadow = true;
    flat.rotation.x = -Math.PI / 2;
    flat.position.set(cx, 0.3, front / 2 - 1);
    node.add(hang, flat);
  }
  return { node, pivot, depth, art };
}

/** The ribbon marking your place: a swallowtail of amber silk, lit like everything else, so it glows under a lamp rather than burning out. */
export function swallowtail(width: number, length: number): Mesh {
  const tail = new Shape();
  tail.moveTo(-width / 2, 0);
  tail.lineTo(width / 2, 0);
  tail.lineTo(width / 2, -length);
  tail.lineTo(0, -0.8 * length);
  tail.lineTo(-width / 2, -length);
  tail.closePath();
  const ribbon = new Mesh(new ShapeGeometry(tail), new MeshStandardMaterial({ color: colourOf(PLACE, 0.8), roughness: 0.45, metalness: 0, side: DoubleSide }));
  ribbon.castShadow = ribbon.receiveShadow = true;
  return ribbon;
}

/**
 * One shelf of the bookcase as its own small scene, seen through a long lens that only tilts down a little, so every
 * spine is where the layout puts it. The Apple app's shelf is packages/apple/Ribbon/Bookcase/ShelfRow.swift.
 */
export class ShelfRow {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Where the books' bottom edge sits, from the row's top, and the row's height, in points. */
  readonly top: number;
  readonly height: number;
  private readonly standing = new Map<string, Standing>();
  /** The book drawn out of this shelf, if any. */
  private lifted: string | null = null;

  constructor(readonly items: readonly CaseItem[], readonly width: number, readonly k: number, scale: number, textures: BookTextures, develop: Develop) {
    const W = width, a = radians(SHELF_TILT), ca = Math.cos(a), sa = Math.sin(a);
    const pad = Math.round(16 * k), shelfH = Math.round(CASE_SHELF_HEIGHT * k), boardH = Math.round(12 * k);
    const front = Math.round(8 * k), depth = Math.round(150 * k);
    // The row runs from the front edge of the shelf above to the front edge of its own board, as the camera sees them.
    this.top = (pad + shelfH) * ca - front * sa;
    const bottom = -boardH * ca - front * sa;
    this.height = this.top - bottom;

    const distance = this.height / 2 / Math.tan(radians(7));
    this.camera = new PerspectiveCamera(14, W / this.height, distance * 0.5, distance * 2);
    const c = (this.top + bottom) / 2;
    this.camera.position.set(W / 2, c * ca + distance * sa, -c * sa + distance * ca);
    this.camera.rotation.set(-a, 0, 0);
    this.scene.background = colourOf(CANVAS);

    const wood = (colour: RGB, rough: number) => caseWood(textures, colour, rough, W);
    const add = (mesh: Mesh, x: number, y: number, z: number, casts = true) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = casts;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };

    add(new Mesh(new PlaneGeometry(W, pad + shelfH + 2 * boardH + 400), wood(CASE_BACK, 0.9)), W / 2, (pad + shelfH) / 2, -depth, false);

    // Its board, labelled on its front edge where each month begins.
    const labels = canvasOf(W * scale, boardH * scale);
    labels.ctx.scale(scale, scale);
    labels.ctx.fillStyle = hexOf(CASE_BOARD);
    labels.ctx.fillRect(0, 0, W, boardH);
    eachLabel(items, k, (label, x, w) => {
      drawRun(labels.ctx, label, SPINE_FACES.label, 8 * k, x + w / 2, baselineAbout(boardH / 2, SPINE_FACES.label, 8 * k), "rgba(255, 255, 255, 0.5)");
    });
    const boardWood = wood(CASE_BOARD, 0.75);
    const lettered = material({ map: pictureTexture(labels.canvas), rough: 0.9 });
    // A box's faces, in the order the library keeps them: right, left, top, bottom, front, back.
    add(new Mesh(new BoxGeometry(W, boardH, depth + front), [boardWood, boardWood, boardWood, boardWood, lettered, boardWood]), W / 2, -boardH / 2, (front - depth) / 2);
    // The shelf above: out of sight, but it casts its shadow on these books.
    add(new Mesh(new BoxGeometry(W, boardH, depth + front), boardWood), W / 2, pad + shelfH + boardH / 2, (front - depth) / 2);
    // The case's sides, just out of sight, so the light falls into a case and not across an open shelf.
    for (const x of [-6 * k, W + 6 * k]) {
      add(new Mesh(new BoxGeometry(12 * k, pad + shelfH + 2 * boardH, depth + front), wood(CASE_BACK, 0.9)), x, (pad + shelfH) / 2, (front - depth) / 2);
    }

    for (const item of items) {
      const stood = standBook(item, k, scale, front, textures);
      this.scene.add(stood.node);
      this.standing.set(item.book.id, { pivot: stood.pivot, depth: stood.depth, art: stood.art, tip: 0, out: 0, moving: [] });
    }
    lightShelf(this.scene, textures.studio, { width: W, shelfH, pad, depth, front, k }, develop);
  }

  /**
   * Take one book down and put the last one back, as from a real shelf: a finger hooked over its head tips it towards
   * you on its front foot, then draws it out; put back, it is pushed home and stood upright in one movement.
   * Nothing moves until `step` is called with the time, frame by frame.
   */
  lift(id: string | null, now: number): void {
    if (id === this.lifted) return;
    const was = this.lifted ? this.standing.get(this.lifted) : undefined, taken = id ? this.standing.get(id) : undefined;
    this.lifted = id;
    if (was) {
      was.moving = [
        { part: "tip", from: was.tip, to: 0, start: now, lasts: 180, ease: easeOut },
        { part: "out", from: was.out, to: 0, start: now, lasts: 180, ease: easeOut },
      ];
    }
    if (taken) {
      taken.moving = [
        { part: "tip", from: taken.tip, to: 1, start: now, lasts: 140, ease: easeOut },
        { part: "out", from: taken.out, to: 1, start: now + 140, lasts: 220, ease: easeInOut },
      ];
    }
  }

  /** Move every book to where it should be at this time. True while any is still on its way, so the shelf needs drawing again. */
  step(now: number): boolean {
    let moving = false;
    for (const book of this.standing.values()) {
      if (book.moving.length === 0) continue;
      book.moving = book.moving.filter((m) => {
        const t = Math.min(1, Math.max(0, (now - m.start) / m.lasts));
        book[m.part] = m.from + (m.to - m.from) * m.ease(t);
        return t < 1;
      });
      book.pivot.rotation.x = book.tip * radians(11);
      book.pivot.position.y = book.out * 3 * this.k;
      book.pivot.position.z = book.out * 28 * this.k;
      moving ||= book.moving.length > 0;
    }
    return moving;
  }

  /** Every book where it will come to rest, at once: for a picture of the shelf that isn't a frame of a movement. */
  settle(): void {
    this.step(Number.MAX_SAFE_INTEGER);
  }

  /** A book's spine as a flat picture, as it was drawn for the 3D book. */
  artOf(id: string): HTMLCanvasElement | null {
    return this.standing.get(id)?.art ?? null;
  }

  /** Let the lamps' shadow maps go: a shelf at rest is a still picture, and each of its lamps holds four megabytes of them. They are made again when it is next drawn. */
  restLamps(): void {
    this.scene.traverse((o) => {
      const shadow = (o as SpotLight).shadow;
      if ((o as SpotLight).isSpotLight && shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
    });
  }

  /** Let everything go from the graphics card. */
  dispose(): void {
    this.restLamps();
    letGo(this.scene);
  }
}

/**
 * A row's size on the page at a size of book: its height, from the front edge of the shelf above to the front edge
 * of its own board, and where the books' bottom edge sits from its top.
 */
export function rowSize(k: number): { height: number; top: number } {
  const a = radians(SHELF_TILT), front = Math.round(8 * k);
  const top = (Math.round(16 * k) + Math.round(CASE_SHELF_HEIGHT * k)) * Math.cos(a) - front * Math.sin(a);
  return { height: top + Math.round(12 * k) * Math.cos(a) + front * Math.sin(a), top };
}

/** Where a book's button goes over a row's picture: its front face and the top that shows above it. */
export function frameOnRow(item: CaseItem, k: number): { x: number; y: number; width: number; height: number } {
  const a = radians(SHELF_TILT), { top } = rowSize(k);
  const depth = Math.min(Math.round(item.spine.height * 0.66), Math.round(144 * k));
  const y = Math.max(0, top - item.spine.height * Math.cos(a) - depth * Math.sin(a));
  return { x: item.x, y, width: item.spine.width, height: top - y };
}

/**
 * A shelf drawn flat, straight away: its wood, its board, and every book's spine where the 3D shelf will put it.
 * This is the shelf before its 3D picture is ready, and all there is of it on a machine with no graphics card.
 * `artOf` gives a spine already drawn for the 3D book, to save drawing it twice.
 */
export function drawFlatShelf(ctx: CanvasRenderingContext2D, items: readonly CaseItem[], width: number, k: number, scale: number, artOf?: (id: string) => HTMLCanvasElement | null): void {
  const { height, top } = rowSize(k);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = hexOf(CASE_BACK);
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = hexOf(CASE_BOARD);
  ctx.fillRect(0, top, width, height - top);
  for (const item of items) {
    const art = artOf?.(item.book.id) ?? spineArt(item.spine, item.cloth, k, scale, null);
    ctx.drawImage(art, item.x, top - item.spine.height, item.spine.width, item.spine.height);
  }
  ctx.restore();
}

/** Each label on a shelf's edge where it begins, unless it would run into the one before. */
function eachLabel(items: readonly CaseItem[], k: number, draw: (label: string, x: number, width: number) => void): void {
  let lastEnd = -Infinity;
  for (const item of items) {
    if (item.label === null || item.x < lastEnd + 8 * k) continue;
    const label = item.label.toUpperCase();
    const w = Math.ceil(measureRun(label, SPINE_FACES.label) * 8 * k) + 2;
    lastEnd = item.x + w;
    draw(label, item.x, w);
  }
}
