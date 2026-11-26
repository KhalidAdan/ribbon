import type { ComicShape } from "./comic-name";
import type { EditField } from "./edits";
import { pagesKind, type BookKind } from "./kind";

/**
 * What the edit form asks about a book, by the kind of book it is
 * (docs/BOOK-DETAILS.md, section 5). Every book keeps its details the
 * same way (edits.ts); what changes is which of them mean anything, and
 * what they are called. An audiobook is asked what it always was. A text
 * that is only read has no narrator, Audible has no number for it, and it
 * may have translators.
 *
 * A comic has details of its own. The form asks first what it is: an
 * issue, with an issue number; a collection, with a volume and the issues
 * it collects; or a comic on its own. That isn't kept: the fields say it
 * (comic-name.ts, `comicShape`), and moving from one to another empties
 * what no longer fits (`shapeEmpties`). Its title is the story's own name,
 * the people who made it are asked for by role, and its cover date stands
 * for its year. It reads right to left or not, a switch. A PDF is read in
 * the same reader as a comic, and is asked the same, as "The book".
 *
 * A field the form leaves out is never changed by it: what a comic's
 * files say for a field it doesn't show stays as it is.
 */

/** A field of the form: every edit but the cover, which is a picture, and read-along, a switch shown by what the book has (EditBook.tsx). */
export type FormField = Exclude<EditField, "cover" | "readAlong">;

export interface FieldSpec {
  field: FormField;
  label: string;
  hint?: string;
  multiline?: boolean;
  inputMode?: "numeric" | "decimal";
  /** Across both columns of the form. */
  wide?: boolean;
  /** A switch, on or off, rather than text, with what it means each way: its edit is "yes" or "no" (edits.ts, `SWITCH_ON`). */
  switch?: { on: string; off: string };
  /** Shown only for a comic that is this: an issue's number for an issue, a volume and the issues it collects for a collection. */
  shape?: ComicShape;
  /** Shown only while the book has an edit of this field: a comic's byline kept from before its people had fields of their own (comic-edits.ts). */
  whileEdited?: boolean;
}

/** The question a comic's form asks first, what it is, with an answer for each shape. */
export interface ShapeQuestion {
  label: string;
  answers: { shape: ComicShape; label: string }[];
}

export interface FieldGroup {
  label: string;
  fields: FieldSpec[];
  /** Said once for the group, rather than under each of its fields. */
  hint?: string;
  /** Asked before the group's fields: what the comic is. */
  shape?: ShapeQuestion;
}

const SEVERAL = "Separate several with a semicolon.";

const MORE: FieldSpec[] = [
  { field: "year", label: "Year", inputMode: "numeric" },
  { field: "language", label: "Language" },
  { field: "genres", label: "Genres", hint: "Separate with commas.", wide: true },
  { field: "publisher", label: "Publisher" },
  { field: "isbn", label: "ISBN" },
];

const DESCRIPTION: FieldSpec = { field: "description", label: "Description", multiline: true, wide: true };

const SERIES: FieldGroup = {
  label: "Series",
  fields: [
    { field: "series", label: "Series" },
    { field: "seriesIndex", label: "Number in the series", inputMode: "decimal", hint: "Decimals are fine: 2.5 sits between 2 and 3." },
  ],
};

const TITLES: FieldSpec[] = [
  { field: "title", label: "Title", wide: true },
  { field: "subtitle", label: "Subtitle", wide: true },
];

/** A comic's form; a PDF's is the same, its first group called "The book". */
function comicForm(firstGroup: string): FieldGroup[] {
  return [
    {
      label: firstGroup,
      shape: {
        label: "It is",
        answers: [
          { shape: "issue", label: "An issue" },
          { shape: "collection", label: "A collection" },
          { shape: "alone", label: "On its own" },
        ],
      },
      fields: [
        { field: "series", label: "Series", wide: true },
        { field: "issue", label: "Issue", shape: "issue" },
        { field: "volume", label: "Volume", shape: "collection" },
        { field: "collects", label: "Collects", shape: "collection", hint: "The issues it holds: 1–6, Annual 1." },
        { field: "title", label: "Title", hint: "The story’s own name, if it has one. The shelf adds the series and the number.", wide: true },
      ],
    },
    {
      label: "People",
      hint: SEVERAL,
      fields: [
        { field: "writers", label: "Writers" },
        { field: "pencils", label: "Art" },
        { field: "inks", label: "Inks", hint: "Leave it empty when the artist inked their own pages." },
        { field: "colours", label: "Colours" },
        { field: "letters", label: "Letters" },
        { field: "coverArtists", label: "Cover" },
        { field: "author", label: "By", whileEdited: true, wide: true, hint: "Kept from before writers and artists had fields of their own. Take it back to show the credits." },
      ],
    },
    { label: "When", fields: [{ field: "coverDate", label: "Cover date", hint: "A month and a year, or a year: 2024-07, or 2024." }] },
    {
      label: "More",
      fields: [
        { field: "publisher", label: "Publisher" },
        { field: "imprint", label: "Imprint" },
        { field: "storyArcs", label: "Story arcs", hint: SEVERAL, wide: true },
        { field: "language", label: "Language" },
        { field: "genres", label: "Genres", hint: "Separate with commas." },
        { field: "isbn", label: "ISBN", hint: "A collection’s." },
        { field: "editors", label: "Editors", hint: SEVERAL },
        { field: "translators", label: "Translators", hint: SEVERAL },
        { field: "onSale", label: "Day on sale", hint: "2024-07-10." },
        DESCRIPTION,
      ],
    },
    {
      label: "Reading",
      fields: [
        {
          field: "rightToLeft",
          label: "Reads right to left",
          wide: true,
          switch: {
            on: "Its pages turn from right to left on every device, as manga’s do.",
            off: "Its pages turn from left to right. Turn this on for a comic read from the right, as manga is.",
          },
        },
      ],
    },
  ];
}

const FORMS: Record<BookKind, FieldGroup[]> = {
  audiobook: [
    { label: "The book", fields: TITLES },
    {
      label: "People",
      fields: [
        { field: "author", label: "Author", hint: SEVERAL },
        { field: "narrator", label: "Narrator", hint: SEVERAL },
      ],
    },
    SERIES,
    { label: "More", fields: [...MORE, { field: "asin", label: "ASIN" }, DESCRIPTION] },
  ],
  text: [
    { label: "The book", fields: TITLES },
    {
      label: "People",
      fields: [
        { field: "author", label: "Author", hint: SEVERAL },
        { field: "translators", label: "Translators", hint: SEVERAL },
      ],
    },
    SERIES,
    { label: "More", fields: [...MORE, DESCRIPTION] },
  ],
  comic: comicForm("The comic"),
};

const PDF_FORM = comicForm("The book");

/**
 * The form's groups of fields for a kind of book, in the order they are
 * shown. `file` is a book of pages' file: a PDF, which may be a comic or a
 * magazine or anything, is asked the comic's questions as "The book".
 */
export function editForm(kind: BookKind, file = ""): FieldGroup[] {
  return kind === "comic" && pagesKind(file) === "PDF" ? PDF_FORM : FORMS[kind];
}

/** Every field the form shows for a kind of book. */
export function formFields(kind: BookKind): FormField[] {
  return FORMS[kind].flatMap((g) => g.fields.map((f) => f.field));
}

/**
 * What a comic's form empties when it is made this shape: the fields of the
 * other shapes, as edits to nothing, so what its file says for them doesn't
 * come back. An issue made a collection has its issue number emptied; a
 * collection made an issue, its volume and the issues it collects.
 */
export function shapeEmpties(shape: ComicShape): FormField[] {
  return FORMS.comic.flatMap((g) => g.fields.filter((f) => f.shape !== undefined && f.shape !== shape).map((f) => f.field));
}

/** What the form says of itself, under its title. */
export function editFormAbout(kind: BookKind): string {
  const files = kind === "audiobook" ? "the audio files are" : kind === "comic" ? "the comic’s file is" : "the book’s file is";
  return `Correct what the files got wrong. Your changes are kept beside the book; ${files} never touched.`;
}
