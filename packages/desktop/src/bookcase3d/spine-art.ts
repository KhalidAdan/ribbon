import { hexOf, rgb, type Cloth, type RGB } from "@ribbon/core/bookcase/cloth";
import { SPINE_FACES as FACES, type MeasureRun, type SpineFace, type SpineLayout } from "@ribbon/core/bookcase/case";
import serifUrl from "@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2?url";
import serifExtUrl from "@fontsource-variable/newsreader/files/newsreader-latin-ext-wght-normal.woff2?url";
import sansUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import { canvasOf } from "./textures";

// A spine set the way a publisher sets a series: one cloth, a foil for the rules and the volume number, the title at
// one size across the shelf, the author's surname at the foot. Drawn on a canvas into the pictures the 3D book wears.
// The Apple app draws the same spine in packages/apple/Ribbon/Bookcase/Spine.swift.

// The spines' own names for their two faces: the same files the Apple app letters with, so a title breaks in the same
// places on every device. (The app's reading face has an optical-size axis, and measures a little differently.)
const SERIF = "Ribbon Spine Serif", SANS = "Ribbon Spine Sans";

let facesReady: Promise<void> | null = null;

/** The spines' faces, loaded once. Nothing can be measured or drawn before this. */
export function loadSpineFaces(): Promise<void> {
  facesReady ??= (async () => {
    const weights = { weight: "100 900" };
    // Latin Extended stands behind Latin for the letters Latin lacks, as the browser picks a face by what it covers.
    const faces = [
      new FontFace(SERIF, `url(${serifUrl})`, { ...weights, unicodeRange: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" }),
      new FontFace(SERIF, `url(${serifExtUrl})`, { ...weights, unicodeRange: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" }),
      new FontFace(SANS, `url(${sansUrl})`, weights),
    ];
    for (const face of await Promise.all(faces.map((f) => f.load()))) document.fonts.add(face);
  })();
  return facesReady;
}

function fontOf(face: SpineFace, size: number): string {
  return `${face.weight} ${size}px "${face.serif ? SERIF : SANS}"`;
}

const ruler = canvasOf(1, 1).ctx;
const widths = new Map<string, number>(), capHeights = new Map<string, number>();

/** How long a run of text is per point of type, tracking included. */
export const measureRun: MeasureRun = (text, face) => {
  const key = `${face.serif}${face.weight}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    ruler.font = fontOf(face, 100);
    ruler.letterSpacing = "0px";
    w = ruler.measureText(text).width / 100;
    widths.set(key, w);
  }
  return w + face.tracking * Math.max(0, text.length - 1);
};

/** How tall a face's capitals are, per point of type. */
function capHeight(face: SpineFace): number {
  const key = `${face.serif}${face.weight}`;
  let h = capHeights.get(key);
  if (h === undefined) {
    ruler.font = fontOf(face, 100);
    h = ruler.measureText("H").actualBoundingBoxAscent / 100;
    capHeights.set(key, h);
  }
  return h;
}

/** A run of text centred on x, its baseline at y. */
export function drawRun(ctx: CanvasRenderingContext2D, text: string, face: SpineFace, size: number, x: number, baseline: number, colour: string): void {
  ctx.font = fontOf(face, size);
  ctx.letterSpacing = `${face.tracking * size}px`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = colour;
  ctx.fillText(text, x - (measureRun(text, face) * size) / 2, baseline);
}

/** Where a run's baseline goes for its capitals to be centred on y. */
export function baselineAbout(y: number, face: SpineFace, size: number): number {
  return y + (capHeight(face) * size) / 2;
}

/** Sideways, as a printed spine turns its words: top to bottom, the first line on the right. */
function drawSideways(ctx: CanvasRenderingContext2D, lines: readonly string[], face: SpineFace, size: number, cx: number, cy: number, colour: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 2);
  const pitch = size * face.lineHeight;
  lines.forEach((line, i) => drawRun(ctx, line, face, size, 0, baselineAbout((i - (lines.length - 1) / 2) * pitch, face, size), colour));
  ctx.restore();
}

let noise: HTMLCanvasElement | null = null;

/** A faint grain, so cloth reads as matte stuff rather than flat colour. */
function grain(ctx: CanvasRenderingContext2D, width: number, height: number, alpha: number): void {
  if (!noise) {
    const made = canvasOf(64, 64), image = made.ctx.createImageData(64, 64);
    // The same grain every time: a small stir of numbers, not the machine's dice.
    let s = 1;
    for (let i = 0; i < image.data.length; i += 4) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = s >>> 24;
      image.data[i + 3] = 255;
    }
    made.ctx.putImageData(image, 0, 0);
    noise = made.canvas;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "overlay";
  for (let y = 0; y < height; y += 32) for (let x = 0; x < width; x += 32) ctx.drawImage(noise, x, y, 32, 32);
  ctx.restore();
}

/** A finished book's tick, in a small disc. */
function drawTick(ctx: CanvasRenderingContext2D, cx: number, cy: number, d: number, under: RGB): void {
  const pale = (0.299 * under.r + 0.587 * under.g + 0.114 * under.b) / 255 > 0.6;
  ctx.fillStyle = pale ? "#1d1b18" : "#fbfaf7";
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = pale ? "#fbfaf7" : "#1a1a1a";
  ctx.lineWidth = d * 0.11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - d * 0.2, cy + d * 0.02);
  ctx.lineTo(cx - d * 0.06, cy + d * 0.16);
  ctx.lineTo(cx + d * 0.21, cy - d * 0.16);
  ctx.stroke();
}

/**
 * Draw the spine in its cloth, in points from its top left. `mask` draws the same spine as a map for the 3D book's
 * foil, in the cloth given (black for cloth, white for what's stamped): no grain, no tick.
 */
export function drawSpine(ctx: CanvasRenderingContext2D, s: SpineLayout, cloth: Cloth, k: number, mask = false): void {
  const W = s.width, H = s.height, foil = hexOf(cloth.foil), ink = cloth.ink;
  ctx.fillStyle = hexOf(cloth.ground);
  ctx.fillRect(0, 0, W, H);
  if (!mask) grain(ctx, W, H, 0.05);
  // Hairline pairs at the head and the foot, in the foil.
  const hair = Math.max(0.75, 0.7 * k);
  ctx.fillStyle = foil;
  for (const y of [s.edge, s.edge + 3 * k, H - s.edge - hair, H - s.edge - 3 * k - hair]) ctx.fillRect(0, y, W, hair);
  // The volume number, upright, as a series' spines carry it.
  if (s.number !== null) drawRun(ctx, s.number, FACES.number, s.numberSize, W / 2, baselineAbout(s.numberMid, FACES.number, s.numberSize), foil);
  if (s.tick > 0 && !mask) drawTick(ctx, W / 2, s.tickMid, s.tick, cloth.ground);
  drawSideways(ctx, s.lines, FACES.title, s.size, W / 2, (s.titleTop + s.titleBottom) / 2, hexOf(ink));
  if (s.author !== null) {
    // A short rule just before the author.
    ctx.fillStyle = foil;
    ctx.fillRect(W * 0.36, s.titleBottom + 4 * k, W * 0.28, hair);
    drawSideways(ctx, [s.author], FACES.author, s.authorSize, W / 2, s.authorMid, `rgba(${ink.r}, ${ink.g}, ${ink.b}, 0.78)`);
  }
}

/** A spine's art at a number of pixels to the point, with the cloth's threads laid faintly over it, a thread every twelve points. */
export function spineArt(s: SpineLayout, cloth: Cloth, k: number, scale: number, fibres: HTMLCanvasElement | null): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(s.width * scale, s.height * scale);
  ctx.scale(scale, scale);
  drawSpine(ctx, s, cloth, k);
  if (fibres) {
    ctx.globalCompositeOperation = "multiply";
    // Unsmoothed, so the threads keep their speckle (textures.ts, `sharp`).
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < s.height; y += 12) for (let x = 0; x < s.width; x += 12) ctx.drawImage(fibres, x, y, 12, 12);
    ctx.globalCompositeOperation = "source-over";
  }
  return canvas;
}

const BLACK = rgb(0x000000), WHITE = rgb(0xffffff);

// The foil's metal, and the roughness of the cloth and of the lettering, as bytes.
const METAL = 0xb3, CLOTH_ROUGH = 0xdb, LETTERING_ROUGH = 0x5c;

/**
 * A spine's foil, as one picture: how rough each point is (green) and how metal (blue), both from one drawing of where
 * the foil and lettering are. Lettering is stamped foil, metal 0.7 and smooth (0.36) against the cloth's 0.86, and an
 * edge part covered by a letter is part metal: both follow from how much of each point the lettering covers.
 *
 * The drawing is white where a point is covered and black where it isn't. Two washes over it turn that into the
 * numbers, on the graphics card where the drawing is: multiplying by a colour leaves `covered` times that colour, and
 * the difference from the cloth's roughness then counts green down from it. (Reading the pixels back to work the same
 * out one by one fetched them from the graphics card, a third of the time it took to light a shelf.)
 */
export function spineFoil(s: SpineLayout, k: number, scale: number): HTMLCanvasElement {
  const { canvas, ctx } = canvasOf(Math.ceil(s.width * scale), Math.ceil(s.height * scale));
  ctx.scale(scale, scale);
  drawSpine(ctx, s, { ground: BLACK, ink: WHITE, foil: WHITE, alternatives: [] }, k, true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Green: covered × (cloth − lettering). Blue: covered × metal.
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `rgb(0, ${CLOTH_ROUGH - LETTERING_ROUGH}, ${METAL})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Green: cloth − covered × (cloth − lettering), which is the cloth's roughness where nothing is stamped.
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = `rgb(0, ${CLOTH_ROUGH}, 0)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}
