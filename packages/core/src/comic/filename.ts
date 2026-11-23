/**
 * What a comic's file name says (docs/COMICS.md, section 4). Comics are
 * named to a pattern far more often than they carry a ComicInfo.xml:
 * "Saga 014 (2013) (Digital).cbz" is Saga, number 14, 2013. For a comic,
 * and only for a comic, the name counts for its series when the file
 * itself says nothing; what a person edits always stands over it.
 */
export interface ComicName {
  /** The series, or empty when the name is only a title. */
  series: string;
  /** The issue's number in its series, or the volume's when it is a collected volume. */
  number: number | null;
  year: number | null;
  /** The name as a title, with the brackets and underscores gone. */
  title: string;
}

/** A number that is far more likely a year in a title ("Spider-Man 2099") than an issue. */
function looksLikeYear(digits: string): boolean {
  return digits.length === 4 && Number(digits) >= 1900 && Number(digits) <= 2100;
}

/** Read a comic's file name, without its extension. */
export function parseComicName(stem: string): ComicName {
  let year: number | null = null;
  // Brackets hold the year and whatever the file's maker added: (2013) (Digital) [Group].
  const plain = stem
    .replace(/_/g, " ")
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_, round: string | undefined, square: string | undefined) => {
      const y = (round ?? square ?? "").match(/\b(19|20)\d{2}\b/);
      if (y && year === null) year = Number(y[0]);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  const title = plain || stem.trim();

  // A collected volume, "Saga v2" or "Saga Vol. 2": the volume is its number in the series.
  const volume = plain.match(/^(.+?)[\s-]*\bv(?:ol(?:ume)?)?\.?\s*(\d+)$/i);
  if (volume) return { series: volume[1]!.replace(/[\s-]+$/, "").trim(), number: Number(volume[2]), year, title };
  // An issue: "Saga 014", "Saga #14", "Saga v2 014", "Saga 014 of 54".
  const issue = plain.match(/^(.*?)[\s-]*(?:\bv(?:ol(?:ume)?)?\.?\s*(\d+))?[\s-]*(#)?(\d+(?:\.\d+)?)(?:\s+of\s+\d+)?$/i);
  if (issue) {
    const [, before, , hash, digits] = issue;
    const series = (before ?? "").replace(/[\s-]+$/, "").trim();
    if (hash || !looksLikeYear(digits!) || series === "") return { series, number: Number(digits), year, title };
  }
  return { series: "", number: null, year, title };
}
