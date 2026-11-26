import { comicName, comicNamingOf, comicShape } from "./comic-name";
import { applyEdits, type EditValues } from "./edits";
import type { Book } from "./types";

/**
 * A comic's edits from before it had details of its own, read as the new
 * ones (docs/BOOK-DETAILS.md, section 6). Until then a comic kept an
 * audiobook's: its whole name in the title, as the form's hint asked
 * ("Saga #14", "Saga Vol. 1 (#1–#6)"), a story's name in the subtitle, its
 * issue or volume as its number in the series, and its writers and
 * artists in one line as its author. So:
 *
 * | A comic's edit | Becomes |
 * | --- | --- |
 * | Title, the name the shelf now makes ("Transformers #10") | Dropped: the shelf says it. Emptied instead where the file gives a title the edit kept off the shelf, so the shelf shows the same |
 * | Title in the hint's shape, "Series Vol. 1 (#1–#6)" | Volume 1, collects "1–6"; its subtitle, if any, its title |
 * | Title, anything else | Kept: it is the story's name |
 * | Subtitle | Joined to the title kept, "Title: Subtitle"; else the title |
 * | Number in the series | Its volume, if it is a collection by its title or its files; else its issue |
 * | Author | Kept: a byline from before, shown until it is taken back (comic-name.ts) |
 * | Everything else | As it was |
 *
 * The title's shape is Ribbon's own, from its own hint, so reading it back
 * isn't a guess at what someone meant. A byline can't be moved: "Daniel
 * Warren Johnson; Jorge Corona" doesn't say who drew.
 *
 * Edits already in the new shape come back as they are, so a host can move
 * a book's edits every time it reads them: the desktop does, until the
 * book is next saved (in the new shape), and a server does once, when it
 * starts.
 */
export function movedComicEdits(values: EditValues, files: Book): EditValues {
  if (!files.comic) return values;
  const { title, subtitle, seriesIndex } = values;
  if (title === undefined && subtitle === undefined && seriesIndex === undefined) return values;

  const out: EditValues = { ...values };
  delete out.title;
  delete out.subtitle;
  delete out.seriesIndex;

  // An emptied title stays empty, saying the comic has no title of its own: so a title this move empties reads the same when it is moved again.
  const titled = title?.trim() || null;
  if (title !== undefined && !titled) out.title = "";
  const shaped = titled ? collectionTitle(titled, values.series ?? files.series) : null;
  const collection = !!shaped || comicShape(applyEdits(files, out)) === "collection";
  if (shaped) {
    out.volume = shaped.volume;
    if (shaped.collects) out.collects = shaped.collects;
  }
  if (seriesIndex !== undefined) {
    if (!collection) out.issue = seriesIndex.trim();
    // A volume the title gave is the one the person wrote out; the number was its place.
    else if (!shaped) out.volume = seriesIndex.trim();
  }
  // Made a collection, a comic whose file gives an issue number has it emptied, so the file's number doesn't come back as an issue.
  if (collection && files.issue && out.issue === undefined) out.issue = "";

  const sub = subtitle?.trim() ?? "";
  if (!titled) {
    // A subtitle alone was the story's name, shown under the title its file gives, or under none.
    if (sub) out.title = files.rawTitle ? `${files.rawTitle}: ${sub}` : sub;
    return out;
  }
  // The names the shelf now makes, with the rest of the edits moved: with the title the comic's file gives, and by its series and number alone.
  const naming = comicNamingOf(applyEdits(files, out));
  const isWholeName = sameName(titled, comicName(naming));
  const isBareName = sameName(titled, comicName({ ...naming, title: "" }));
  if (!shaped && !isWholeName && !isBareName) {
    // Any other title is the story's own name, its subtitle after it.
    out.title = sub ? `${titled}: ${sub}` : titled;
  } else if (sub) {
    out.title = sub;
  } else if (!isWholeName && files.rawTitle) {
    // The title kept the one the file gives off the shelf, and an empty one still does: the shelf shows what it did.
    out.title = "";
  }
  return out;
}

/** Whether two names are the same, their case, a run's year in brackets, a "#", and how their dashes and spaces are written aside. */
function sameName(a: string, b: string): boolean {
  return plainName(a) === plainName(b);
}

function plainName(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(\d{4}\)/g, " ")
    .replace(/#/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A title in the shape the form's hint asked for, "Saga Vol. 1 (#1–#6)":
 * its volume, and the issues it collects, "1–6". Without the issues,
 * "Saga Vol. 1" is the shape only when "Saga" is the comic's series.
 */
function collectionTitle(title: string, series: string): { volume: string; collects: string | null } | null {
  const shape = title.match(/^(.+?)\s+vol(?:ume)?\.?\s*([\d½][\w.½]*)\s*(?:\(\s*(#[^)]*)\))?$/i);
  if (!shape) return null;
  const [, head, volume, issues] = shape;
  if (!issues && plainName(head!) !== plainName(series)) return null;
  const collects = issues
    ? issues
        .replace(/#/g, "")
        .replace(/\s*[-–—]\s*/g, "–")
        .replace(/\s*,\s*/g, ", ")
        .trim()
    : null;
  return { volume: volume!, collects };
}
