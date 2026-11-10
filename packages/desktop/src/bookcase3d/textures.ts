import {
  CanvasTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  PMREMGenerator,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  type WebGLRenderer,
} from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { hexOf, rgb, type RGB } from "@ribbon/core/bookcase/cloth";
// The scanned cloth and the studio are the Apple app's own files, kept once in the repository.
import clothNormalUrl from "../../../apple/Ribbon/Bookcase/Textures/cloth-normal.jpg?url";
import clothRoughUrl from "../../../apple/Ribbon/Bookcase/Textures/cloth-rough.jpg?url";
import clothColourUrl from "../../../apple/Ribbon/Bookcase/Textures/cloth-colour.jpg?url";
import studioUrl from "../../../apple/Ribbon/Bookcase/Textures/studio.exr?url";

/**
 * Textures made once and shared by every book: the cloth's weave, paper edges, a headband's stripes, wood's grain,
 * and a small photographer's studio to light everything by. The cloth is ambientCG's Fabric082A and the studio
 * Poly Haven's Studio Small 09, both CC0 (public domain).
 */
export interface BookTextures {
  clothNormal: Texture;
  clothRough: Texture;
  /** The scanned cloth's own light and dark threads, faint enough to lay over any colour. */
  clothFibres: Texture;
  /** The same threads as a picture, for laying over a spine's art as it is drawn. */
  clothFibresPicture: HTMLCanvasElement;
  /** The colour of page edges: warm paper with the faint lines of the leaves. */
  pages: Texture;
  /** Ridges across a page block's edge, one per leaf. */
  pageRidges: Texture;
  /** Wood's grain, laid lengthwise along a shelf: long streaks a shade lighter and darker, never a pattern. */
  woodGrain: Texture;
  /** The studio, ready to light a scene by. */
  studio: Texture;
  /** A headband's stripes: two colours, side by side, repeated round the cord. */
  stripes(a: RGB, b: RGB): Texture;
}

export function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return { canvas, ctx: canvas.getContext("2d")! };
}

/** The same "random" numbers every time, so the wood and the paper are the same on every run and can be compared. */
function seeded(seed: number): (lo: number, hi: number) => number {
  let s = seed >>> 0;
  return (lo, hi) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return lo + (((t ^ (t >>> 14)) >>> 0) / 4294967296) * (hi - lo);
  };
}

/** A picture washed towards white: `strength` of it is left. Laid over a colour, it shades it by that much and no more. */
function faint(image: CanvasImageSource, width: number, height: number, strength: number): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(width, height);
  ctx.drawImage(image, 0, 0, width, height);
  ctx.fillStyle = `rgba(255, 255, 255, ${1 - strength})`;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function tiling(texture: Texture, colour: boolean): Texture {
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  return texture;
}

/**
 * The scanned cloth is read at its full sharpness however small it is drawn, as the Apple app reads it: a weave many
 * times finer than the screen comes out as a fine, uneven speckle, and that speckle is what makes the cloth look woven
 * by hand. Smoothed for its size, as a texture usually is, it averages away to nothing and the books look moulded.
 */
function sharp(texture: Texture, colour: boolean): Texture {
  tiling(texture, colour);
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 1;
  return texture;
}

function pagesPicture(): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(256, 64), random = seeded(7);
  ctx.fillStyle = hexOf(rgb(0xebe3d0));
  ctx.fillRect(0, 0, 256, 64);
  for (let x = 0; x < 256; x += 3) {
    ctx.fillStyle = `rgba(115, 97, 71, ${random(0.05, 0.16)})`;
    ctx.fillRect(x, 0, 1, 64);
  }
  return canvas;
}

function woodPicture(): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(512, 128), random = seeded(11);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 220; i++) {
    const y = random(0, 128), h = random(0.4, 2.2), grey = Math.round(random(0.62, 0.95) * 255);
    ctx.fillStyle = `rgba(${grey}, ${grey}, ${grey}, ${random(0.25, 0.7)})`;
    ctx.fillRect(random(-200, 300), y, random(120, 600), h);
  }
  return canvas;
}

/** A normal map from a height field, wrapping at its edges so it tiles. */
function normalMap(n: number, height: (x: number, y: number) => number): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(n, n), image = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = height((x + 1) % n, y) - height((x + n - 1) % n, y), dy = height(x, (y + 1) % n) - height(x, (y + n - 1) % n);
      const len = Math.hypot(dx, dy, 1), at = (y * n + x) * 4;
      image.data[at] = Math.round(((-dx / len + 1) / 2) * 255);
      image.data[at + 1] = Math.round(((-dy / len + 1) / 2) * 255);
      image.data[at + 2] = Math.round(((1 / len + 1) / 2) * 255);
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Load and make the shared textures. The studio is worked out for lighting by on this renderer's graphics card. */
export async function loadBookTextures(renderer: WebGLRenderer, studioWhite = 1): Promise<BookTextures> {
  const pictures = new TextureLoader();
  const [clothNormal, clothRough, clothColour, studioPicture] = await Promise.all([
    pictures.loadAsync(clothNormalUrl),
    pictures.loadAsync(clothRoughUrl),
    pictures.loadAsync(clothColourUrl),
    new EXRLoader().setDataType(FloatType).loadAsync(studioUrl),
  ]);
  // The Apple app reads the studio through a decoder that keeps nothing brighter than white, so its lamps are no
  // brighter than its walls and it lights the books evenly from all round. Read whole, its lamps are many times
  // brighter, and every book's side and top catches one: the same clipping here keeps the two pictures alike.
  const light = studioPicture.image.data as Float32Array;
  for (let i = 0; i < light.length; i++) if (light[i]! > studioWhite) light[i] = studioWhite;
  studioPicture.mapping = EquirectangularReflectionMapping;
  const generator = new PMREMGenerator(renderer);
  const studio = generator.fromEquirectangular(studioPicture).texture;
  studioPicture.dispose();
  generator.dispose();

  const scan = clothColour.image as HTMLImageElement;
  const clothFibresPicture = faint(scan, scan.naturalWidth, scan.naturalHeight, 0.2);
  clothColour.dispose();

  const stripes = new Map<string, Texture>();
  return {
    clothNormal: sharp(clothNormal, false),
    clothRough: sharp(clothRough, false),
    clothFibres: sharp(new CanvasTexture(clothFibresPicture), true),
    clothFibresPicture,
    pages: tiling(new CanvasTexture(pagesPicture()), true),
    pageRidges: sharp(new CanvasTexture(normalMap(64, (x) => 0.5 + 0.5 * Math.sin((x * Math.PI) / 1.5))), false),
    woodGrain: tiling(new CanvasTexture(faint(woodPicture(), 512, 128, 0.5)), true),
    studio,
    stripes(a, b) {
      const key = hexOf(a) + hexOf(b);
      let made = stripes.get(key);
      if (!made) {
        const { canvas, ctx } = canvasOf(8, 2);
        ctx.fillStyle = hexOf(a);
        ctx.fillRect(0, 0, 4, 2);
        ctx.fillStyle = hexOf(b);
        ctx.fillRect(4, 0, 4, 2);
        made = tiling(new CanvasTexture(canvas), true);
        made.magFilter = NearestFilter;
        stripes.set(key, made);
      }
      return made;
    },
  };
}
