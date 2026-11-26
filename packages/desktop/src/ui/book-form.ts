import { comicShape, type ComicShape } from "@ribbon/core/comic-name";
import { comicVineAddress, issuePage, numberToLookUp, runSearchOf } from "@ribbon/core/comicvine";
import { editForm, shapeEmpties, type FieldGroup, type FieldSpec, type FormField } from "@ribbon/core/edit-form";
import type { EditValues } from "@ribbon/core/edits";
import type { BookKind } from "@ribbon/core/kind";
import type { Book } from "@ribbon/core/types";

/**
 * What the edit form (EditBook.tsx) shows of a book's fields and sends
 * when it is saved, from the specs core gives for its kind
 * (core/edit-form.ts). Kept apart from the component so it can be tested
 * without drawing it.
 *
 * A comic's form asks first what the comic is: an issue, a collection, or
 * a comic on its own. The answer isn't kept: the fields say it
 * (core/comic-name.ts, `comicShape`). It decides which numbers are asked
 * for, and a change of it empties the ones that no longer fit, so a
 * comic's file can't bring an issue number back to a collection.
 */

/** The form's text for each field, as the person has it now. */
export type FormValues = Partial<Record<FormField, string>>;

/** What the form is asking about a book as it stands. */
export interface FormAsks {
  /** What a comic is said to be; null for a book whose form doesn't ask. */
  shape: ComicShape | null;
  /** The book has a byline kept from before a comic's people had fields of their own (core/comic-edits.ts): its By is shown until taken back. */
  bylineKept: boolean;
}

/** What a comic is, by the numbers a form has for it: an issue number makes it an issue, as on the shelf. */
export function shapeOf(form: FormValues): ComicShape {
  return comicShape({ issue: form.issue, volume: form.volume, collects: form.collects });
}

/**
 * What the form asks of a book as it opens: a comic is what its numbers
 * make it, and its By is shown while it has a byline kept from before.
 * After that the answer to "It is" is the person's, held by the form:
 * a collection whose volume they haven't typed yet is still a collection
 * while they type it.
 */
export function asksOf(kind: BookKind, form: FormValues, edits: EditValues | undefined): FormAsks {
  return { shape: kind === "comic" ? shapeOf(form) : null, bylineKept: kind === "comic" && edits?.author !== undefined };
}

/** Whether the form shows a field: a comic's numbers only for what it is said to be, its By only while there is a byline to take back. */
export function showsField(spec: FieldSpec, asks: FormAsks): boolean {
  if (spec.shape !== undefined && spec.shape !== asks.shape) return false;
  if (spec.whileEdited && !asks.bylineKept) return false;
  return true;
}

/**
 * The form once the comic is said to be `shape`: the numbers that no
 * longer fit emptied (core/edit-form.ts, `shapeEmpties`), and the ones
 * that do fit, if a change away had emptied them, as the book had them
 * (`before`), so a slip of the hand loses nothing.
 */
export function formAsShape<F extends FormValues>(form: F, shape: ComicShape, groups: readonly FieldGroup[], before: FormValues): F {
  const out: FormValues = { ...form };
  for (const f of shapeEmpties(shape)) out[f] = "";
  for (const spec of groups.flatMap((g) => g.fields)) {
    if (spec.shape === shape && !out[spec.field]?.trim()) out[spec.field] = before[spec.field] ?? "";
  }
  return out as F;
}

/**
 * What the form sends when it is saved: the fields it shows, and the
 * numbers a comic's shape leaves out, which it has emptied if the shape
 * was changed. A field the form leaves out is never changed by it: its
 * edit, if it has one, stays as it is (core/edits.ts, `diffEdits`). So a
 * comic's name, byline, place and year, made on the shelf from what the
 * form does ask, never become edits of their own.
 *
 * A By emptied is a By taken back: it is sent as the files have it, so it
 * stops being an edit and the credits make the byline again. Kept as an
 * empty edit, the byline would show the credits but the form would go on
 * showing an empty By, asking to be taken back.
 */
export function formToSave(form: FormValues, groups: readonly FieldGroup[], asks: FormAsks, files: FormValues): FormValues {
  const out: FormValues = {};
  for (const spec of groups.flatMap((g) => g.fields)) {
    if (!showsField(spec, asks)) continue;
    const value = form[spec.field] ?? "";
    out[spec.field] = spec.whileEdited && !value.trim() ? (files[spec.field] ?? "") : value;
  }
  // Only a form that asks what the comic is empties the numbers that don't fit it: 0.51.0's form, for an older server, asks no such thing.
  if (asks.shape !== null && groups.some((g) => g.shape)) for (const f of shapeEmpties(asks.shape)) out[f] = form[f] ?? "";
  return out;
}

/**
 * A comic's form as 0.51.0 had it (core/edit-form.ts, before comics had
 * details of their own), for a comic on a server from before them: such a
 * server refuses an edit with a field it doesn't know, so its comics are
 * asked what it takes (docs/BOOK-DETAILS.md, section 4: "a desktop on an
 * older server shows a comic's form as it is today"). The title is the
 * comic's whole name there, its people one line.
 */
const COMIC_FORM_BEFORE: FieldGroup[] = [
  {
    label: "The comic",
    fields: [
      { field: "title", label: "Title", hint: "Say which issue or issues it holds: “Saga #14”, or “Saga Vol. 1 (#1–#6)”.", wide: true },
      { field: "subtitle", label: "Subtitle", hint: "A story’s name, or a collection’s.", wide: true },
    ],
  },
  { label: "People", fields: [{ field: "author", label: "Writers and artists", hint: "Separate several with a semicolon.", wide: true }] },
  {
    label: "Series",
    fields: [
      { field: "series", label: "Series" },
      { field: "seriesIndex", label: "Issue or volume number", inputMode: "decimal", hint: "Where it comes in the series. Decimals are fine: 2.5 sits between 2 and 3." },
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
  {
    label: "More",
    fields: [
      { field: "year", label: "Year", inputMode: "numeric" },
      { field: "language", label: "Language" },
      { field: "genres", label: "Genres", hint: "Separate with commas.", wide: true },
      { field: "publisher", label: "Publisher" },
      { field: "isbn", label: "ISBN" },
      { field: "description", label: "Description", multiline: true, wide: true },
    ],
  },
];

/**
 * The form's groups for a book, where its edits are kept: its kind's
 * (core/edit-form.ts); for a server's book, only the fields that server
 * takes (`takes`; null for a folder's, which keeps every one), and a
 * comic's as 0.51.0 asked it on a server that doesn't keep a comic's own
 * details. A field the form leaves out is never changed by it.
 */
export function formFor(kind: BookKind, file: string | undefined, takes: ReadonlySet<string> | null): FieldGroup[] {
  const groups = kind === "comic" && takes && !takes.has("issue") ? COMIC_FORM_BEFORE : editForm(kind, file);
  if (!takes) return groups;
  return groups.map((g) => ({ ...g, fields: g.fields.filter((f) => takes.has(f.field)) })).filter((g) => g.fields.length > 0);
}

/**
 * The form once what it shows of the book changed under it (a ComicVine
 * match kept or forgotten while it is open): what the person typed stays,
 * and each field they left as it was shows the book as it is now.
 */
export function formRebased<F extends FormValues>(form: F, shownBefore: FormValues, shownNow: F): F {
  const out: FormValues = { ...form };
  for (const [f, now] of Object.entries(shownNow) as [FormField, string][]) {
    if ((form[f] ?? "") === (shownBefore[f] ?? "")) out[f] = now;
  }
  return out as F;
}

// ComicVine ---------------------------------------------------------------

/** One field of a comic beside what ComicVine says of it, for the look-up's side-by-side (docs/BOOK-DETAILS.md, section 7). */
export interface ComparedField {
  field: FormField;
  label: string;
  /** As the comic has it in the form now. */
  here: string;
  /** As ComicVine has it; empty where it empties the field (a collection's issue number, say). */
  there: string;
  same: boolean;
}

/**
 * Each field ComicVine says something of, as the comic has it and as
 * ComicVine has it, in the form's order (its kind's whole form, whatever
 * the comic is said to be: a collection's volume shows beside an issue's
 * number). A field ComicVine empties shows only where the comic has
 * something in it.
 */
export function comparedFields(groups: readonly FieldGroup[], form: FormValues, values: EditValues): ComparedField[] {
  const specs = groups.flatMap((g) => g.fields).filter((spec) => !spec.switch && !spec.whileEdited);
  return specs.flatMap((spec) => {
    const there = values[spec.field];
    const here = form[spec.field] ?? "";
    if (there === undefined || (there.trim() === "" && here.trim() === "")) return [];
    return [{ field: spec.field, label: spec.label, here, there, same: plainText(here) === plainText(there) }];
  });
}

/** Text as a comparison sees it: its spaces and line ends one way. */
function plainText(text: string): string {
  return text.trim().replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
}

/** What a look-up starts from: the comic's own page on ComicVine if it has one, its series as a search, and the number to ask a run for. */
export interface LookUpStart {
  address: string;
  name: string;
  year: string;
  number: string;
}

/**
 * Where "Look it up" starts, from the comic as the form has it: the page
 * it was matched to, else the one its file gives (ComicInfo's `Web`), as
 * an address; its series as a search, the run's year taken out of the name
 * and given as the year (core's `runSearchOf`); and its number as the form
 * says what it is (an issue's issue number, a collection's volume).
 */
export function lookUpStart(book: Pick<Book, "comicvine">, matched: { address: string } | null, form: FormValues, shape: ComicShape | null): LookUpStart {
  const own = book.comicvine ? comicVineAddress(book.comicvine) : null;
  const address = matched?.address ?? (own?.kind === "issue" ? issuePage({ id: own.id }) : "");
  const search = runSearchOf(form.series ?? "");
  return { address, name: search.name, year: search.year === null ? "" : String(search.year), number: numberToLookUp({ issue: form.issue ?? "", volume: form.volume ?? "" }, shape ?? "issue") };
}

/** Whether a field's form text differs from what it is checked against: spaces at the ends and line endings aside. */
export function differs(a: string, b: string): boolean {
  return a.trim().replace(/\r\n/g, "\n") !== b.trim().replace(/\r\n/g, "\n");
}
