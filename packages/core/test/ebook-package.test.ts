import { describe, expect, it } from "vitest";
import { bytesToEbooks, ebooksCsvIsCurrent, ebooksToBytes, packageFromTags } from "@ribbon/core/scan/ebooks";

/** An EPUB's package metadata as the Rust scanner hands it over (`opf`): Calibre's EPUB 2, with made-up names. */
const CALIBRE = `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Lantern Road</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Writer, Ann">Ann Writer</dc:creator>
    <dc:creator opf:role="trl">Tom Turner</dc:creator>
    <dc:contributor opf:role="bkp">calibre (5.0.0) [https://calibre-ebook.com]</dc:contributor>
    <dc:subject>Fantasy</dc:subject>
    <dc:subject>Adventure</dc:subject>
    <meta name="calibre:series" content="Made Up Saga"/>
    <meta name="calibre:series_index" content="2"/>
  </metadata>`;

const file = { path: "Ebooks/Lantern.epub", sizeBytes: 100, mtimeMs: 200 };

describe("an EPUB's own series, genres and translators (docs/BOOK-DETAILS.md, section 2, \"A text\")", () => {
  it("reads them from the package's metadata, by the reader a metadata.opf goes through", () => {
    const p = packageFromTags(file, { title: "The Lantern Road", author: "Ann Writer", opf: CALIBRE }, true);
    expect(p).toMatchObject({ title: "The Lantern Road", authors: ["Ann Writer"], series: "Made Up Saga", seriesIndex: 2, subjects: ["Fantasy", "Adventure"], translators: ["Tom Turner"], hasCover: true });
  });

  it("reads none from a package that says none, or from a scanner that hands no metadata over", () => {
    expect(packageFromTags(file, { title: "Alone", opf: "<metadata><dc:title>Alone</dc:title></metadata>" }, false)).toMatchObject({ series: "", seriesIndex: null, subjects: [], translators: [] });
    expect(packageFromTags(file, { title: "Alone" }, false)).toMatchObject({ title: "Alone", series: "", seriesIndex: null, subjects: [], translators: [] });
  });

  it("keeps no place in a series that isn't named", () => {
    // Some tools write calibre:series_index on every book; with no series it would make the book look like a numbered folder's.
    const p = packageFromTags(file, { opf: `<metadata><meta name="calibre:series_index" content="1.0"/></metadata>` }, false);
    expect(p).toMatchObject({ series: "", seriesIndex: null });
  });

  it("keeps them in ebooks.csv, and knows an ebooks.csv from before them", async () => {
    const p = packageFromTags(file, { title: "The Lantern Road", author: "Ann Writer", opf: CALIBRE }, true);
    const bytes = await ebooksToBytes([p]);
    expect(ebooksCsvIsCurrent(bytes)).toBe(true);
    expect((await bytesToEbooks(bytes)).get(file.path)).toEqual(p);

    // Written by Ribbon 0.50.0: read as it was, with none of the new details, and known to be from before.
    const old = new TextEncoder().encode("path,size_bytes,mtime_ms,title,authors,isbn,language,publisher,date,description,has_cover\nEbooks/Lantern.epub,100,200,The Lantern Road,Ann Writer,,en,,,,1\n");
    expect(ebooksCsvIsCurrent(old)).toBe(false);
    expect((await bytesToEbooks(old)).get(file.path)).toEqual({ ...file, title: "The Lantern Road", authors: ["Ann Writer"], isbns: [], language: "en", publisher: "", date: "", description: "", hasCover: true, series: "", seriesIndex: null, subjects: [], translators: [] });
  });
});
