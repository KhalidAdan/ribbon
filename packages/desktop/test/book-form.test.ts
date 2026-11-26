import { describe, expect, it } from "vitest";
import { editForm } from "@ribbon/core/edit-form";
import { EDIT_FIELDS } from "@ribbon/core/edits";
import { asksOf, comparedFields, differs, formAsShape, formFor, formRebased, formToSave, lookUpStart, shapeOf, showsField, type FormValues } from "../src/ui/book-form";
import { EDIT_FIELDS_BEFORE } from "../src/app/server/shelf";

/**
 * What the edit form shows and sends (ui/book-form.ts): a comic asked
 * what it is, its numbers by that, and its By only while there is a byline
 * kept from before to take back (docs/BOOK-DETAILS.md, section 5).
 */
const comic = editForm("comic", "Saga 014.cbz");
const shown = (form: FormValues, edits = {}) => {
  const asks = asksOf("comic", form, edits);
  return comic.flatMap((g) => g.fields.filter((f) => showsField(f, asks)).map((f) => f.field));
};

describe("a comic's form, by what it is", () => {
  it("is what its numbers make it as it opens, an issue number first", () => {
    expect(shapeOf({ issue: "14" })).toBe("issue");
    expect(shapeOf({ issue: "14", volume: "2" })).toBe("issue");
    expect(shapeOf({ volume: "2" })).toBe("collection");
    expect(shapeOf({ collects: "1–6" })).toBe("collection");
    expect(shapeOf({ issue: " ", volume: "" })).toBe("alone");
    expect(asksOf("comic", { volume: "1" }, undefined)).toEqual({ shape: "collection", bylineKept: false });
    // Another kind of book is asked nothing of the sort.
    expect(asksOf("audiobook", { issue: "14" }, { author: "Someone" })).toEqual({ shape: null, bylineKept: false });
  });

  it("asks an issue for its issue number, a collection for its volume and the issues it holds, and a comic on its own for neither", () => {
    expect(shown({ issue: "14" })).toContain("issue");
    expect(shown({ issue: "14" })).not.toContain("volume");
    expect(shown({ volume: "1" })).toEqual(expect.arrayContaining(["volume", "collects"]));
    expect(shown({ volume: "1" })).not.toContain("issue");
    const alone = shown({});
    for (const f of ["issue", "volume", "collects"] as const) expect(alone).not.toContain(f);
    // What every comic is asked, whatever it is.
    expect(alone).toEqual(expect.arrayContaining(["series", "title", "writers", "pencils", "coverDate", "storyArcs", "rightToLeft"]));
  });

  it("asks for a PDF the same, as the book", () => {
    expect(editForm("comic", "White Dwarf 503.pdf")[0]!.label).toBe("The book");
    expect(editForm("comic", "White Dwarf 503.pdf").map((g) => g.fields.map((f) => f.field))).toEqual(comic.map((g) => g.fields.map((f) => f.field)));
  });

  it("shows By only while a byline kept from before is there", () => {
    expect(shown({ issue: "14" })).not.toContain("author");
    expect(shown({ issue: "14" }, { author: "Ada Quill; Ben Nib" })).toContain("author");
  });

  it("empties the numbers that no longer fit when it is said to be something else, and gives back the ones that do", () => {
    const before = { issue: "14", volume: "", collects: "", title: "Chapter Fourteen" };
    const collection = formAsShape(before, "collection", comic, before);
    expect(collection).toMatchObject({ issue: "", volume: "", collects: "", title: "Chapter Fourteen" });
    // A slip of the hand: back to an issue, its number as it was.
    expect(formAsShape({ ...collection, volume: "2" }, "issue", comic, before)).toMatchObject({ issue: "14", volume: "", collects: "" });
    // On its own: no number of any kind.
    expect(formAsShape({ volume: "1", collects: "1–6" }, "alone", comic, { volume: "1", collects: "1–6" })).toMatchObject({ issue: "", volume: "", collects: "" });
  });
});

describe("what a comic's form sends", () => {
  const files: FormValues = { series: "Saga", issue: "14", title: "Chapter Fourteen", author: "Ada Quill; Ben Nib", year: "2013", seriesIndex: "14", writers: "Ada Quill", pencils: "Ben Nib" };

  it("sends what it shows, and never the name, byline, place or year the shelf makes from it", () => {
    const form = { ...files, writers: "Ada Quill; Cy Ink" };
    const sent = formToSave(form, comic, asksOf("comic", form, undefined), files);
    expect(sent).toMatchObject({ series: "Saga", issue: "14", title: "Chapter Fourteen", writers: "Ada Quill; Cy Ink", pencils: "Ben Nib" });
    for (const f of ["author", "year", "seriesIndex", "subtitle", "narrator", "asin"] as const) expect(sent).not.toHaveProperty(f);
  });

  it("sends the numbers emptied by a change of what it is, so the file's issue number doesn't come back to a collection", () => {
    const form = { ...formAsShape(files, "collection", comic, files), volume: "1" };
    expect(formToSave(form, comic, { shape: "collection", bylineKept: false }, files)).toMatchObject({ issue: "", volume: "1", collects: "" });
  });

  it("sends a byline kept from before as it stands, and taken back (emptied) as the files have it, so it stops being an edit", () => {
    const kept = { ...files, author: "Daniel Warren Johnson; Jorge Corona" };
    expect(formToSave(kept, comic, { shape: "issue", bylineKept: true }, files).author).toBe("Daniel Warren Johnson; Jorge Corona");
    expect(formToSave({ ...kept, author: " " }, comic, { shape: "issue", bylineKept: true }, files).author).toBe("Ada Quill; Ben Nib");
  });

  it("sends a text's translators, beside its author", () => {
    const text = editForm("text");
    const form = { title: "The Book", author: "Ada Quill", translators: "Ida Word" };
    expect(formToSave(form, text, asksOf("text", form, undefined), {})).toMatchObject({ author: "Ada Quill", translators: "Ida Word" });
  });
});

/**
 * A comic on a server from before comics had details of their own
 * (docs/BOOK-DETAILS.md, section 4): such a server says nothing of what
 * its edits take, and refuses a field it doesn't know, so the form is
 * 0.51.0's and asks only what it takes.
 */
describe("the form on a server from before comics had details of their own", () => {
  const before = new Set<string>(EDIT_FIELDS_BEFORE);
  const fieldsOf = (groups: ReturnType<typeof formFor>) => groups.flatMap((g) => g.fields.map((f) => f.field));

  it("asks a comic what 0.51.0 asked: its whole name, its people as one line, its series and number", () => {
    const groups = formFor("comic", "Saga 014.cbz", before);
    expect(groups.map((g) => g.label)).toEqual(["The comic", "People", "Series", "Reading", "More"]);
    expect(fieldsOf(groups)).toEqual(["title", "subtitle", "author", "series", "seriesIndex", "rightToLeft", "year", "language", "genres", "publisher", "isbn", "description"]);
    expect(groups.some((g) => g.shape)).toBe(false);
    expect(groups[2]!.fields[1]!.label).toBe("Issue or volume number");
  });

  it("sends only what that form shows: never an issue, a volume or the issues collected, whatever the comic is", () => {
    const groups = formFor("comic", "Saga 014.cbz", before);
    const form = { title: "Saga #14", subtitle: "", author: "Ada Quill", series: "Saga", seriesIndex: "14", issue: "14", volume: "", collects: "" };
    const sent = formToSave(form, groups, asksOf("comic", form, undefined), {});
    expect(Object.keys(sent).filter((f) => !before.has(f))).toEqual([]);
    expect(sent).toMatchObject({ title: "Saga #14", author: "Ada Quill", seriesIndex: "14" });
  });

  it("leaves out of any book's form what the server doesn't take: a text's translators", () => {
    expect(fieldsOf(formFor("text", "", before))).not.toContain("translators");
    expect(fieldsOf(formFor("audiobook", "", before))).toEqual(fieldsOf(editForm("audiobook")));
  });

  it("is the comic's own form on a server that says it takes a comic's details, and in a folder", () => {
    const all = new Set<string>(EDIT_FIELDS.filter((f) => f !== "cover"));
    expect(formFor("comic", "Saga 014.cbz", all)).toEqual(editForm("comic", "Saga 014.cbz"));
    expect(formFor("comic", "Saga 014.cbz", null)).toBe(editForm("comic", "Saga 014.cbz"));
    expect(formFor("comic", "Old Tales.pdf", null)[0]!.label).toBe("The book");
  });
});

/** The edit form's ComicVine group and its look-up (docs/BOOK-DETAILS.md, sections 5 and 7). */
describe("ComicVine in a comic's form", () => {
  const form: FormValues = { series: "Made Up Saga (2018)", issue: "2", volume: "", collects: "", title: "", writers: "Ada Quill", pencils: "", publisher: "Made Up Press", description: "" };

  it("starts a look-up from the comic's own page there, else its file's, and its series as a search with the run's year apart", () => {
    expect(lookUpStart({ comicvine: "4000-123456" }, null, form, "issue")).toEqual({ address: "https://comicvine.gamespot.com/issue/4000-123456/", name: "Made Up Saga", year: "2018", number: "2" });
    const matched = { address: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/" };
    expect(lookUpStart({ comicvine: "4000-123456" }, matched, form, "issue").address).toBe(matched.address);
    // A collection's number on ComicVine is its volume.
    expect(lookUpStart({}, null, { ...form, series: "Made Up Saga", issue: "", volume: "1" }, "collection")).toEqual({ address: "", name: "Made Up Saga", year: "", number: "1" });
  });

  it("sets each field ComicVine says something of beside the comic's, in the form's order, and a field it empties only where the comic has one", () => {
    const values = { series: "Made Up Saga (2018)", issue: "2", volume: "", collects: "", title: "The Long Way Home", writers: "Ada Quill", pencils: "Ben Nib", publisher: "Made Up Press", description: "Ada and Ben take the long way home." };
    const rows = comparedFields(editForm("comic", "x.cbz"), form, values);
    expect(rows.map((r) => [r.field, r.same])).toEqual([
      ["series", true],
      ["issue", true],
      ["title", false],
      ["writers", true],
      ["pencils", false],
      ["publisher", true],
      ["description", false],
    ]);
    expect(rows.find((r) => r.field === "pencils")).toMatchObject({ label: "Art", here: "", there: "Ben Nib" });
    // A collection read as an issue: its volume is emptied, and that shows.
    expect(comparedFields(editForm("comic", "x.cbz"), { ...form, volume: "1" }, { volume: "" }).map((r) => r.field)).toEqual(["volume"]);
  });

  it("keeps what a person typed when the comic changes under the open form, and shows the rest as it is now", () => {
    const before: FormValues = { title: "", writers: "Ada Quill", publisher: "Made Up Press" };
    const typed = { ...before, writers: "Ada Quill; Cy Ink" };
    const now = { title: "The Long Way Home", writers: "Ada Quill", publisher: "Made Up Press" };
    expect(formRebased(typed, before, now)).toEqual({ title: "The Long Way Home", writers: "Ada Quill; Cy Ink", publisher: "Made Up Press" });
  });

  it("says a field differs only by what it says, not by spaces at its ends or how its lines end", () => {
    expect(differs(" Ada Quill ", "Ada Quill")).toBe(false);
    expect(differs("One\r\nTwo", "One\nTwo")).toBe(false);
    expect(differs("Ada", "Ben")).toBe(true);
  });
});
