import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READ_ALONG_FORMAT, type ReadAlong } from "../../src/core/reading/readalong.ts";
import { openDatabase } from "../src/db.ts";
import { SearchIndex } from "../src/library/search.ts";

/** A read-along as the server makes one: paragraphs whose sentences are offsets into their text, each with when it's read. */
function readAlongOf(chapters: { title: string; paragraphs: string[][] }[]): ReadAlong {
  const blocks: ReadAlong["blocks"] = [];
  const contents: ReadAlong["contents"] = [];
  let ms = 0;
  for (const chapter of chapters) {
    contents.push({ title: chapter.title, block: blocks.length });
    blocks.push({ k: "h", level: 1, runs: [{ t: chapter.title }], sentences: [{ start: 0, end: chapter.title.length, ms, endMs: ms, exact: false }] });
    for (const sentences of chapter.paragraphs) {
      let text = "";
      const marks = sentences.map((s) => {
        text += (text ? " " : "") + s;
        const at = { start: text.length - s.length, end: text.length, ms, endMs: ms + 3000, exact: true };
        ms += 3000;
        return at;
      });
      blocks.push({ k: "p", runs: [{ t: text }], sentences: marks });
    }
  }
  return { format: READ_ALONG_FORMAT, ready: true, transcribed: { done: 1, total: 1 }, contents, blocks, check: { placed: 1, heldOut: null } };
}

const OZ = readAlongOf([
  {
    title: "The Council with the Munchkins",
    paragraphs: [["Dorothy listened to this speech with wonder.", "What could the little woman possibly mean by calling her a sorceress?"]],
  },
  {
    title: "The Magic Art of the Great Humbug",
    paragraphs: [
      ["Next morning the Scarecrow said to his friends: “Congratulate me.", "I am going to Oz to get my brains at last.”"],
      ["Oz filled the Scarecrow's head with bran, mixed with a great many pins and needles."],
    ],
  },
]);

describe("searching books' sentences", () => {
  let dir: string;
  let db: DatabaseSync;
  let search: SearchIndex;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-search-"));
    db = openDatabase(dir);
    search = new SearchIndex(db);
    search.index("oz", "stamp-1", OZ);
    search.index("other", "stamp-1", readAlongOf([{ title: "One", paragraphs: [["A scarecrow stood in the field of another book."]] }]));
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a half-remembered line, its words stemmed and in any order, the best match first", () => {
    const [best] = search.search("where the scarecrow gets his brains");
    // Counted as the read-along counts sentences: the first chapter's heading and two sentences, the second's heading, then this one.
    expect(best).toMatchObject({ book: "oz", sentence: 5, chapter: "The Magic Art of the Great Humbug", text: "I am going to Oz to get my brains at last.”" });
    expect(best!.ms).toBe(9000);
    expect(best!.matches.map(([start, length]) => best!.text.slice(start, start + length))).toEqual(["get", "brains"]);
  });

  it("finds a line said word for word first, however common its words are", () => {
    // "say" is in two dozen short sentences; alone it would rank the long one with the line last, past the limit.
    const plenty = Array.from({ length: 24 }, (_, i) => [`I say it ${i}.`]);
    search.index("heresy", "stamp-1", readAlongOf([{ title: "Echoes", paragraphs: [...plenty, ["Sanguinius stood before the gathered sons of his Legion and asked them, in a voice that carried to the last of the ranks, ‘What say you, warriors of the Ninth Legion?’"]] }]));
    const [best] = search.search("What say you", { book: "heresy" });
    expect(best!.text).toContain("‘What say you, warriors of the Ninth Legion?’");
    expect(best!.matches.map(([start, length]) => best!.text.slice(start, start + length)).join("")).toBe("What say you");
    search.remove("heresy");
  });

  it("marks the words that matched", () => {
    const [found] = search.search("wonder", { book: "oz" });
    expect(found!.text).toBe("Dorothy listened to this speech with wonder.");
    expect(found!.matches.map(([start, length]) => found!.text.slice(start, start + length))).toEqual(["wonder"]);
  });

  it("searches one book or every one", () => {
    expect(new Set(search.search("scarecrow").map((f) => f.book))).toEqual(new Set(["oz", "other"]));
    expect(search.search("scarecrow", { book: "other" }).map((f) => f.book)).toEqual(["other"]);
  });

  it("reads anything said as words, never as search syntax", () => {
    expect(search.search("")).toEqual([]);
    // The commonest words are words like any other.
    expect(search.search("to this")[0]).toMatchObject({ book: "oz", sentence: 1 });
    expect(search.search("“ ” ? !")).toEqual([]);
    expect(search.search('pins AND "needles NEAR(')[0]).toMatchObject({ book: "oz", sentence: 6 });
  });

  it("indexes a book again from a new read-along, and forgets a deleted one", () => {
    expect(search.isCurrent("other", "stamp-1")).toBe(true);
    search.index("other", "stamp-2", readAlongOf([{ title: "One", paragraphs: [["Nothing but a tin woodman here."]] }]));
    expect(search.isCurrent("other", "stamp-1")).toBe(false);
    expect(search.search("scarecrow", { book: "other" })).toEqual([]);
    expect(search.search("woodman").map((f) => f.book)).toEqual(["other"]);
    search.remove("other");
    expect(search.search("woodman")).toEqual([]);
    expect(search.isCurrent("other", "stamp-2")).toBe(false);
  });
});
