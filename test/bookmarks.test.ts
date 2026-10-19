import { describe, expect, it } from "vitest";
import { bookmarksOf, clipArgs, clipName, clipRange, CLIP_X, highlightId, highlightsOf, highlightText, markFields, markId, parseBookmarks, serializeBookmarks } from "../src/core/bookmarks";
import { encodeRecord, parseLog, ribbonClaim, type DelRecord, type LogRecord, type MarkRecord } from "../src/core/poslog";
import type { Bookmark, Highlight, HighlightText } from "../src/core/types";

describe("bookmarks", () => {
  it("round-trips hostile notes and sorts by offset", async () => {
    const list: Bookmark[] = [
      { id: markId("b", 90_000), bookId: "b", offsetMs: 90_000, createdAt: "2026-01-01T00:00:00.000Z", note: 'has "quotes", commas,\nand a newline', clip: "b-90000.opus" },
      { id: markId("b", 10_000), bookId: "b", offsetMs: 10_000, createdAt: "2026-01-01T00:00:00.000Z", note: "", clip: "" },
    ];
    const bytes = await serializeBookmarks(list);
    const { bookmarks, problems } = await parseBookmarks(bytes);
    expect(problems).toEqual([]);
    expect(bookmarks.map((b) => b.offsetMs)).toEqual([10_000, 90_000]);
    expect(bookmarks[1]?.note).toBe(list[0]!.note);
    expect(bookmarks[1]?.id).toBe(list[0]!.id);
  });

  it("computes clip ranges that never go negative", () => {
    expect(clipRange(10_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(clipRange(100_000)).toEqual({ startMs: 70_000, endMs: 100_000 });
    expect(clipRange(0)).toEqual({ startMs: 0, endMs: 0 });
  });

  it("names clips uniquely per offset", () => {
    expect(clipName("abcd", 100_000)).toBe("abcd-100000.opus");
    expect(clipName("abcd", 100_001)).not.toBe(clipName("abcd", 100_000));
  });

  it("builds an ffmpeg command with seconds", () => {
    const args = clipArgs("in.mp3", 70_000, 100_000, "out.opus");
    expect(args).toContain("70.000");
    expect(args).toContain("100.000");
    expect(args[args.length - 1]).toBe("out.opus");
  });
});

const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const NOW = T0 + 3_600_000;
const BOOK = { id: "b1", claims: [ribbonClaim("b1"), "urn:asin:B00X"] };

function bm(offsetMs: number, note = "", min = 0, extra: Partial<Bookmark> = {}): Bookmark {
  return { id: markId("b1", offsetMs), bookId: "b1", offsetMs, createdAt: at(min), note, clip: "", ...extra };
}

/** A mark as a device writes it: the record's time is when the note last changed. */
function mark(dev: string, seq: number, b: Bookmark): MarkRecord {
  return { v: 1, dev, seq, t: b.modifiedAt ?? b.createdAt, book: { ids: [ribbonClaim("b1")] }, ...markFields(b) };
}

function del(dev: string, seq: number, min: number, of: string): DelRecord {
  return { v: 1, k: "del", dev, seq, t: at(min), book: { ids: [ribbonClaim("b1")] }, of };
}

describe("bookmarks in the position log", () => {
  it("ids are stable urn:uuids, one per book and offset", () => {
    const id = markId("b1", 15_834_000);
    expect(id).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(markId("b1", 15_834_000.4)).toBe(id);
    expect(markId("b1", 15_834_001)).not.toBe(id);
    expect(markId("b2", 15_834_000)).not.toBe(id);
  });

  it("a mark is a W3C-style bookmarking annotation with the thirty seconds it keeps", () => {
    const written = mark("d", 1, bm(15_834_000, "The Warmaster's first doubt", 0, { clip: "clips/b1-15834000.opus" }));
    const [back] = parseLog(encodeRecord(written)).records;
    expect(back).toMatchObject({
      k: "mark",
      motivation: "bookmarking",
      created: at(0),
      target: { ms: 15_834_000, selector: { type: "FragmentSelector", conformsTo: "http://www.w3.org/TR/media-frags/", value: "t=15804,15834" } },
      body: "The Warmaster's first doubt",
      x: { [CLIP_X]: "clips/b1-15834000.opus" },
    });
  });

  it("adds, edits and deletes", () => {
    const a = bm(60_000, "first", 1);
    const records: LogRecord[] = [mark("d", 1, a)];
    expect(bookmarksOf(records, BOOK, [], NOW)).toEqual([a]);

    const edited = { ...a, note: "second thoughts", modifiedAt: at(5) };
    records.push(mark("d", 2, edited));
    expect(bookmarksOf(records, BOOK, [], NOW)).toEqual([edited]);

    records.push(del("d", 3, 6, a.id));
    expect(bookmarksOf(records, BOOK, [], NOW)).toEqual([]);

    // Added again at the same place later: back, with the new note.
    const again = bm(60_000, "once more", 9);
    records.push(mark("d", 4, again));
    expect(bookmarksOf(records, BOOK, [], NOW)).toEqual([again]);
  });

  it("two devices: the union, the later edit wins, and only bookmarks of this book", () => {
    const fromDesktop = bm(10_000, "desktop", 1);
    const fromLaptop = bm(20_000, "laptop", 2);
    const records: LogRecord[] = [
      mark("desktop", 1, fromDesktop),
      mark("laptop", 1, fromLaptop),
      mark("laptop", 2, { ...fromDesktop, note: "laptop edit", modifiedAt: at(4) }),
      mark("desktop", 2, { ...fromDesktop, note: "desktop edit", modifiedAt: at(3) }),
      { ...mark("other", 1, bm(30_000)), book: { ids: [ribbonClaim("b2")] } },
      { ...mark("other", 2, bm(40_000, "a highlight")), motivation: "highlighting" },
    ];
    const list = bookmarksOf(records, BOOK, [], NOW);
    expect(list.map((b) => [b.offsetMs, b.note])).toEqual([
      [10_000, "laptop edit"],
      [20_000, "laptop"],
    ]);
  });

  it("finds a mark another app wrote under another claim for the book", () => {
    const fromApp = { ...mark("phone-app", 1, bm(5_000, "from the phone")), id: "urn:uuid:7a2b0000-0000-4000-8000-000000000000", book: { ids: ["urn:asin:B00X"] } };
    expect(bookmarksOf([fromApp], BOOK, [], NOW).map((b) => b.note)).toEqual(["from the phone"]);
  });

  it("reads the CSV of earlier versions, and a mark of the same bookmark is the same bookmark", async () => {
    const csv = `book_id,offset_ms,created_at,note,clip\nb1,70000,${at(0)},old note,clips/b1-70000.opus\nb1,80000,${at(0)},untouched,\n`;
    const { bookmarks: rows } = await parseBookmarks(new TextEncoder().encode(csv));
    expect(bookmarksOf([], BOOK, rows, NOW).map((b) => [b.offsetMs, b.note, b.clip])).toEqual([
      [70_000, "old note", "clips/b1-70000.opus"],
      [80_000, "untouched", ""],
    ]);
    // A note edited in Ribbon 0.5 wins over the row, and keeps the row's clip.
    const edited = mark("d", 1, { ...rows[0]!, clip: "", note: "new note", modifiedAt: at(5) });
    const list = bookmarksOf([edited], BOOK, rows, NOW);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: markId("b1", 70_000), note: "new note", clip: "clips/b1-70000.opus" });
    // A row deleted here stays deleted, even when a racing write puts it back in the CSV.
    expect(bookmarksOf([del("d", 2, 6, markId("b1", 80_000))], BOOK, rows, NOW).map((b) => b.offsetMs)).toEqual([70_000]);
  });

  it("a delete on one device removes the mark on the other, whatever the other's CSV still says", () => {
    const shared = bm(50_000, "shared", 1);
    const desktopLog: LogRecord[] = [mark("desktop", 1, shared)];
    const laptopLog: LogRecord[] = [del("laptop", 1, 2, shared.id)];
    // The laptop's view of the folder is the desktop's log, its own, and a CSV not rewritten yet.
    expect(bookmarksOf([...desktopLog, ...laptopLog], BOOK, [shared], NOW)).toEqual([]);
    expect(bookmarksOf([...laptopLog, ...desktopLog], BOOK, [shared], NOW)).toEqual([]);
  });
});

const WORDS: HighlightText = {
  ids: ["urn:ribbon:b1-text", "urn:isbn:9781836093152"],
  start: { href: "OEBPS/c3.xhtml", type: "application/xhtml+xml", locations: { progression: 0.412, totalProgression: 0.061 }, text: { before: "the waygate hung. ", highlight: "It was a giant circle of wraithbone" } },
  end: { href: "OEBPS/c3.xhtml", type: "application/xhtml+xml", locations: { progression: 0.4123, totalProgression: 0.0611 }, text: { before: "circle of wraithbone", highlight: ", and at fully" } },
  quote: "It was a giant circle of wraithbone",
};

function hl(offsetMs: number | null, min = 0, text: HighlightText = WORDS): Highlight {
  return { id: highlightId("b1", text.start, text.quote), bookId: "b1", offsetMs, createdAt: at(min), note: "", clip: "", text };
}

describe("bookmarks made from highlights", () => {
  it("ids are stable per book and words, and never a bookmark by time's", () => {
    const id = highlightId("b1", WORDS.start, WORDS.quote);
    expect(id).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(highlightId("b1", { ...WORDS.start }, WORDS.quote)).toBe(id);
    expect(highlightId("b1", WORDS.start, "It was a giant")).not.toBe(id);
    expect(highlightId("b2", WORDS.start, WORDS.quote)).not.toBe(id);
  });

  it("a mark keeps the words in the text beside the time, which earlier versions read as a bookmark", () => {
    const written = mark("d", 1, hl(15_834_000) as Bookmark);
    const [back] = parseLog(encodeRecord(written)).records as MarkRecord[];
    expect(back).toMatchObject({ motivation: "bookmarking", target: { ms: 15_834_000, selector: { value: "t=15804,15834" }, text: WORDS } });
    // What Ribbon 0.9 reads of it: a bookmark at that time.
    expect(bookmarksOf([back!], BOOK, [], NOW).map((b) => [b.offsetMs, b.text?.quote])).toEqual([[15_834_000, WORDS.quote]]);
  });

  it("in a book with no audio, the mark has no time: only the reader's list has it", () => {
    const written = mark("d", 1, hl(null) as unknown as Bookmark);
    expect(written.target).toEqual({ text: WORDS });
    const [back] = parseLog(encodeRecord(written)).records;
    expect(bookmarksOf([back!], BOOK, [], NOW)).toEqual([]);
    expect(highlightsOf([back!], BOOK, NOW)).toEqual([hl(null)]);
  });

  it("lists highlights in the order of the book, apart from bookmarks by time, and deletes them", () => {
    const later = { ...WORDS, start: { ...WORDS.start, locations: { progression: 0.9, totalProgression: 0.5 } }, quote: "later words" };
    const a = hl(null, 1, later);
    const b = hl(60_000, 2);
    const records: LogRecord[] = [mark("d", 1, a as unknown as Bookmark), mark("d", 2, b as Bookmark), mark("d", 3, bm(30_000, "by time"))];
    expect(highlightsOf(records, BOOK, NOW).map((h) => h.text.quote)).toEqual([WORDS.quote, "later words"]);
    expect(bookmarksOf(records, BOOK, [], NOW).map((x) => [x.offsetMs, !!x.text])).toEqual([
      [30_000, false],
      [60_000, true],
    ]);
    records.push(del("d", 4, 5, a.id));
    expect(highlightsOf(records, BOOK, NOW).map((h) => h.id)).toEqual([b.id]);
  });

  it("skips a text target that is not whole", () => {
    expect(highlightText({ ...WORDS, end: undefined })).toBeNull();
    expect(highlightText({ ...WORDS, quote: 3 })).toBeNull();
    expect(highlightText("words")).toBeNull();
    const broken = { ...mark("d", 1, bm(0)), target: { text: { quote: "x" } } };
    expect(highlightsOf([broken], BOOK, NOW)).toEqual([]);
    expect(bookmarksOf([broken], BOOK, [], NOW)).toEqual([]);
  });

  it("keeps highlights out of the CSV, where their ids would come back as other bookmarks", async () => {
    const bytes = await serializeBookmarks([bm(10_000, "by time"), { ...(hl(20_000) as Bookmark) }]);
    const { bookmarks } = await parseBookmarks(bytes);
    expect(bookmarks.map((b) => b.offsetMs)).toEqual([10_000]);
  });
});
