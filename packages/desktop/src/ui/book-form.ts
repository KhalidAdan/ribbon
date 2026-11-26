import { comicShape, type ComicShape } from "@ribbon/core/comic-name";
import { shapeEmpties, type FieldGroup, type FieldSpec, type FormField } from "@ribbon/core/edit-form";
import type { EditValues } from "@ribbon/core/edits";
import type { BookKind } from "@ribbon/core/kind";

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
  if (asks.shape !== null) for (const f of shapeEmpties(asks.shape)) out[f] = form[f] ?? "";
  return out;
}
