import type { EditField } from "./edits";
import type { BookKind } from "./kind";

/**
 * What the edit form asks about a book, by the kind of book it is. Every
 * book keeps the same details the same way (edits.ts); what changes is
 * which of them mean anything, and what they are called. A comic has no
 * narrator and no ASIN, the people who made it are its writers and
 * artists, and its place in a series is an issue or a volume. A text
 * that is only read has no narrator either, and Audible has no number
 * for it.
 *
 * A field the form leaves out is never changed by it: what a comic's
 * files say for a field it doesn't show stays as it is.
 */

/** A field of the form: every edit but the cover, which is a picture, and read-along, which is a switch. */
export type FormField = Exclude<EditField, "cover" | "readAlong">;

export interface FieldSpec {
  field: FormField;
  label: string;
  hint?: string;
  multiline?: boolean;
  inputMode?: "numeric" | "decimal";
  /** Across both columns of the form. */
  wide?: boolean;
}

export interface FieldGroup {
  label: string;
  fields: FieldSpec[];
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
    { label: "People", fields: [{ field: "author", label: "Author", hint: SEVERAL, wide: true }] },
    SERIES,
    { label: "More", fields: [...MORE, DESCRIPTION] },
  ],
  comic: [
    {
      label: "The comic",
      fields: [
        { field: "title", label: "Title", hint: "Say which issue or issues it holds: “Saga #14”, or “Saga Vol. 1 (#1–#6)”.", wide: true },
        { field: "subtitle", label: "Subtitle", hint: "A story’s name, or a collection’s.", wide: true },
      ],
    },
    { label: "People", fields: [{ field: "author", label: "Writers and artists", hint: SEVERAL, wide: true }] },
    {
      label: "Series",
      fields: [
        { field: "series", label: "Series" },
        { field: "seriesIndex", label: "Issue or volume number", inputMode: "decimal", hint: "Where it comes in the series. Decimals are fine: 2.5 sits between 2 and 3." },
      ],
    },
    { label: "More", fields: [...MORE, DESCRIPTION] },
  ],
};

/** The form's groups of fields for a kind of book, in the order they are shown. */
export function editForm(kind: BookKind): FieldGroup[] {
  return FORMS[kind];
}

/** Every field the form shows for a kind of book. */
export function formFields(kind: BookKind): FormField[] {
  return FORMS[kind].flatMap((g) => g.fields.map((f) => f.field));
}

/** What the form says of itself, under its title. */
export function editFormAbout(kind: BookKind): string {
  const files = kind === "audiobook" ? "the audio files are" : kind === "comic" ? "the comic’s file is" : "the book’s file is";
  return `Correct what the files got wrong. Your changes are kept beside the book; ${files} never touched.`;
}
