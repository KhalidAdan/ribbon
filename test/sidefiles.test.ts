import { describe, expect, it } from "vitest";
import { folderMarks, isSideFileName, parseOpf, readSideFiles, splitList, splitPeople, xmlText } from "../src/core/scan/sidefiles";

const ABS_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Horus Rising</dc:title>
    <dc:title type="subtitle">The Seeds of Heresy Are Sown</dc:title>
    <dc:creator opf:role="aut">Dan Abnett</dc:creator>
    <dc:creator opf:role="nrt">Toby Longworth</dc:creator>
    <dc:description>&lt;p&gt;It is the 31st millennium.&lt;/p&gt;&lt;p&gt;Under the benevolent leadership&amp;nbsp;of the Emperor…&lt;/p&gt;</dc:description>
    <dc:publisher>Black Library</dc:publisher>
    <dc:language>en</dc:language>
    <dc:subject>Science Fiction; Military</dc:subject>
    <dc:identifier opf:scheme="ISBN">978-1-84416-294-2</dc:identifier>
    <dc:identifier opf:scheme="ASIN">B00CGH53PY</dc:identifier>
    <dc:date>2006-04-25</dc:date>
    <meta name="calibre:series" content="The Horus Heresy"/>
    <meta name="calibre:series_index" content="1"/>
  </metadata>
</package>`;

describe("OPF", () => {
  it("reads an Audiobookshelf-style package", () => {
    const m = parseOpf(ABS_OPF);
    expect(m.title).toBe("Horus Rising");
    expect(m.subtitle).toBe("The Seeds of Heresy Are Sown");
    expect(m.authors).toEqual(["Dan Abnett"]);
    expect(m.narrators).toEqual(["Toby Longworth"]);
    expect(m.publisher).toBe("Black Library");
    expect(m.language).toBe("en");
    expect(m.genres).toEqual(["Science Fiction", "Military"]);
    expect(m.isbn).toBe("9781844162942");
    expect(m.asin).toBe("B00CGH53PY");
    expect(m.year).toBe(2006);
    expect(m.series).toBe("The Horus Heresy");
    expect(m.seriesIndex).toBe(1);
    expect(m.description).toBe("It is the 31st millennium.\n\nUnder the benevolent leadership of the Emperor…");
  });

  it("reads EPUB 3 roles and collections", () => {
    const m = parseOpf(`<package><metadata>
      <dc:creator id="c1">Ursula K. Le Guin</dc:creator>
      <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
      <dc:contributor id="c2">Robert Inglis</dc:contributor>
      <meta refines="#c2" property="role">nrt</meta>
      <meta property="belongs-to-collection" id="s">Earthsea</meta>
      <meta refines="#s" property="group-position">2</meta>
      <dc:identifier>urn:isbn:9780547773742</dc:identifier>
    </metadata></package>`);
    expect(m.authors).toEqual(["Ursula K. Le Guin"]);
    expect(m.narrators).toEqual(["Robert Inglis"]);
    expect(m.series).toBe("Earthsea");
    expect(m.seriesIndex).toBe(2);
    expect(m.isbn).toBe("9780547773742");
  });

  it("survives junk", () => {
    expect(parseOpf("not xml at all")).toEqual({});
    expect(parseOpf("<dc:title>Unclosed")).toEqual({});
  });
});

describe("side files together", () => {
  it("desc.txt and reader.txt win over the OPF for what they say", () => {
    const m = readSideFiles([
      { name: "metadata.opf", text: ABS_OPF },
      { name: "desc.txt", text: "A plain description.\r\n" },
      { name: "reader.txt", text: "Toby Longworth & Jonathan Keeble\n" },
    ]);
    expect(m.description).toBe("A plain description.");
    expect(m.narrators).toEqual(["Toby Longworth", "Jonathan Keeble"]);
    expect(m.title).toBe("Horus Rising");
  });

  it("knows its file names", () => {
    expect(isSideFileName("metadata.opf")).toBe(true);
    expect(isSideFileName("Book.OPF")).toBe(true);
    expect(isSideFileName("desc.txt")).toBe(true);
    expect(isSideFileName("Reader.txt")).toBe(true);
    expect(isSideFileName("notes.txt")).toBe(false);
    expect(isSideFileName("cover.jpg")).toBe(false);
  });
});

describe("folder marks", () => {
  it("takes a narrator, an ASIN and a year out of the name", () => {
    expect(folderMarks("1965 - Dune {Scott Brick} [B002V1OF70]")).toEqual({ name: "Dune", narrator: "Scott Brick", asin: "B002V1OF70", year: 1965 });
  });

  it("leaves brackets that are part of the title", () => {
    expect(folderMarks("The Martian [Unabridged]")).toEqual({ name: "The Martian [Unabridged]" });
    expect(folderMarks("2001 A Space Odyssey")).toEqual({ name: "2001 A Space Odyssey" });
  });

  it("an ISBN-10 counts as the bracketed code", () => {
    expect(folderMarks("Legion [0575082348]").asin).toBe("0575082348");
  });
});

describe("people and lists", () => {
  it("splits real lists and keeps 'Last, First' whole", () => {
    expect(splitPeople("Dan Abnett; Graham McNeill")).toEqual(["Dan Abnett", "Graham McNeill"]);
    expect(splitPeople("Neil Gaiman & Terry Pratchett")).toEqual(["Neil Gaiman", "Terry Pratchett"]);
    expect(splitPeople("Douglas Preston and Lincoln Child")).toEqual(["Douglas Preston", "Lincoln Child"]);
    expect(splitPeople("Abnett, Dan")).toEqual(["Abnett, Dan"]);
    expect(splitPeople("Dan Abnett, Rob Sanders, Gav Thorpe")).toEqual(["Dan Abnett", "Rob Sanders", "Gav Thorpe"]);
    expect(splitPeople("Dan Abnett, Graham McNeill")).toEqual(["Dan Abnett", "Graham McNeill"]);
    expect(splitPeople("")).toEqual([]);
  });

  it("splits genres and drops repeats", () => {
    expect(splitList("Fantasy; Epic / fantasy, Adventure")).toEqual(["Fantasy", "Epic", "Adventure"]);
  });

  it("unescapes XML and HTML", () => {
    expect(xmlText("Tom &amp; Jerry &#8212; &#x2019;s<br/>next")).toBe("Tom & Jerry — ’s\nnext");
  });
});
