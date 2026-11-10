import { CanvasTexture, Color, DoubleSide, LinearFilter, Mesh as Object3DMesh, MeshStandardMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture, Vector2 } from "three";
import type { RGB } from "@ribbon/core/bookcase/cloth";
import { Mesh, ring, type Ring } from "./mesh";
import type { BookTextures } from "./textures";

/** What a book wears. */
export interface BookLook {
  /** The spine's art, with the cloth's threads already laid over it. */
  spine: Texture;
  /** A hardback's foil, from one drawing of where the lettering is: how rough each point is (green) and how metal (blue). */
  spineFoil?: Texture;
  /** The front cover: its art, or a colour. */
  front: Texture | RGB;
  cloth: RGB;
  /** A hardback's headband: its two colours, wound in stripes. */
  headband: readonly [RGB, RGB];
}

const ENDPAPER: RGB = { r: 237, g: 230, b: 212 };

/** A colour as the graphics card wants it. */
export function colourOf(c: RGB, shade = 1): Color {
  return new Color().setRGB((c.r / 255) * shade, (c.g / 255) * shade, (c.b / 255) * shade, SRGBColorSpace);
}

/** How far the spine is rounded, as a part of the book's thickness: a hardback's well rounded, a paperback's nearly flat. */
export function roundness(T: number, paperback = false): number {
  return T * (paperback ? 0.035 : 0.16);
}

/** A shared texture laid at a scale of its own. The picture itself is still kept once. */
export function tiled(texture: Texture, across: number, up: number): Texture {
  const t = texture.clone();
  t.repeat.set(across, up);
  return t;
}

interface Surface {
  colour?: Color;
  map?: Texture;
  rough: number;
  roughMap?: Texture;
  normal?: Texture;
  /** How strongly the normal map shows. */
  relief?: number;
}

/** A matte, lit material, seen from both sides. */
export function material(s: Surface): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: s.colour ?? new Color(1, 1, 1), roughness: s.rough, metalness: 0, side: DoubleSide });
  if (s.map) m.map = s.map;
  if (s.roughMap) m.roughnessMap = s.roughMap;
  if (s.normal) {
    m.normalMap = s.normal;
    m.normalScale = new Vector2(s.relief ?? 0.7, s.relief ?? 0.7);
  }
  return m;
}

/**
 * A hardback, built the way a binder makes one: a case of two boards and a rounded spine, with the joint pressed in
 * where each board meets the spine, and the pages inside it, set back from the boards' edges by the squares, their
 * fore-edge a little hollow as a rounded spine makes it. Sizes in points: T thick (the spine's width), H tall, D deep
 * (a cover's width). The spine faces +z; the back board's outer face is x = 0, the front board's x = T; it stands on y = 0.
 *
 * A paperback is a card cover glued round the pages: flush with them, no boards standing proud, no joint, no headband.
 *
 * The Apple app builds the same book in packages/apple/Ribbon/Bookcase/BookModel.swift.
 */
export function makeBook(T: number, H: number, D: number, look: BookLook, textures: BookTextures, paperback = false): Object3DMesh {
  const t = T, h = H, d = D;
  const board = paperback ? 0.45 : Math.min(Math.max(H * 0.011, 1.0), T * 0.12);
  const squares = paperback ? 0.15 : H * 0.012;
  const r = roundness(T, paperback);
  const joint = Math.max(3, D * 0.05), groove = paperback ? 0 : board * 0.5, grooveHalf = 0.9;
  // Every outside edge is softened a little, so it catches a thin line of light as a real edge does.
  const soft = paperback ? 0.3 : Math.min(0.7, board * 0.45);
  const vTop = soft / h, vBottom = 1 - soft / h;
  const mesh = new Mesh();

  // The case's outside: the back board, the spine, the front board, each its own material.
  const back = mesh.element(), spine = mesh.element(), front = mesh.element();
  // From the board's inner fore-edge, round its outer corner, then along its face, past the joint, to the spine.
  let backFace: Ring[] = [ring(board, -d, 0, -1, 0), ring(soft, -d, 0, -1, 0)];
  for (let k = 0; k <= 4; k++) {
    const th = ((Math.PI / 2) * k) / 4;
    backFace.push(ring(soft - soft * Math.sin(th), -d + soft - soft * Math.cos(th), -Math.sin(th), -Math.cos(th), 0));
  }
  if (groove > 0) {
    backFace.push(
      ring(0, -joint - grooveHalf, -1, 0, 0),
      ring(0, -joint - grooveHalf, -grooveHalf, groove, 0), ring(groove, -joint, -grooveHalf, groove, 0),
      ring(groove, -joint, -grooveHalf, -groove, 0), ring(0, -joint + grooveHalf, -grooveHalf, -groove, 0),
      ring(0, -joint + grooveHalf, -1, 0, 0),
    );
  }
  backFace.push(ring(0, 0, -1, 0, 0));
  backFace = backFace.map((p) => ({ ...p, u: (p.z + d) / d }));
  const frontFace = [...backFace].reverse().map((p) => ring(t - p.x, p.z, -p.nx, p.nz, -p.z / d));
  const steps = 16;
  let arc: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = (Math.PI * i) / steps;
    arc.push(ring((t / 2) * (1 - Math.cos(phi)), r * Math.sin(phi), -r * Math.cos(phi), (t / 2) * Math.sin(phi), 0));
  }
  // The spine's art runs round the curve by distance, so it isn't squeezed at the shoulders.
  let run = 0;
  arc.forEach((p, i) => {
    if (i > 0) run += Math.hypot(p.x - arc[i - 1]!.x, p.z - arc[i - 1]!.z);
    p.u = run;
  });
  arc = arc.map((p) => ({ ...p, u: p.u / run }));
  for (const [element, section] of [[back, backFace], [spine, arc], [front, frontFace]] as const) {
    mesh.strip(element, section, soft, h - soft, vBottom, vTop);
    mesh.chamfer(element, section, soft, h - soft, h, vTop, 0);
    mesh.chamfer(element, section, soft, soft, 0, vBottom, 1);
  }

  // Its edges: the boards' tops and bottoms, inside the softened rim, and the spine's.
  const edges = mesh.element();
  for (const [x0, x1] of [[soft, board], [t - board, t - soft]] as const) {
    const corners = [[x0, -d + soft], [x1, -d + soft], [x1, 0], [x0, 0]] as const;
    mesh.cap(edges, corners, h, true);
    mesh.cap(edges, corners, 0, false);
  }
  const rIn = Math.max(0, r - board);
  const inner: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = (Math.PI * i) / steps;
    inner.push([board + (t / 2 - board) * (1 - Math.cos(phi)), rIn * Math.sin(phi)]);
  }
  const rim = arc.map((p): [number, number] => {
    const n = Math.max(1e-6, Math.hypot(p.nx, p.nz));
    return [p.x - (p.nx / n) * soft, p.z - (p.nz / n) * soft];
  });
  mesh.band(edges, rim, inner, h, true);
  mesh.band(edges, rim, inner, 0, false);

  // Its inside, seen only past the squares: the endpapers.
  const lining = mesh.element();
  mesh.wall(lining, [board, -d], [board, 0], 0, h, [1, 0]);
  mesh.wall(lining, [t - board, 0], [t - board, -d], 0, h, [-1, 0]);

  // The pages: set back from the boards by the squares, the fore-edge hollowed, the back following the spine.
  const pages = mesh.element();
  const xb = board + 0.15, xf = t - board - 0.15, zf = -d + squares, hollow = (xf - xb) * (paperback ? 0.02 : 0.08);
  const tbR = Math.max(0.5, rIn - 0.4);
  let outline: Ring[] = [ring(xb, 0, -1, 0, 0), ring(xb, zf, -1, 0, 0)];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps, x = xb + (xf - xb) * s;
    const slope = ((hollow * Math.PI) / (xf - xb)) * Math.cos(Math.PI * s);
    outline.push(ring(x, zf + hollow * Math.sin(Math.PI * s), slope, -1, 0));
  }
  outline.push(ring(xf, zf, 1, 0, 0), ring(xf, 0, 1, 0, 0));
  const a = (xf - xb) / 2;
  for (let i = 0; i <= steps; i++) {
    const phi = (Math.PI * i) / steps;
    outline.push(ring((xb + xf) / 2 + a * Math.cos(phi), tbR * Math.sin(phi), Math.cos(phi) / a, Math.sin(phi) / tbR, 0));
  }
  outline = outline.map((p) => ({ ...p, u: (p.x - xb) / (xf - xb) }));
  mesh.strip(pages, outline, squares, h - squares);
  const flat = outline.map((p): [number, number] => [p.x, p.z]);
  const acrossPages = (x: number) => (x - xb) / (xf - xb), alongPages = (z: number) => (z - zf) / (tbR - zf);
  mesh.fan(pages, flat, h - squares, true, acrossPages, alongPages);
  mesh.fan(pages, flat, squares, false, acrossPages, alongPages);

  // A hardback's headbands: the little striped cords at the head and tail of the pages, just inside the spine.
  if (!paperback) {
    const band = mesh.element();
    const hb = Math.min(squares * 0.9, 1.5), hr = tbR + 0.25, ha = a + 0.1;
    const cord: Ring[] = [];
    for (let i = 0; i <= steps; i++) {
      const phi = (Math.PI * i) / steps;
      cord.push(ring((xb + xf) / 2 + ha * Math.cos(phi), hr * Math.sin(phi), Math.cos(phi) / ha, Math.sin(phi) / hr, 0));
    }
    let length = 0;
    cord.forEach((p, i) => {
      if (i > 0) length += Math.hypot(p.x - cord[i - 1]!.x, p.z - cord[i - 1]!.z);
      p.u = length / 1.2;
    });
    mesh.strip(band, cord, h - squares - 0.2, h - squares + hb);
    mesh.strip(band, cord, squares - hb, squares + 0.2);
    const inside: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const phi = (Math.PI * i) / steps;
      inside.push([(xb + xf) / 2 + (ha - 1) * Math.cos(phi), Math.max(0, hr - 1) * Math.sin(phi)]);
    }
    const outside = cord.map((p): [number, number] => [p.x, p.z]);
    mesh.band(band, outside, inside, h - squares + hb, true);
    mesh.band(band, outside, inside, squares - hb, false);
  }

  // The scanned weave repeats about every twelve points, a finger's width of book cloth.
  const weaveAcross = T / 12, weaveUp = H / 12, coverAcross = D / 12;
  const clothNormal = tiled(textures.clothNormal, weaveAcross, weaveUp);
  let clothMaterial: MeshStandardMaterial, spineMaterial: MeshStandardMaterial;
  if (paperback) {
    // Printed card: smoother than cloth, no foil, the board's texture barely there.
    clothMaterial = material({ colour: colourOf(look.cloth), rough: 0.62, normal: clothNormal, relief: 0.12 });
    spineMaterial = material({ map: look.spine, rough: 0.6, normal: clothNormal, relief: 0.12 });
  } else {
    clothMaterial = material({
      colour: colourOf(look.cloth), map: tiled(textures.clothFibres, weaveAcross, weaveUp),
      rough: 1, roughMap: tiled(textures.clothRough, weaveAcross, weaveUp), normal: clothNormal,
    });
    spineMaterial = material({ map: look.spine, rough: 0.86, normal: clothNormal });
    if (look.spineFoil) {
      spineMaterial.metalness = 1;
      spineMaterial.metalnessMap = look.spineFoil;
      // The roughness repeats at the weave's scale, as the scanned cloth's does, and has since the look was chosen:
      // the lettering, tiny and many times over, is the faint check of the weave catching the lamp.
      spineMaterial.roughness = 1;
      // Read unsmoothed, like the cloth (textures.ts, `sharp`), or the check averages away.
      const check = new CanvasTexture(look.spineFoil.image as HTMLCanvasElement);
      check.colorSpace = NoColorSpace;
      check.wrapS = check.wrapT = RepeatWrapping;
      check.minFilter = LinearFilter;
      check.generateMipmaps = false;
      check.repeat.set(weaveAcross, weaveUp);
      spineMaterial.roughnessMap = check;
    }
  }
  // A printed cover is paper over the board: the cloth only just shows through it.
  const coverNormal = tiled(textures.clothNormal, coverAcross, weaveUp);
  const frontMaterial = "r" in look.front
    ? material({ colour: colourOf(look.front), rough: paperback ? 0.6 : 0.7, normal: coverNormal, relief: paperback ? 0.1 : 0.25 })
    : material({ map: look.front, rough: paperback ? 0.6 : 0.7, normal: coverNormal, relief: paperback ? 0.1 : 0.25 });
  const edgeMaterial = material({ colour: paperback ? new Color().setRGB(0.88, 0.88, 0.88, SRGBColorSpace) : colourOf(look.cloth, 0.82), rough: 0.9 });
  const liningMaterial = material({ colour: colourOf(ENDPAPER), rough: 0.95 });
  const pagesMaterial = material({ map: tiled(textures.pages, T / 26, 1), rough: 0.92, normal: tiled(textures.pageRidges, T / 26, 1) });
  const materials = [clothMaterial, spineMaterial, frontMaterial, edgeMaterial, liningMaterial, pagesMaterial];
  if (!paperback) materials.push(material({ map: textures.stripes(look.headband[0], look.headband[1]), rough: 0.7 }));

  const book = new Object3DMesh(mesh.geometry(), materials);
  book.castShadow = true;
  book.receiveShadow = true;
  return book;
}
