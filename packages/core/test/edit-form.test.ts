import { describe, expect, it } from "vitest";
import { editForm, formFields, shapeEmpties, type FieldSpec } from "@ribbon/core/edit-form";

const specs = (groups: { fields: FieldSpec[] }[]) => Object.fromEntries(groups.flatMap((g) => g.fields.map((f) => [f.field, f])));

/** The comic's form, and a text's translators (docs/BOOK-DETAILS.md, section 5). */
describe("a comic's form", () => {
  it("asks what the comic is, then its series, its number and its title", () => {
    const [first] = editForm("comic");
    expect(first!.label).toBe("The comic");
    expect(first!.shape).toEqual({
      label: "It is",
      answers: [
        { shape: "issue", label: "An issue" },
        { shape: "collection", label: "A collection" },
        { shape: "alone", label: "On its own" },
      ],
    });
    expect(first!.fields.map((f) => [f.field, f.shape ?? null])).toEqual([
      ["series", null],
      ["issue", "issue"],
      ["volume", "collection"],
      ["collects", "collection"],
      ["title", null],
    ]);
    expect(first!.fields.find((f) => f.field === "title")!.hint).toBe("The story’s own name, if it has one. The shelf adds the series and the number.");
  });

  it("asks for the people who made it by role, and for a byline from before only while it is there", () => {
    const people = editForm("comic").find((g) => g.label === "People")!;
    expect(people.fields.map((f) => [f.field, f.label])).toEqual([
      ["writers", "Writers"],
      ["pencils", "Art"],
      ["inks", "Inks"],
      ["colours", "Colours"],
      ["letters", "Letters"],
      ["coverArtists", "Cover"],
      ["author", "By"],
    ]);
    expect(people.hint).toBe("Separate several with a semicolon.");
    expect(people.fields.filter((f) => f.whileEdited).map((f) => f.field)).toEqual(["author"]);
    expect(specs([people]).inks!.hint).toBe("Leave it empty when the artist inked their own pages.");
  });

  it("asks when by its cover date, and the rest under More, with which way it reads", () => {
    const groups = editForm("comic");
    expect(groups.map((g) => g.label)).toEqual(["The comic", "People", "When", "More", "Reading"]);
    expect(groups[2]!.fields.map((f) => f.field)).toEqual(["coverDate"]);
    expect(groups[3]!.fields.map((f) => f.field)).toEqual(["publisher", "imprint", "storyArcs", "language", "genres", "isbn", "editors", "translators", "onSale", "description"]);
    expect(groups[4]!.fields.map((f) => f.field)).toEqual(["rightToLeft"]);
  });

  it("never asks a comic for what isn't its own: a subtitle, a number in the series, a year, a narrator", () => {
    const fields = formFields("comic");
    for (const field of ["subtitle", "seriesIndex", "year", "narrator", "asin"] as const) expect(fields).not.toContain(field);
  });

  it("asks a PDF the same, as the book", () => {
    const pdf = editForm("comic", "Magazines/White Dwarf 503.pdf");
    expect(pdf[0]!.label).toBe("The book");
    expect(pdf.flatMap((g) => g.fields.map((f) => f.field))).toEqual(formFields("comic"));
    expect(editForm("comic", "Saga 014.cbz")[0]!.label).toBe("The comic");
  });

  it("empties what no longer fits when the comic is made something else", () => {
    expect(shapeEmpties("collection")).toEqual(["issue"]);
    expect(shapeEmpties("issue")).toEqual(["volume", "collects"]);
    expect(shapeEmpties("alone")).toEqual(["issue", "volume", "collects"]);
  });
});

describe("a text's form", () => {
  it("asks for its translators beside its author", () => {
    const people = editForm("text").find((g) => g.label === "People")!;
    expect(people.fields.map((f) => [f.field, f.label])).toEqual([
      ["author", "Author"],
      ["translators", "Translators"],
    ]);
    expect(formFields("audiobook")).not.toContain("translators");
  });
});
