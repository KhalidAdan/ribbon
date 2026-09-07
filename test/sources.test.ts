import { describe, expect, it } from "vitest";
import { sameRoot, sourceFrom, sourceId, sourceName } from "../src/core/sources";

describe("sourceId", () => {
  it("is FNV-1a 64 of the normalised path, matching the host's mirror key", () => {
    // Known vectors for FNV-1a 64.
    expect(sourceId("")).toBe("cbf29ce484222325");
    expect(sourceId("a")).toBe("af63dc4c8601ec8c");
  });

  it("ignores slash style, a trailing slash and case", () => {
    expect(sourceId("\\\\nas\\media\\Books\\")).toBe(sourceId("//nas/media/books"));
    expect(sourceId("E:/a")).not.toBe(sourceId("E:/b"));
  });
});

describe("sourceName and sameRoot", () => {
  it("names a source after its folder", () => {
    expect(sourceName("\\\\nas\\media\\Books\\")).toBe("Books");
    expect(sourceName("/home/k/audio")).toBe("audio");
    expect(sourceFrom({ root: "E:\\Heresy", addedAt: "2026-09-07T00:00:00Z" })).toEqual({ id: sourceId("E:\\Heresy"), root: "E:\\Heresy", name: "Heresy", addedAt: "2026-09-07T00:00:00Z" });
  });

  it("compares roots the way the host does", () => {
    expect(sameRoot("E:\\Books\\", "e:/books")).toBe(true);
    expect(sameRoot("E:\\Books", "E:\\Books2")).toBe(false);
  });
});
