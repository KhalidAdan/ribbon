// The fixed shelf from other angles, close to, and with a book pulled out: the desktop's bookcase on the left, the
// Apple app's picture of the same view on the right. Open one view alone, full size, with ?only=<name>.
//
//   npm run dev -w @ribbon/desktop, then open /tools/shelf-proof/angles.html

import { PerspectiveCamera, Vector3 } from "three";
import { layOutCase } from "@ribbon/core/bookcase/case";
import { makeRenderer } from "../../src/bookcase3d/lamplight";
import { ShelfRow } from "../../src/bookcase3d/shelf-row";
import { loadSpineFaces, measureRun } from "../../src/bookcase3d/spine-art";
import { loadBookTextures } from "../../src/bookcase3d/textures";
import { caseBooks, developFromAddress, K, SCALE, WIDTH } from "./fixture";
import views from "./ref/views.json";

const SHOT = { width: 900, height: 560 };

async function main(): Promise<void> {
  const develop = developFromAddress(), only = new URLSearchParams(location.search).get("only");
  const drawing = document.createElement("canvas");
  const renderer = makeRenderer(drawing, develop, true);
  const [textures] = await Promise.all([loadBookTextures(renderer, Number(new URLSearchParams(location.search).get("studioWhite") ?? 1)), loadSpineFaces()]);
  const row = new ShelfRow(layOutCase(caseBooks, WIDTH, K, measureRun, Date.now())[0]!, WIDTH, K, SCALE, textures, develop);
  renderer.setPixelRatio(SCALE);
  renderer.setSize(SHOT.width, SHOT.height);
  const page = document.getElementById("views")!;

  for (const view of views) {
    if (only && view.name !== only) continue;
    const yaw = (view.yaw * Math.PI) / 180, pitch = (view.pitch * Math.PI) / 180;
    const target = new Vector3(...(view.target as [number, number, number]));
    const camera = new PerspectiveCamera(view.fov, SHOT.width / SHOT.height, 20, 4000);
    camera.position.set(
      target.x + view.distance * Math.sin(yaw) * Math.cos(pitch),
      target.y + view.distance * Math.sin(pitch),
      target.z + view.distance * Math.cos(yaw) * Math.cos(pitch),
    );
    camera.lookAt(target);
    // A book pulled out, as the Apple app leaves it: tipped towards you on its front foot, then drawn out.
    const book = "lift" in view && view.lift ? row.scene.getObjectByName(view.lift) : undefined;
    if (book) {
      book.position.y += 3 * K;
      book.position.z += 28 * K;
      book.rotation.x = (11 * Math.PI) / 180;
    }
    renderer.render(row.scene, camera);
    if (book) {
      book.position.y -= 3 * K;
      book.position.z -= 28 * K;
      book.rotation.x = 0;
    }

    const kept = document.createElement("canvas");
    kept.width = drawing.width;
    kept.height = drawing.height;
    kept.getContext("2d")!.drawImage(drawing, 0, 0);
    const theirs = document.createElement("img");
    theirs.src = `./ref/scenekit-${view.name}.jpg`;
    const heading = document.createElement("h2"), pair = document.createElement("div");
    heading.textContent = view.says;
    pair.className = "pair";
    pair.append(kept, theirs);
    page.append(heading, pair);
  }
  document.title = "ready";
}

main().catch((error) => {
  document.title = "failed";
  (window as unknown as { proofError: string }).proofError = String(error?.stack ?? error);
  console.error(error);
});
