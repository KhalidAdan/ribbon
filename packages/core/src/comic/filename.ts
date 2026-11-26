/**
 * What a comic's file name says (docs/COMICS.md, section 4). Comics are
 * named to a pattern far more often than they carry a ComicInfo.xml:
 * "Saga 014 (2013) (Digital).cbz" is Saga, issue 14, 2013. For a comic,
 * and only for a comic, the name counts for its series when the file
 * itself says nothing; what a person edits always stands over it.
 *
 * "Volume" in a name means two things (docs/BOOK-DETAILS.md, section 2).
 * Before an issue number, "Batman v2 014", it is the run, and a run is the
 * series: "Batman v2", kept apart from the first. Alone at the end, "Saga
 * Vol. 2" or a manga's "One Piece v03", it is a collection's volume.
 */
export interface ComicName {
  /** The series, with its run when the name says one ("Batman v2"), or empty when the name is only a title. */
  series: string;
  /** An issue's number, as a person writes it ("14", "0.5"), or null. */
  issue: string | null;
  /** A collection's volume ("2"), or null. */
  volume: string | null;
  year: number | null;
  /** The name as a title, with the brackets and underscores gone. */
  title: string;
}

/** A number that is far more likely a year in a title ("Spider-Man 2099") than an issue. */
function looksLikeYear(digits: string): boolean {
  return digits.length === 4 && Number(digits) >= 1900 && Number(digits) <= 2100;
}

/** A number as it is printed on a cover, without the zeros a file name pads it with: "014" is 14, "0" stays 0. Anything else is left as it is. */
export function plainNumber(text: string): string {
  const t = text.trim();
  return /^\d+(\.\d+)?$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t;
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
  const trimSeries = (s: string) => s.replace(/[\s-]+$/, "").trim();

  // A collection's volume, "Saga v2" or "Saga Vol. 2".
  const collection = plain.match(/^(.+?)[\s-]*\bv(?:ol(?:ume)?)?\.?\s*(\d+)$/i);
  if (collection) return { series: trimSeries(collection[1]!), issue: null, volume: plainNumber(collection[2]!), year, title };
  // An issue: "Saga 014", "Saga #14", "Saga v2 014" (of the second run), "Saga 014 of 54".
  const issue = plain.match(/^(.*?)[\s-]*(?:\bv(?:ol(?:ume)?)?\.?\s*(\d+))?[\s-]*(#)?(\d+(?:\.\d+)?)(?:\s+of\s+\d+)?$/i);
  if (issue) {
    const [, before, run, hash, digits] = issue;
    const series = [trimSeries(before ?? ""), run ? `v${Number(run)}` : ""].filter(Boolean).join(" ");
    if (hash || !looksLikeYear(digits!) || series === "") return { series, issue: plainNumber(digits!), volume: null, year, title };
  }
  return { series: "", issue: null, volume: null, year, title };
}
