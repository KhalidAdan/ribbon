import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { scanLibrary } from "../src/core/scan/scan";

const root = process.env.ODIO_BOOKS ? path.resolve(process.env.ODIO_BOOKS) : null;

describe.skipIf(!root)("the user's real library", () => {
  it("scans Horus Rising and the loose MP3 correctly", async () => {
    const r = await scanLibrary(nodeHost(), root!, { concurrency: 6 });
    expect(r.errors).toEqual([]);
    expect(r.books).toHaveLength(2);

    const horus = r.books.find((b) => b.book.path === "Horus Rising")!;
    expect(horus).toBeDefined();
    expect(horus.book.title).toBe("Horus Rising");
    expect(horus.book.rawTitle).toBe("Horus Rising (Unabridged)");
    expect(horus.book.author).toBe("Dan Abnett");
    expect(horus.book.year).toBe(2017);
    expect(horus.book.cover).toBe("Horus Rising/cover.jpg");
    expect(horus.files).toHaveLength(22);
    expect(horus.files.map((f) => f.track)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect(horus.files.map((f) => f.path)).toEqual(Array.from({ length: 22 }, (_, i) => `Horus Rising/Chapter ${i + 1}.m4a`));
    expect(horus.chapters.map((c) => c.title)).toEqual(Array.from({ length: 22 }, (_, i) => `Chapter ${i + 1}`));
    expect(horus.book.durationMs).toBe(horus.files.reduce((s, f) => s + f.durationMs, 0));

    const ego = r.books.find((b) => b.book.path === "EgoIstheEnemy_ep6.mp3")!;
    expect(ego).toBeDefined();
    expect(ego.book.fileCount).toBe(1);
    expect(ego.book.durationMs).toBeGreaterThan(24_900_000);
    expect(ego.book.durationMs).toBeLessThan(25_100_000);
    expect(ego.files[0]!.hasCover).toBe(true);
    expect(ego.book.cover).toBe(`.odio/covers/${ego.book.id}.jpg`);
  });
});
