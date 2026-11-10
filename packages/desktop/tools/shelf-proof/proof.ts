// One shelf of fixed books, drawn by the desktop's bookcase above the Apple app's picture of the same shelf, with
// the difference between the two measured. The lamps and the developing (src/bookcase3d/lamplight.ts) were tuned
// here: any of its numbers can be tried from the address bar, as ?lamp=20000&exposure=1.2.
//
//   npm run dev -w @ribbon/desktop, then open /tools/shelf-proof/index.html
//
// The Apple app's picture and layout in ref/ are made by ShelfReference.swift (README.md).

import { layOutCase, type CaseItem } from "@ribbon/core/bookcase/case";
import { hexOf } from "@ribbon/core/bookcase/cloth";
import { makeRenderer } from "../../src/bookcase3d/lamplight";
import { ShelfRow } from "../../src/bookcase3d/shelf-row";
import { loadSpineFaces, measureRun } from "../../src/bookcase3d/spine-art";
import { loadBookTextures } from "../../src/bookcase3d/textures";
import { caseBooks, developFromAddress, K, SCALE, WIDTH } from "./fixture";
import apple from "./ref/scenekit-layout.json";

/** Where this layout and the Apple app's differ, book by book: nothing, if the rules were carried over whole. */
function layoutDifferences(shelves: CaseItem[][]): string[] {
  const found: string[] = [];
  apple.shelves.forEach((theirs, s) => {
    theirs.forEach((t, i) => {
      const mine = shelves[s]?.[i];
      if (!mine) return found.push(`${t.id}: missing`);
      const m = mine.spine;
      const numbers: [string, number, number][] = [
        ["x", mine.x, t.x], ["w", m.width, t.w], ["h", m.height, t.h], ["size", m.size, t.size],
        ["titleTop", m.titleTop, t.titleTop], ["titleBottom", m.titleBottom, t.titleBottom], ["authorMid", m.authorMid, t.authorMid],
      ];
      for (const [name, a, b] of numbers) if (Math.abs(a - b) > 0.25) found.push(`${t.id} ${name}: ${a.toFixed(2)} here, ${b.toFixed(2)} there`);
      if (mine.book.id !== t.id) found.push(`${t.id}: ${mine.book.id} stands here`);
      if (m.lines.join("|") !== t.lines.join("|")) found.push(`${t.id} lines: ${m.lines.join("|")} here, ${t.lines.join("|")} there`);
      if (hexOf(mine.cloth.ground) !== t.ground) found.push(`${t.id} cloth: ${hexOf(mine.cloth.ground)} here, ${t.ground} there`);
      if (mine.paperback !== t.paperback || mine.lean !== t.lean) found.push(`${t.id}: paperback or lean differs`);
    });
  });
  return found;
}

/** A picture's pixels at a small size, each the average of the part of the picture it covers. */
function sampled(source: CanvasImageSource, columns: number, rows: number): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  // Halved in steps, so every pixel counts in the average.
  let from: CanvasImageSource = source, w = (source as HTMLCanvasElement).width, h = (source as HTMLCanvasElement).height;
  while (w > columns * 2 || h > rows * 2) {
    const step = document.createElement("canvas");
    step.width = w = Math.max(columns, Math.ceil(w / 2));
    step.height = h = Math.max(rows, Math.ceil(h / 2));
    step.getContext("2d")!.drawImage(from, 0, 0, w, h);
    from = step;
  }
  ctx.drawImage(from, 0, 0, columns, rows);
  return ctx.getImageData(0, 0, columns, rows).data;
}

/** How the two pictures differ, in colour bytes (0 to 255): overall, and the average brightness of each across a coarse grid. */
function compare(web: HTMLCanvasElement, theirs: HTMLImageElement, columns = 24, rows = 6) {
  const reference = document.createElement("canvas");
  reference.width = theirs.naturalWidth;
  reference.height = theirs.naturalHeight;
  reference.getContext("2d")!.drawImage(theirs, 0, 0);
  const a = sampled(web, columns, rows), b = sampled(reference, columns, rows);
  const mean = { web: [0, 0, 0], apple: [0, 0, 0] }, apart = [0, 0, 0];
  const grid = { web: [] as number[][], apple: [] as number[][] };
  for (let r = 0; r < rows; r++) {
    const rowWeb: number[] = [], rowApple: number[] = [];
    for (let c = 0; c < columns; c++) {
      const at = (r * columns + c) * 4;
      for (let ch = 0; ch < 3; ch++) {
        mean.web[ch]! += a[at + ch]!;
        mean.apple[ch]! += b[at + ch]!;
        apart[ch]! += Math.abs(a[at + ch]! - b[at + ch]!);
      }
      rowWeb.push(Math.round((a[at]! + a[at + 1]! + a[at + 2]!) / 3));
      rowApple.push(Math.round((b[at]! + b[at + 1]! + b[at + 2]!) / 3));
    }
    grid.web.push(rowWeb);
    grid.apple.push(rowApple);
  }
  const cells = columns * rows, round = (v: number[]) => v.map((x) => Math.round((x / cells) * 10) / 10);
  return { meanWeb: round(mean.web), meanApple: round(mean.apple), apart: round(apart), grid };
}

async function main(): Promise<void> {
  const develop = developFromAddress();
  const canvas = document.getElementById("web") as HTMLCanvasElement, theirs = document.getElementById("apple") as HTMLImageElement;
  const started = performance.now();
  const renderer = makeRenderer(canvas, develop, true);
  // Waited for by its load, not decode(): in a window out of sight, decode() waits for a frame that doesn't come.
  const theirsLoaded = theirs.complete ? Promise.resolve() : new Promise((done) => theirs.addEventListener("load", done, { once: true }));
  const [textures] = await Promise.all([loadBookTextures(renderer, Number(new URLSearchParams(location.search).get("studioWhite") ?? 1)), loadSpineFaces(), theirsLoaded]);
  const loaded = performance.now();
  const shelves = layOutCase(caseBooks, WIDTH, K, measureRun, Date.now());
  const row = new ShelfRow(shelves[0]!, WIDTH, K, SCALE, textures, develop);
  const built = performance.now();
  renderer.setPixelRatio(SCALE);
  renderer.setSize(WIDTH, Math.round(row.height * SCALE) / SCALE);
  renderer.render(row.scene, row.camera);
  renderer.getContext().finish();
  const drawn = performance.now();
  theirs.style.width = `${WIDTH}px`;

  const report = {
    layout: layoutDifferences(shelves),
    size: { web: [canvas.width, canvas.height], apple: [theirs.naturalWidth, theirs.naturalHeight] },
    ms: { loading: Math.round(loaded - started), building: Math.round(built - loaded), drawing: Math.round(drawn - built) },
    develop,
    compare: (columns?: number, rows?: number) => compare(canvas, theirs, columns, rows),
    redraw: () => renderer.render(row.scene, row.camera),
    row,
    renderer,
  };
  (window as unknown as { proof: typeof report }).proof = report;
  document.title = "ready";
}

main().catch((error) => {
  document.title = "failed";
  (window as unknown as { proofError: string }).proofError = String(error?.stack ?? error);
  console.error(error);
});
