import { BoxGeometry, Mesh, PerspectiveCamera, PlaneGeometry, Scene, Vector3 } from "three";
import { CASE_SHELF_HEIGHT, layOutCase, type CaseBook } from "@ribbon/core/bookcase/case";
import { rgb } from "@ribbon/core/bookcase/cloth";
import { colourOf } from "./book-model";
import { CASE_BACK, CASE_BOARD, hangLamp, hasGraphicsCard, LAMP, letGo, lightRoom, makeRenderer, shelfLamp, type Develop } from "./lamplight";
import { caseWood, standBook } from "./shelf-row";
import { loadSpineFaces, measureRun } from "./spine-art";
import { loadBookTextures } from "./textures";

/** How many books stand in the picture: enough to run out of sight into the dark, even in a wide one. */
export const VIGNETTE_BOOKS = 22;
/** The book tipped out, counted from the left. */
const TIPPED = 3;

/**
 * The invitation's picture: a short run of the newest books on a shelf of the bookcase, seen from a little to the left
 * and above, with the fourth tipped towards you as a finger takes it down, under one lamp. It is the bookcase's own
 * scene, books, wood and light, drawn once into a picture; everything it was drawn with is let go as soon as it is drawn.
 * `books` are the newest, in the shelf's order. Null on a machine with no graphics card.
 *
 * The Apple app's is `Vignette` in packages/apple/Ribbon/Bookcase/BookcaseInvitation.swift.
 */
export async function drawVignette(books: readonly CaseBook[], width: number, height: number, scale: number, develop: Develop = LAMP): Promise<HTMLCanvasElement | null> {
  if (books.length === 0 || !hasGraphicsCard()) return null;
  await loadSpineFaces();
  const drawing = document.createElement("canvas");
  const renderer = makeRenderer(drawing, develop, true);
  try {
    const textures = await loadBookTextures(renderer);
    const k = 1;
    // One long line: the books in the order given, as the bookcase stands them.
    const items = layOutCase(books, Number.MAX_SAFE_INTEGER, k, measureRun, Date.now())[0] ?? [];
    const pad = Math.round(16 * k), shelfH = Math.round(CASE_SHELF_HEIGHT * k), boardH = Math.round(12 * k);
    const front = Math.round(8 * k), depth = Math.round(150 * k);
    const last = items[items.length - 1];
    const length = (last ? last.x + last.spine.width : 0) + 40 * k;
    const scene = new Scene();
    scene.background = colourOf(rgb(0x0a0a0a));

    // The case: its back, its board and the shelf above, with no ends, so the run of books carries on out of sight.
    const back = new Mesh(new PlaneGeometry(length + 800, pad + shelfH + 2 * boardH + 400), caseWood(textures, CASE_BACK, 0.9, length + 800));
    back.position.set(length / 2, (pad + shelfH) / 2, -depth);
    back.receiveShadow = true;
    scene.add(back);
    const boardWood = caseWood(textures, CASE_BOARD, 0.75, length + 800);
    for (const y of [-boardH / 2, pad + shelfH + boardH / 2]) {
      const board = new Mesh(new BoxGeometry(length + 800, boardH, depth + front), boardWood);
      board.position.set(length / 2, y, (front - depth) / 2);
      board.castShadow = board.receiveShadow = true;
      scene.add(board);
    }

    let focus = new Vector3(length / 2, shelfH * 0.45, 0);
    items.forEach((item, i) => {
      const book = standBook(item, k, scale, front, textures);
      if (i === Math.min(TIPPED, items.length - 1)) {
        // Where a book taken down comes to rest: tipped on its front foot towards you, and drawn a little out.
        book.pivot.rotation.x = (11 * Math.PI) / 180;
        book.pivot.position.set(item.x, 3 * k, 28 * k);
        focus = new Vector3(item.x + item.spine.width / 2, item.spine.height * 0.5, 20 * k);
      }
      scene.add(book.node);
    });

    // The bookcase's light: the room's faint fill, and a lamp over the tipped book, another further along fading out.
    const rig = { width: length, shelfH, pad, depth, front, k };
    lightRoom(scene, textures.studio, new Vector3(focus.x, shelfH / 2, -depth / 2), develop);
    for (const x of [focus.x, focus.x + 260 * k]) hangLamp(scene, shelfLamp(develop), x, rig);

    // Seen from a little to the left and above, so the run recedes to the right and the tipped book stands out of it.
    const camera = new PerspectiveCamera(24, width / height, 50, 4000);
    // Nearer in a wide picture, where the run has room to carry on to the right.
    const wide = width / height > 1.8, distance = wide ? 520 : 600, turn = (30 * Math.PI) / 180, rise = (9 * Math.PI) / 180;
    camera.position.set(focus.x - distance * Math.sin(turn) * Math.cos(rise), focus.y + distance * Math.sin(rise), focus.z + distance * Math.cos(turn) * Math.cos(rise));
    // Aimed a little right of the tipped book, so the books it stands among fill the picture.
    camera.lookAt(focus.x + (wide ? 120 : 70) * k, focus.y, focus.z - 20);

    renderer.setPixelRatio(scale);
    renderer.setSize(width, height, false);
    renderer.render(scene, camera);
    const picture = document.createElement("canvas");
    picture.width = drawing.width;
    picture.height = drawing.height;
    picture.getContext("2d")!.drawImage(drawing, 0, 0);
    letGo(scene);
    return picture;
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
