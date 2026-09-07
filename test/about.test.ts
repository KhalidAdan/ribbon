import { describe, expect, it } from "vitest";
import { aboutToBytes, bytesToAbout, cleanTitle, matchWork, needsLookup, parseSearch, parseWork, searchUrl } from "../src/core/about";

const search = {
  docs: [
    { key: "/works/OL1W", title: "Horus Rising", author_name: ["Dan Abnett"], first_publish_year: 2006 },
    { key: "/works/OL2W", title: "Horus Rising: The Seeds of Heresy Are Sown", author_name: ["Dan Abnett"] },
    { key: "/works/OL3W", title: "Horus Rising", author_name: ["Someone Else"] },
    { key: 7, title: "broken" },
  ],
};

describe("cleanTitle", () => {
  it("drops folder numbers, unabridged notes and series tails", () => {
    expect(cleanTitle("01. Horus Rising")).toBe("Horus Rising");
    expect(cleanTitle("Horus Rising (Unabridged)")).toBe("Horus Rising");
    expect(cleanTitle("Raven's Flight: The Horus Heresy Series")).toBe("Raven's Flight");
    expect(cleanTitle("2001: A Space Odyssey")).toBe("2001: A Space Odyssey");
    expect(cleanTitle("7.5_Legion")).toBe("Legion");
  });
});

describe("parseSearch and matchWork", () => {
  it("reads candidates and skips broken docs", () => {
    const c = parseSearch(search);
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({ key: "/works/OL1W", title: "Horus Rising", authors: ["Dan Abnett"], firstYear: 2006 });
    expect(parseSearch(null)).toEqual([]);
    expect(parseSearch({ docs: "no" })).toEqual([]);
  });

  it("matches on the folded title and the author's surname", () => {
    const c = parseSearch(search);
    expect(matchWork(c, "01. Horus Rising", "Dan Abnett")?.key).toBe("/works/OL1W");
    expect(matchWork(c, "horus rising (Unabridged)", "D. Abnett")?.key).toBe("/works/OL1W");
  });

  it("allows a subtitle after a colon but nothing else", () => {
    const c = parseSearch({ docs: [search.docs[1]] });
    expect(matchWork(c, "Horus Rising", "Dan Abnett")?.key).toBe("/works/OL2W");
    expect(matchWork(parseSearch({ docs: [{ key: "/works/OL9W", title: "Horus Rising Again", author_name: ["Dan Abnett"] }] }), "Horus Rising", "Dan Abnett")).toBeNull();
  });

  it("accepts a title that trails off into series notes when the author confirms it", () => {
    const c = parseSearch({ docs: [{ key: "/works/OL8W", title: "The First Heretic                            Warhammer 40000 Novels Horus Heresy", author_name: ["Aaron Dembski-Bowden"] }] });
    expect(matchWork(c, "14. The First Heretic", "Aaron Dembski-Bowden")?.key).toBe("/works/OL8W");
    expect(matchWork(c, "14. The First Heretic", "")).toBeNull();
  });

  it("refuses a title match by the wrong author, and matches by title alone when no author is known", () => {
    const c = parseSearch({ docs: [search.docs[2]] });
    expect(matchWork(c, "Horus Rising", "Dan Abnett")).toBeNull();
    expect(matchWork(c, "Horus Rising", "")?.key).toBe("/works/OL3W");
  });
});

describe("parseWork", () => {
  it("reads a plain or wrapped description and strips markdown links and source tails", () => {
    expect(parseWork({ description: "Plain text." })).toBe("Plain text.");
    expect(parseWork({ description: { type: "/type/text", value: "See [the wiki](https://x).\r\n\r\n\r\nMore.\n----------\nSource: somewhere" } })).toBe("See the wiki.\n\nMore.");
    expect(parseWork({})).toBe("");
    expect(parseWork(null)).toBe("");
  });
});

describe("about records", () => {
  it("round-trip through CSV, including newlines in descriptions", async () => {
    const list = [
      { bookId: "a", source: "openlibrary" as const, key: "/works/OL1W", title: "Horus Rising", description: "Line one.\n\nLine two, with \"quotes\" and, commas.", fetchedAt: "2026-09-07T03:00:00.000Z" },
      { bookId: "b", source: "none" as const, key: "", title: "", description: "", fetchedAt: "2026-09-07T03:00:00.000Z" },
    ];
    expect(await bytesToAbout(await aboutToBytes(list))).toEqual(list);
  });

  it("asks again for a miss after a month, never for a hit", () => {
    const now = Date.parse("2026-10-10T00:00:00.000Z");
    expect(needsLookup(undefined, now)).toBe(true);
    expect(needsLookup({ bookId: "a", source: "openlibrary", key: "k", title: "t", description: "d", fetchedAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(false);
    expect(needsLookup({ bookId: "b", source: "none", key: "", title: "", description: "", fetchedAt: "2026-10-01T00:00:00.000Z" }, now)).toBe(false);
    expect(needsLookup({ bookId: "b", source: "none", key: "", title: "", description: "", fetchedAt: "2026-08-01T00:00:00.000Z" }, now)).toBe(true);
  });

  it("builds the search URL from the cleaned title and author", () => {
    expect(searchUrl("01. Horus Rising", "Dan Abnett")).toBe("https://openlibrary.org/search.json?title=Horus%20Rising&author=Dan%20Abnett&limit=5&fields=key,title,author_name,first_publish_year");
  });
});
