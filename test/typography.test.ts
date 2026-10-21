import { describe, expect, it } from "vitest";
import { DEFAULT_READING, justifies, metricsFor, parseReading } from "../src/core/reading/typography";
import { bookPage } from "../src/core/reading/pages";

const phone = { width: 375, height: 560 };

describe("the reader's column", () => {
  it("on a phone, Width sets the margins: narrow, normal and wide", () => {
    const columns = [0, 1, 2].map((width) => metricsFor({ ...DEFAULT_READING, width }, phone).column);
    expect(columns).toEqual([375 - 2 * 36, 375 - 2 * 28, 375 - 2 * 21]);
  });

  it("on a wide window, keeps two pages side by side as before", () => {
    const m = metricsFor(DEFAULT_READING, { width: 1280, height: 800 });
    expect(m.columns).toBe(2);
    expect(m.column).toBe(547);
  });

  it("on a wide window, a single column is the full measure", () => {
    const m = metricsFor({ ...DEFAULT_READING, layout: "scroll" }, { width: 1280, height: 800 });
    expect(m.columns).toBe(1);
    expect(m.column).toBe(32 * 19);
  });
});

describe("justifying", () => {
  const phoneColumn = { column: 319, size: 19 };
  const desktopColumn = { column: 608, size: 19 };

  it("left unset, justifies a desktop's lines and leaves a phone's ragged", () => {
    expect(justifies(DEFAULT_READING, desktopColumn, true)).toBe(true);
    expect(justifies(DEFAULT_READING, phoneColumn, true)).toBe(false);
  });

  it("turned on, justifies a phone's lines when they can hyphenate", () => {
    expect(justifies({ ...DEFAULT_READING, justify: true }, phoneColumn, true)).toBe(true);
    expect(justifies({ ...DEFAULT_READING, justify: true }, phoneColumn, false)).toBe(false);
  });

  it("turned off, never justifies", () => {
    expect(justifies({ ...DEFAULT_READING, justify: false }, desktopColumn, true)).toBe(false);
  });

  it("keeps a choice made, and leaves an unmade one unset", () => {
    expect(parseReading({}).justify).toBeUndefined();
    expect(parseReading({ justify: false }).justify).toBe(false);
    expect(parseReading({ justify: true }).justify).toBe(true);
  });
});

describe("the page in the book", () => {
  it("counts the chapters before, then the page in this one", () => {
    expect(bookPage([3, 10, 7], 1, 4)).toEqual({ page: 8, of: 20 });
    expect(bookPage([3, 10, 7], 0, 0)).toEqual({ page: 1, of: 20 });
  });

  it("says nothing until every chapter is laid out", () => {
    expect(bookPage([3, undefined, 7], 2, 0)).toBeNull();
  });
});
