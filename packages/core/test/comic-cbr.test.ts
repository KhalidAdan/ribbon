import { describe, expect, it } from "vitest";
import { CBR_REFUSALS, cbrRefusal, startsAsRar } from "@ribbon/core/comic/cbr";
import { groupBooks } from "@ribbon/core/scan/group";
import { isComic, type FileEntry } from "@ribbon/core/scan/walk";

const f = (relPath: string): FileEntry => ({ relPath, absPath: `/lib/${relPath}`, name: relPath.slice(relPath.lastIndexOf("/") + 1), sizeBytes: 1, mtimeMs: 0 });

describe("a CBR", () => {
  it("is a comic, a book of its own on the shelf as a CBZ is", () => {
    expect(isComic("Saga 014 (2013).cbr")).toBe(true);
    expect(isComic("Saga 014 (2013).CBR")).toBe(true);
    expect(isComic("Saga 014 (2013).cb7")).toBe(false);
    expect(isComic("Saga 014 (2013).rar")).toBe(false);
    const groups = groupBooks([f("Saga/Saga 001.cbr"), f("Saga/Saga 002.cbz"), f("Saga/cover.jpg")]);
    expect(groups.map((g) => g.comic)).toEqual(["Saga/Saga 001.cbr", "Saga/Saga 002.cbz"]);
    expect(groups.map((g) => g.name)).toEqual(["Saga 001", "Saga 002"]);
  });

  it("is told from a zip by its first bytes, not its name", () => {
    const bytes = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
    expect(startsAsRar(bytes("Rar!\x1a\x07\x00"))).toBe(true); // RAR 1.5 to 4
    expect(startsAsRar(bytes("Rar!\x1a\x07\x01\x00"))).toBe(true); // RAR 5
    expect(startsAsRar(bytes("PK\x03\x04 a zip called .cbr"))).toBe(false);
    expect(startsAsRar(bytes("Rar!"))).toBe(false);
    expect(startsAsRar(new Uint8Array())).toBe(false);
  });

  it("is refused in a sentence when it is locked or split, whatever the host wrapped the sentence in", () => {
    // The Rust reader's words (packages/desktop/src-tauri/cbr/src/lib.rs, `LOCKED` and `SPLIT`): the two must agree.
    expect(CBR_REFUSALS.locked).toBe("It is locked with a password, and Ribbon opens only comics that aren't.");
    expect(CBR_REFUSALS.split).toBe("It is one part of an archive split across several files, and Ribbon reads a comic from one file.");
    expect(cbrRefusal(CBR_REFUSALS.locked)).toBe(CBR_REFUSALS.locked);
    expect(cbrRefusal(new Error(`${CBR_REFUSALS.split}\n`))).toBe(CBR_REFUSALS.split);
    expect(cbrRefusal(new Error("invalid Zip archive: Could not find EOCD"))).toBeNull();
    expect(cbrRefusal(undefined)).toBeNull();
  });
});
