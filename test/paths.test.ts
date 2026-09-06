import { describe, expect, it } from "vitest";
import { joinPath } from "../src/host/paths";

describe("joinPath", () => {
  it("joins drive paths with backslashes", () => {
    expect(joinPath(["E:\\CODE\\ribbon\\books", "Horus Rising", "Chapter 1.m4a"])).toBe("E:\\CODE\\ribbon\\books\\Horus Rising\\Chapter 1.m4a");
    expect(joinPath(["E:\\books\\", "\\.ribbon\\", "library.csv"])).toBe("E:\\books\\.ribbon\\library.csv");
  });

  it("keeps the leading double backslash of a network share", () => {
    const root = "\\\\100.90.125.11\\media\\AUDIO BOOKS\\Warhammer 40K - The Horus Heresy";
    expect(joinPath([root, ".ribbon", "library.csv"])).toBe(root + "\\.ribbon\\library.csv");
    expect(joinPath([root])).toBe(root);
    expect(joinPath([root + "\\", "Book", "01.mp3"])).toBe(root + "\\Book\\01.mp3");
  });

  it("converts forward slashes inside relative parts to the root's separator", () => {
    expect(joinPath(["\\\\nas\\share", "Series/Book/01.mp3"])).toBe("\\\\nas\\share\\Series\\Book\\01.mp3");
    expect(joinPath(["E:\\lib", "a/b/c.mp3"])).toBe("E:\\lib\\a\\b\\c.mp3");
  });

  it("joins posix paths", () => {
    expect(joinPath(["/home/k/books", "Book", "01.mp3"])).toBe("/home/k/books/Book/01.mp3");
    expect(joinPath(["/home/k/books/", "/x"])).toBe("/home/k/books/x");
  });

  it("treats a forward-slash network root the same way", () => {
    expect(joinPath(["//100.90.125.11/media", "x.csv"])).toBe("//100.90.125.11/media/x.csv");
  });

  it("ignores empty parts", () => {
    expect(joinPath(["", "E:\\lib", "", "a"])).toBe("E:\\lib\\a");
  });
});
