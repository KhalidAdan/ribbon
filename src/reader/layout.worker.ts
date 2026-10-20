/// <reference lib="webworker" />
import { clearCache } from "@chenglou/pretext";
import type { Ebook } from "../core/ebook";
import { addFaces } from "./faces";
import { layOutSection, type FromWorker, type ToWorker } from "./layout";
import { Typesetter } from "./typeset";

/**
 * The layout worker: lays out a book's chapters away from the page, so a
 * long chapter never holds up a tap, a page turn or a scroll. It measures
 * with an OffscreenCanvas and the reader's own faces, loaded here
 * (faces.ts), so its lines break exactly as they would on the page.
 * One request at a time, in the order the page asks (layout-engine.ts).
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
let typesetter: Typesetter | null = null;
let ready: Promise<void> = Promise.resolve();

function post(message: FromWorker): void {
  scope.postMessage(message);
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.kind === "open") {
    const images = new Set(m.images);
    const t = new Typesetter(m.ebook as Ebook, (src) => images.has(src));
    typesetter = t;
    ready = Promise.all([addFaces(scope.fonts), t.ready]).then(() => {
      // Anything measured before the faces arrived was measured in a fallback.
      clearCache();
      post({ kind: "ready", hyphenates: t.hyphenates });
    });
    return;
  }
  await ready;
  if (!typesetter) return post({ kind: "failed", id: m.id, section: m.section, message: "no book is open" });
  const t0 = performance.now();
  try {
    const layout = layOutSection(typesetter, m.section, m.spec);
    post({ kind: "laid out", id: m.id, section: m.section, layout, ms: performance.now() - t0 });
  } catch (err) {
    post({ kind: "failed", id: m.id, section: m.section, message: String(err) });
  }
};
