import { elements, splitList, splitPeople } from "../scan/sidefiles";
import type { Credits, Role } from "../types";
import { plainNumber } from "./filename";

/**
 * What a comic says about itself in ComicInfo.xml, the file comic
 * managers write into the archive (the Anansi Project's schema, 2.0 and
 * the 2.1 draft). It is read in full, as the file says it, and what it
 * means is worked out where a comic's book is made (scan/comics.ts):
 * whether its `Number` is an issue's or a collection's volume, whether
 * its `Volume` is a run's first year (docs/BOOK-DETAILS.md, section 2).
 * Anything missing or malformed is left out.
 */
export interface ComicInfo {
  /** The story's own name. */
  title?: string;
  series?: string;
  /** `Number`, as printed: an issue's ("14", "½", "1.MU"), or a collection's volume when `Format` says it is one. */
  number?: string;
  /** `Volume`: a run's first year ("2023"), or a number, which may be a run's or a manga's book. */
  volume?: string;
  /** `Format`: "TPB", "HC", "Omnibus", "Annual" and so on. */
  format?: string;
  /** The people who made it, by role: `Writer`, `Penciller`, `Inker`, `Colorist`, `Letterer`, `CoverArtist`, `Editor`, `Translator`. */
  credits?: Credits;
  publisher?: string;
  imprint?: string;
  /** The cover date: `Year`, `Month` and `Day`, each when it is a number that can be one. */
  year?: number;
  month?: number;
  day?: number;
  summary?: string;
  language?: string;
  genres?: string[];
  storyArcs?: string[];
  /** `Web`: its pages on the web, as the file has them. A ComicVine issue's address among them is its ComicVine id (`comicVineIssue`). */
  web?: string;
  /** Read right to left: `Manga` is "YesAndRightToLeft". */
  rightToLeft?: boolean;
}

/** The credits' elements, and the role each names. */
const CREDIT_ELEMENTS: Record<string, Role> = {
  writer: "writers",
  penciller: "pencils",
  inker: "inks",
  colorist: "colours",
  letterer: "letters",
  coverartist: "coverArtists",
  editor: "editors",
  translator: "translators",
};

const ELEMENTS = ["title", "series", "number", "volume", "format", "publisher", "imprint", "year", "month", "day", "summary", "languageiso", "genre", "storyarc", "web", "manga", ...Object.keys(CREDIT_ELEMENTS)];

/** A whole number from `low` to `high`, or undefined. */
function wholeIn(text: string, low: number, high: number): number | undefined {
  const n = Number(text.trim());
  return /^\d+$/.test(text.trim()) && n >= low && n <= high ? n : undefined;
}

/** Read a ComicInfo.xml. */
export function parseComicInfo(xml: string): ComicInfo {
  const info: ComicInfo = {};
  const credits: Credits = {};
  const seen = new Set<string>();
  for (const e of elements(xml, ELEMENTS)) {
    // The first of each: a <Page> may carry attributes of the same names, never elements.
    if (seen.has(e.name) || !e.text) continue;
    seen.add(e.name);
    const v = e.text;
    const role = CREDIT_ELEMENTS[e.name];
    if (role) {
      const names = splitPeople(v);
      if (names.length > 0) credits[role] = names;
      continue;
    }
    switch (e.name) {
      case "title":
        info.title = v;
        break;
      case "series":
        info.series = v;
        break;
      case "number":
        info.number = plainNumber(v);
        break;
      case "volume":
        info.volume = plainNumber(v);
        break;
      case "format":
        info.format = v;
        break;
      case "publisher":
        info.publisher = v;
        break;
      case "imprint":
        info.imprint = v;
        break;
      case "year": {
        const n = wholeIn(v, 1, 9999);
        if (n !== undefined) info.year = n;
        break;
      }
      case "month": {
        const n = wholeIn(v, 1, 12);
        if (n !== undefined) info.month = n;
        break;
      }
      case "day": {
        const n = wholeIn(v, 1, 31);
        if (n !== undefined) info.day = n;
        break;
      }
      case "summary":
        info.summary = v;
        break;
      case "languageiso":
        info.language = v;
        break;
      case "genre":
        info.genres = splitList(v);
        break;
      case "storyarc": {
        // Apart by commas, as the schema has it, not by slashes as genres are: "Batman/Superman" is one arc.
        const arcs = [...new Set(v.split(/\s*[,;]\s*/).filter(Boolean))];
        if (arcs.length > 0) info.storyArcs = arcs;
        break;
      }
      case "web":
        info.web = v;
        break;
      case "manga":
        if (/righttoleft/i.test(v)) info.rightToLeft = true;
        break;
    }
  }
  if (Object.keys(credits).length > 0) info.credits = credits;
  return info;
}

/**
 * The ComicVine issue a comic's `Web` names, "4000-1234567", from an
 * address like comicvine.gamespot.com/saga-14/4000-1234567/. Only an
 * issue's: a run's address (4050-) doesn't say which issue it is.
 */
export function comicVineIssue(web: string | undefined): string | undefined {
  return web?.match(/comicvine\.gamespot\.com\/(?:[^\s/]+\/)*?(4000-\d+)/i)?.[1];
}
