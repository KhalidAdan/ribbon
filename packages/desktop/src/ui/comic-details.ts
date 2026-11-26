import { comicLabel, comicNamingOf } from "@ribbon/core/comic-name";
import { ROLES, type Book, type Credits, type Role } from "@ribbon/core/types";

/**
 * A comic's own details as a book's page says them (ReaderPage.tsx;
 * docs/BOOK-DETAILS.md, section 4): its people by what they did, its cover
 * date as a month and a year, the day it went on sale, and its label in
 * its series, "#7" or "Vol. 1" where a book's is "Book 2". Kept apart from
 * the page so they can be tested without drawing it.
 */

/** What each role is called on a book's page, for one name and for several: the edit form's words (core/edit-form.ts). */
const ROLE_NAMES: Record<Role, [one: string, several: string]> = {
  writers: ["Writer", "Writers"],
  pencils: ["Art", "Art"],
  inks: ["Inks", "Inks"],
  colours: ["Colours", "Colours"],
  letters: ["Letters", "Letters"],
  coverArtists: ["Cover", "Cover"],
  editors: ["Editor", "Editors"],
  translators: ["Translator", "Translators"],
};

/** Names as a sentence lists them: "Ada Quill", "Ada Quill and Ben Nib", "Ada Quill, Ben Nib and Cy Ink". */
export function namesText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A role's people as a line of the page: what they did, and who. */
export interface CreditLine {
  role: Role;
  label: string;
  names: string;
}

/** A book's people by what they did: a line for each role someone is named for, in the order the form asks for them. */
export function creditLines(credits: Credits | undefined): CreditLine[] {
  return ROLES.flatMap((role) => {
    const names = credits?.[role] ?? [];
    if (names.length === 0) return [];
    const [one, several] = ROLE_NAMES[role];
    return [{ role, label: names.length === 1 ? one : several, names: namesText(names) }];
  });
}

/** A cover date as people say it: "2024-07" is "July 2024" (in the reader's own language), "2024" is "2024". Anything else as it is. */
export function coverDateText(coverDate: string): string {
  const m = coverDate.match(/^(\d{4})-(\d{2})$/);
  if (!m) return coverDate;
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(Number(m[1]), Number(m[2]) - 1));
}

/** A day as people say it: "2024-07-10" is "10 July 2024", or "July 10, 2024", as the reader's language has it. Anything else as it is. */
export function dayText(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return day;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * A comic's label in a series, "#7" or "Vol. 1", where a book's is
 * "Book 2" (core/comic-name.ts, `comicLabel`). Only in the series it is
 * numbered in, its own: in a series a person made by hand, a reading list,
 * its issue number says nothing about where it comes. Null for a book that
 * isn't a comic, or a comic on its own.
 */
export function comicLabelIn(book: Book, seriesName: string): string | null {
  if (!book.comic || book.series.trim().toLowerCase() !== seriesName.trim().toLowerCase()) return null;
  return comicLabel(comicNamingOf(book));
}
