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

const scope = self as unknown as DedicatedWorkerGlobalScope & { ribbonLayout?: true };
let typesetter: Typesetter | null = null;
let ready: Promise<void> = Promise.resolve();

function post(message: FromWorker): void {
  scope.postMessage(message);
}

async function onMessage(e: MessageEvent<ToWorker>): Promise<void> {
  const m = e.data;
  if (m.kind === "open") {
    try {
      const images = new Set(m.images);
      const t = new Typesetter(m.ebook as Ebook, (src) => images.has(src));
      typesetter = t;
      ready = Promise.all([addFaces(scope.fonts), t.ready]).then(
        () => {
          // Anything measured before the faces arrived was measured in a fallback.
          clearCache();
          post({ kind: "ready", hyphenates: t.hyphenates });
        },
        (err: unknown) => {
          typesetter = null;
          post({ kind: "unopened", message: String(err) });
        },
      );
    } catch (err) {
      post({ kind: "unopened", message: String(err) });
    }
    return;
  }
  await ready;
  if (!typesetter) return post({ kind: "unopened", message: "no book is open" });
  const t0 = performance.now();
  try {
    const layout = layOutSection(typesetter, m.section, m.spec);
    post({ kind: "laid out", id: m.id, section: m.section, layout, ms: performance.now() - t0 });
  } catch (err) {
    post({ kind: "failed", id: m.id, section: m.section, message: String(err) });
  }
}

// This file can run twice in one worker. The hyphenation patterns are CommonJS,
// the bundler puts its helper for them in the worker's entry (this file), and
// their chunks import it from here; WebKit runs a module worker's own script
// again for that import rather than reusing it. A second run that took over the
// messages would have no book open, and every chapter failed to lay out on the
// Mac. The first run keeps them.
if (!scope.ribbonLayout) {
  scope.ribbonLayout = true;
  scope.onmessage = onMessage;
}
