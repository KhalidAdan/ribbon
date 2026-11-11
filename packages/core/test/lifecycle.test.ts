import { describe, expect, it } from "vitest";
import { OPEN, OPENING, phaseOf, type FolderState } from "@ribbon/core/lifecycle";

const failed: FolderState = { status: "failed", why: "not a directory: /other" };

describe("the library's phase, from its folders", () => {
  it("is boot until the folders are known, whatever they are", () => {
    for (const folders of [[], [OPEN], [OPENING], [failed]]) expect(phaseOf(false, folders)).toBe("boot");
  });

  it("is the first screen with no folders, or none that would open", () => {
    expect(phaseOf(true, [])).toBe("pick");
    expect(phaseOf(true, [failed])).toBe("pick");
    expect(phaseOf(true, [failed, failed])).toBe("pick");
  });

  it("is loading while a folder opens and none is open, and ready once any is", () => {
    expect(phaseOf(true, [OPENING])).toBe("loading");
    expect(phaseOf(true, [failed, OPENING])).toBe("loading");
    expect(phaseOf(true, [OPENING, OPEN])).toBe("ready");
    expect(phaseOf(true, [failed, OPEN])).toBe("ready");
  });
});
