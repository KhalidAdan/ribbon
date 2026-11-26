import { describe, expect, it } from "vitest";
import { bytesToMatch, matchToBytes, type MatchRecord } from "../src/matched";
import { bytesToEdits } from "../src/edits";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (s: string) => new TextEncoder().encode(s);

/** A comic's ComicVine record beside the books, `.ribbon/matched/<id>.csv` (docs/BOOK-DETAILS.md, sections 4 and 7). */
describe("a comic's ComicVine record", () => {
  const matched: MatchRecord = {
    bookId: "b1",
    askedAt: "2026-11-25T10:00:00.000Z",
    match: {
      address: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/",
      as: "issue",
      values: { series: "Made Up Saga (2018)", issue: "2", volume: "", collects: "", title: "The Long Way Home", writers: "Ada Quill", coverArtists: "Ben Nib", coverDate: "2018-07", description: "Ada and Ben take the long way home, “at last”.\n\nNotes" },
    },
  };

  it("is kept in the edits' shape, each field by its column, with the address, how it was read and when it was asked", async () => {
    const written = text(await matchToBytes(matched));
    expect(written.split("\n")[0]).toBe("field,value,updated_at");
    expect(written).toContain("address,https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/,2026-11-25T10:00:00.000Z");
    expect(written).toContain("as,issue,2026-11-25T10:00:00.000Z");
    expect(written).toContain("cover_artists,Ben Nib,");
    expect(written).toContain("cover_date,2018-07,");
    expect(await bytesToMatch("b1", await matchToBytes(matched))).toEqual(matched);
  });

  it("is never read as anyone's edits: an older Ribbon sharing the folder keeps them apart", async () => {
    // The edits' reader, given a match by mistake, finds nothing it would lay over the book as a person's.
    const asEdits = await bytesToEdits("b1", await matchToBytes(matched));
    expect(asEdits.values).toMatchObject({ series: "Made Up Saga (2018)" });
    // Which is why it lives in its own folder (.ribbon/matched/), never in .ribbon/edits/.
    expect(asEdits.unknownRows?.map((r) => r.field)).toEqual(["address", "as"]);
  });

  it("notes a comic asked about with nothing kept, and why: not found, or forgotten", async () => {
    for (const none of ["not found", "forgotten"] as const) {
      const record: MatchRecord = { bookId: "b2", askedAt: "2026-11-25T11:00:00.000Z", match: null, none };
      expect(text(await matchToBytes(record))).toBe(`field,value,updated_at\nnone,${none},2026-11-25T11:00:00.000Z\n`);
      expect(await bytesToMatch("b2", await matchToBytes(record))).toEqual(record);
    }
  });

  it("leaves out a field it doesn't know, reads a collection as one, and is nothing when it says neither", async () => {
    const read = await bytesToMatch("b3", bytes("field,value,updated_at\naddress,https://comicvine.gamespot.com/x/4000-1/,2026-11-25T00:00:00Z\nas,collection,2026-11-25T00:00:00Z\nvolume,1,2026-11-25T00:00:00Z\nsomething_newer,x,2026-11-25T00:00:00Z\n"));
    expect(read).toEqual({ bookId: "b3", askedAt: "2026-11-25T00:00:00Z", match: { address: "https://comicvine.gamespot.com/x/4000-1/", as: "collection", values: { volume: "1" } } });
    expect(await bytesToMatch("b4", bytes("field,value,updated_at\nseries,Saga,2026-11-25T00:00:00Z\n"))).toBeNull();
  });
});
