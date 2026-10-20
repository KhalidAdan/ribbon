import { describe, expect, it, vi } from "vitest";
import type { Ebook } from "../src/core/ebook";
import type { FromWorker, LayoutSpec, SectionLayout, ToWorker } from "../src/reader/layout";
import { LayoutEngine } from "../src/reader/layout-engine";

const book = { files: {} } as unknown as Ebook;

/** A spec told apart by its column only. */
const spec = (column: number): LayoutSpec => ({ metrics: { size: 16, lineHeight: 24, column, pageHeight: 600 } as LayoutSpec["metrics"], justify: false });

/** A layout that says which section and column it was made for, and a log of what was laid out. */
function engine() {
  const done: string[] = [];
  const e = new LayoutEngine(book, (section, s) => {
    done.push(`${section}@${s.metrics.column}`);
    return { blocks: [], pages: [], flow: { section, items: [], height: s.metrics.column } } as SectionLayout;
  });
  return { e, done };
}

/** Let the engine lay out everything queued: one chapter per task. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A stand-in for the layout worker: answers each chapter on the next task, unless it was stopped. */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((e: { data: FromWorker }) => void) | null = null;
  onerror: unknown = null;
  terminated = false;
  asked: number[] = [];

  constructor() {
    FakeWorker.made.push(this);
  }

  postMessage(m: ToWorker): void {
    if (m.kind !== "lay out") return;
    this.asked.push(m.section);
    const layout = { blocks: [], pages: [], flow: { section: m.section, items: [], height: m.spec.metrics.column } } as unknown as SectionLayout;
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: { kind: "laid out", id: m.id, section: m.section, layout, ms: 0 } });
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("layout engine", () => {
  it("lays out what is wanted first, then the rest in order", async () => {
    const { e, done } = engine();
    e.setSpec(spec(400));
    e.later([5, 6, 7]);
    e.want([2, 3]);
    await settle();
    // 5 was already under way when 2 and 3 were wanted; they come straight after it.
    expect(done).toEqual(["5@400", "2@400", "3@400", "6@400", "7@400"]);
    expect(e.get(2)?.flow.height).toBe(400);
  });

  it("lays everything out again for a new spec, in the same order, without asking", async () => {
    const { e, done } = engine();
    e.setSpec(spec(400));
    e.want([2]);
    e.later([3, 4]);
    await settle();
    done.length = 0;
    // A resize: nobody asks again, as the page does not when only the window changed.
    e.setSpec(spec(300));
    await settle();
    expect(done).toEqual(["2@300", "3@300", "4@300"]);
    expect(e.get(2)?.flow.height).toBe(300);
  });

  it("keeps showing the last layout until the new one arrives", async () => {
    const { e } = engine();
    e.setSpec(spec(400));
    e.want([2]);
    await settle();
    e.setSpec(spec(300));
    // Laid out for the old window, but still there to draw.
    expect(e.get(2)?.flow.height).toBe(400);
    expect(e.isFresh(2)).toBe(false);
    await settle();
    expect(e.get(2)?.flow.height).toBe(300);
    expect(e.isFresh(2)).toBe(true);
  });

  it("never loses a chapter over a drag of many sizes", async () => {
    const { e } = engine();
    e.setSpec(spec(400));
    e.want([2]);
    await settle();
    for (let column = 399; column > 300; column -= 7) {
      e.setSpec(spec(column));
      expect(e.get(2)).toBeDefined();
      await new Promise((r) => setTimeout(r, 0));
      expect(e.get(2)).toBeDefined();
    }
    await settle();
    expect(e.get(2)?.flow.height).toBe(301);
  });

  // In development, React's StrictMode unmounts the reader and mounts it once
  // more with the same engine: destroy, then start, with the page asking for
  // chapters in between.
  describe("destroyed and started again", () => {
    async function withWorkers(test: () => Promise<void>) {
      FakeWorker.made = [];
      vi.stubGlobal("Worker", FakeWorker);
      vi.stubGlobal("OffscreenCanvas", class {});
      try {
        await test();
      } finally {
        vi.unstubAllGlobals();
      }
    }

    it("keeps what is asked in between, then lays it out in a new worker", () =>
      withWorkers(async () => {
        const e = new LayoutEngine(book);
        e.start();
        expect(FakeWorker.made).toHaveLength(1);
        e.setSpec(spec(400));
        e.destroy();
        expect(() => e.want([3])).not.toThrow();
        e.start();
        await settle();
        expect(FakeWorker.made).toHaveLength(2);
        expect(FakeWorker.made[0]?.terminated).toBe(true);
        expect(FakeWorker.made[1]?.asked).toEqual([3]);
        expect(e.get(3)?.flow.height).toBe(400);
      }));

    it("asks again for the chapter the stopped worker was laying out", () =>
      withWorkers(async () => {
        const e = new LayoutEngine(book);
        e.setSpec(spec(400));
        e.want([2]);
        e.destroy();
        e.start();
        await settle();
        expect(FakeWorker.made[1]?.asked).toEqual([2]);
        expect(e.get(2)?.flow.height).toBe(400);
      }));
  });
});
