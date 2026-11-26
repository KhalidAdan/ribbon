import { describe, expect, it } from "vitest";
import type { Book } from "@ribbon/core/types";
import { comicLabelIn, coverDateText, creditLines, dayText, namesText } from "../src/ui/comic-details";

/** A comic's own details as its page says them (ui/comic-details.ts). */
describe("a comic's details on its page", () => {
  it("lists its people a role to a line, in the form's order and words, one name or several", () => {
    expect(creditLines({ colours: ["Mike Spicer"], writers: ["Daniel Warren Johnson"], pencils: ["Jorge Corona"], editors: ["Ada Quill", "Ben Nib"], translators: ["Cy Ink"] })).toEqual([
      { role: "writers", label: "Writer", names: "Daniel Warren Johnson" },
      { role: "pencils", label: "Art", names: "Jorge Corona" },
      { role: "colours", label: "Colours", names: "Mike Spicer" },
      { role: "editors", label: "Editors", names: "Ada Quill and Ben Nib" },
      { role: "translators", label: "Translator", names: "Cy Ink" },
    ]);
    expect(creditLines(undefined)).toEqual([]);
    expect(creditLines({ writers: [] })).toEqual([]);
  });

  it("lists names as a sentence does", () => {
    expect(namesText([])).toBe("");
    expect(namesText(["Ada Quill"])).toBe("Ada Quill");
    expect(namesText(["Ada Quill", "Ben Nib", "Cy Ink"])).toBe("Ada Quill, Ben Nib and Cy Ink");
  });

  it("says a cover date as a month and a year, and a day on sale as a day, in the reader's language", () => {
    const month = new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(Date.UTC(2024, 6));
    expect(coverDateText("2024-07")).toContain(month);
    expect(coverDateText("2024-07")).toContain("2024");
    expect(coverDateText("2024")).toBe("2024");
    expect(dayText("2024-07-10")).toMatch(/10/);
    expect(dayText("2024-07-10")).toContain(month);
    // Anything that isn't a date as Ribbon keeps one is said as it is.
    expect(dayText("sometime")).toBe("sometime");
  });

  it("labels a comic by its issue or volume in its own series, and not in a series made by hand", () => {
    const comic = (own: Partial<Book>) => ({ comic: "t.cbz", series: "Transformers (2023)", rawTitle: "", ...own }) as Book;
    expect(comicLabelIn(comic({ issue: "7" }), "Transformers (2023)")).toBe("#7");
    expect(comicLabelIn(comic({ issue: "7" }), "transformers (2023) ")).toBe("#7");
    expect(comicLabelIn(comic({ volume: "1", collects: "1–6" }), "Transformers (2023)")).toBe("Vol. 1");
    expect(comicLabelIn(comic({ issue: "7" }), "Best of 2024")).toBeNull();
    // On its own, and a book that isn't a comic, are labelled as any book is.
    expect(comicLabelIn(comic({}), "Transformers (2023)")).toBeNull();
    expect(comicLabelIn({ series: "Transformers (2023)", rawTitle: "", issue: "7" } as Book, "Transformers (2023)")).toBeNull();
  });
});
