import { describe, expect, it } from "vitest";
import { countWords } from "@ribbon/core/reading/wordcount";

describe("counting a text's words", () => {
  it("counts each word once, whatever punctuation is around it", () => {
    expect(countWords("The waygate hung in the void before them.")).toBe(8);
    expect(countWords("“Go,” she said — and went.")).toBe(5);
  });

  it("keeps a word with an apostrophe or hyphen inside it whole", () => {
    expect(countWords("It wasn’t a well-known world, and they'd never been.")).toBe(9);
  });

  it("keeps a number with a point or comma inside it whole", () => {
    expect(countWords("10,000 men marched 3.5 leagues.")).toBe(5);
  });

  it("counts letters of any language, and nothing in punctuation alone", () => {
    expect(countWords("Brontë écrivait à Haworth.")).toBe(4);
    expect(countWords(" — … ! ")).toBe(0);
    expect(countWords("")).toBe(0);
  });
});
