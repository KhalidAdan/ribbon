import { describe, expect, it } from "vitest";
import { editForm } from "@ribbon/core/edit-form";
import { asksOf, formAsShape, formToSave, shapeOf, showsField, type FormValues } from "../src/ui/book-form";

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
