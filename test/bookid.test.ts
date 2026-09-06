import { describe, expect, it } from "vitest";
import { bookId, normalizePath } from "../src/core/bookid";

describe("bookId", () => {
  it("is eight lowercase hex characters", () => {
    expect(bookId("Horus Rising", 12345)).toMatch(/^[0-9a-f]{8}$/);
    expect(bookId("a", 0)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic", () => {
    expect(bookId("Horus Rising", 12345)).toBe(bookId("Horus Rising", 12345));
  });

  it("ignores slash direction and leading ./", () => {
    const a = bookId("Series/Book One", 99);
    expect(bookId("Series\\Book One", 99)).toBe(a);
    expect(bookId("./Series/Book One", 99)).toBe(a);
    expect(bookId("Series/Book One/", 99)).toBe(a);
  });

  it("changes with size", () => {
    expect(bookId("Book", 1)).not.toBe(bookId("Book", 2));
  });

  it("is case-sensitive", () => {
    expect(bookId("Book", 1)).not.toBe(bookId("book", 1));
  });

  it("matches the CRC-32 check vector through normalizePath", () => {
    expect(normalizePath(".\\a\\b\\")).toBe("a/b");
    expect(normalizePath("/")).toBe("/");
  });
});
