import { describe, expect, it } from "vitest";
import type { Host } from "@ribbon/core/host";
import { CBR_REFUSALS } from "@ribbon/core/comic/cbr";
import { ARCHIVE_LIMITS, type ArchiveEntry } from "@ribbon/core/comic/pages";
import { comicPages } from "../src/app/comic";

/**
 * Opening a CBR in the app (docs/COMICS.md, section 13). The archive is
 * read in Rust (src-tauri/src/comic_rar.rs, with its own tests over real
 * RARs); what is decided here is what the reader is told: its pages in
 * order, or why not, in a sentence.
 */
describe("opening a CBR", () => {
  /** A host whose archive lists these entries, or refuses as the Rust side does: with the sentence alone. */
  const hostOf = (answer: ArchiveEntry[] | string) => ({ comicEntries: async () => (typeof answer === "string" ? Promise.reject(answer) : answer) }) as unknown as Host;
  const file = "/lib/Saga 001.cbr";

  it("gives its pages in reading order, as a CBZ's are", async () => {
    const entries = [{ name: "scans/page-10.jpg", size: 1_200_000, packed: 1_190_000 }, { name: "ComicInfo.xml", size: 90, packed: 80 }, { name: "scans/page-2.jpg", size: 1_100_000, packed: 1_090_000 }];
    expect(await comicPages(hostOf(entries), file)).toEqual({ ok: true, pages: ["scans/page-2.jpg", "scans/page-10.jpg"] });
  });

  it("says a locked or a split one is that, not that the file is no comic", async () => {
    expect(await comicPages(hostOf(CBR_REFUSALS.locked), file)).toEqual({ ok: false, message: `This comic can't be opened. ${CBR_REFUSALS.locked}` });
    expect(await comicPages(hostOf(CBR_REFUSALS.split), file)).toEqual({ ok: false, message: `This comic can't be opened. ${CBR_REFUSALS.split}` });
    const neither = await comicPages(hostOf("invalid Zip archive"), file);
    expect(neither).toMatchObject({ ok: false });
    expect((neither as { message: string }).message).toMatch(/a CBZ is a zip of pictures, a CBR a RAR of them, and this is neither/);
  });

  it("holds a RAR to the limits a zip is held to, from the sizes its list gives", async () => {
    // A megabyte in the archive that says it unpacks to a gigabyte: a bomb, in either kind of archive.
    const bomb = await comicPages(hostOf([{ name: "001.jpg", size: 1024 ** 3, packed: 1024 ** 2 }]), file);
    expect(bomb).toMatchObject({ ok: false });
    const huge = await comicPages(hostOf([{ name: "001.jpg", size: ARCHIVE_LIMITS.pageBytes + 1, packed: ARCHIVE_LIMITS.pageBytes }]), file);
    expect((huge as { message: string }).message).toMatch(/more than a page could be/);
  });
});
