import { describe, expect, it } from "vitest";
import { editForm, editFormAbout, formFields } from "@ribbon/core/edit-form";
import { EDIT_FIELDS } from "@ribbon/core/edits";
import { bookKind } from "@ribbon/core/kind";

/** The edit form asks what the kind of book can answer (core/edit-form.ts). */
describe("the edit form, by the kind of book", () => {
  it("tells an audiobook, a text that is only read, and a comic apart", () => {
    expect(bookKind({ fileCount: 12, ebook: "book.epub" })).toBe("audiobook");
    expect(bookKind({ fileCount: 1 })).toBe("audiobook");
    expect(bookKind({ fileCount: 0, ebook: "book.epub" })).toBe("text");
    expect(bookKind({ fileCount: 0, comic: "Saga 014 (2013).cbz" })).toBe("comic");
    expect(bookKind({ fileCount: 0, comic: "White Dwarf 503.pdf" })).toBe("comic");
  });

  it("asks an audiobook for everything a book kept before comics had details of their own, but which way a comic reads", () => {
    const comics = new Set<string>(["rightToLeft", "issue", "volume", "collects", "writers", "pencils", "inks", "colours", "letters", "coverArtists", "editors", "translators", "imprint", "coverDate", "onSale", "storyArcs"]);
    const every = EDIT_FIELDS.filter((f) => f !== "cover" && f !== "readAlong" && !comics.has(f));
    expect([...formFields("audiobook")].sort()).toEqual([...every].sort());
    expect(formFields("text")).not.toContain("rightToLeft");
  });

  it("asks a comic, and so a PDF, whether it reads right to left, with a switch", () => {
    expect(formFields("comic")).toContain("rightToLeft");
    const spec = editForm("comic")
      .flatMap((g) => g.fields)
      .find((f) => f.field === "rightToLeft")!;
    expect(spec.label).toBe("Reads right to left");
    expect(spec.switch?.on).toMatch(/right to left/);
    // Only the switch is one.
    for (const kind of ["audiobook", "text", "comic"] as const) {
      expect(
        editForm(kind)
          .flatMap((g) => g.fields)
          .filter((f) => f.switch)
          .map((f) => f.field),
      ).toEqual(kind === "comic" ? ["rightToLeft"] : []);
    }
  });

  it("asks a comic for its writers and artists and its issue, and never for a narrator or an ASIN", () => {
    const fields = formFields("comic");
    expect(fields).not.toContain("narrator");
    expect(fields).not.toContain("asin");
    const labels = Object.fromEntries(editForm("comic").flatMap((g) => g.fields.map((f) => [f.field, f.label])));
    expect(labels.writers).toBe("Writers");
    expect(labels.pencils).toBe("Art");
    expect(labels.issue).toBe("Issue");
    expect(labels.volume).toBe("Volume");
    expect(editForm("comic")[0]!.label).toBe("The comic");
  });

  it("asks a text that is only read for no narrator", () => {
    expect(formFields("text")).not.toContain("narrator");
    expect(formFields("text")).toContain("isbn");
  });

  it("shows no field twice, and says whose files are left alone", () => {
    for (const kind of ["audiobook", "text", "comic"] as const) {
      const fields = formFields(kind);
      expect(new Set(fields).size).toBe(fields.length);
    }
    expect(editFormAbout("audiobook")).toContain("the audio files are never touched");
    expect(editFormAbout("comic")).toContain("the comic’s file is never touched");
  });
});
