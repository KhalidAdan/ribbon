import { afterEach, describe, expect, it, vi } from "vitest";

/** As much of a worker's global scope as the layout worker touches when it loads. */
function workerScope() {
  return { postMessage: vi.fn(), onmessage: null as unknown, fonts: undefined };
}

describe("layout worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps its messages when its file runs a second time in the same worker, as WebKit does", async () => {
    const scope = workerScope();
    vi.stubGlobal("self", scope);
    await import("../src/reader/layout.worker");
    const first = scope.onmessage;
    expect(first).toBeTypeOf("function");
    // A chunk importing the worker's entry: WebKit runs the file again.
    vi.resetModules();
    await import("../src/reader/layout.worker");
    expect(scope.onmessage).toBe(first);
  });
});
