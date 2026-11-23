import { elements, splitList, splitPeople } from "../scan/sidefiles";

/**
 * What a comic says about itself in ComicInfo.xml, the file comic
 * managers write into the archive. Only what Ribbon shows is read
 * (docs/COMICS.md, section 4); anything missing or malformed is left out.
 */
export interface ComicInfo {
  title?: string;
  series?: string;
  /** The issue's number in its series, when it is a number ("14", "0.5"). */
  number?: number;
  volume?: number;
  year?: number;
  writers?: string[];
  publisher?: string;
  summary?: string;
  language?: string;
  genres?: string[];
  /** Read right to left: `Manga` is "YesAndRightToLeft". */
  rightToLeft?: boolean;
}

function numberOf(text: string): number | undefined {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/** Read a ComicInfo.xml. */
export function parseComicInfo(xml: string): ComicInfo {
  const info: ComicInfo = {};
  const seen = new Set<string>();
  for (const e of elements(xml, ["title", "series", "number", "volume", "year", "writer", "publisher", "summary", "languageiso", "genre", "manga"])) {
    // The first of each: a <Page> may carry attributes of the same names, never elements.
    if (seen.has(e.name) || !e.text) continue;
    seen.add(e.name);
    const v = e.text;
    switch (e.name) {
      case "title":
        info.title = v;
        break;
      case "series":
        info.series = v;
        break;
      case "number": {
        const n = numberOf(v);
        if (n !== undefined) info.number = n;
        break;
      }
      case "volume": {
        const n = numberOf(v);
        if (n !== undefined) info.volume = n;
        break;
      }
      case "year": {
        const n = numberOf(v);
        if (n !== undefined && n > 0) info.year = n;
        break;
      }
      case "writer":
        info.writers = splitPeople(v);
        break;
      case "publisher":
        info.publisher = v;
        break;
      case "summary":
        info.summary = v;
        break;
      case "languageiso":
        info.language = v;
        break;
      case "genre":
        info.genres = splitList(v);
        break;
      case "manga":
        if (/righttoleft/i.test(v)) info.rightToLeft = true;
        break;
    }
  }
  return info;
}
