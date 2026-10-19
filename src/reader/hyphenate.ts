import { SOFT_HYPHEN, type WordBreaks } from "../core/reading/hyphens";

/**
 * Liang's hyphenation patterns, from the `hyphen` package, for the book's
 * language. Each language is its own chunk, loaded only when a book in it
 * is opened; a language with no patterns here is not hyphenated.
 */

type Patterns = () => Promise<{ default: unknown }>;

const PATTERNS: Record<string, Patterns> = {
  en: () => import("hyphen/patterns/en-us.js"),
  "en-gb": () => import("hyphen/patterns/en-gb.js"),
  de: () => import("hyphen/patterns/de-1996.js"),
  fr: () => import("hyphen/patterns/fr.js"),
  es: () => import("hyphen/patterns/es.js"),
  it: () => import("hyphen/patterns/it.js"),
  pt: () => import("hyphen/patterns/pt.js"),
  nl: () => import("hyphen/patterns/nl.js"),
  sv: () => import("hyphen/patterns/sv.js"),
  da: () => import("hyphen/patterns/da.js"),
  nb: () => import("hyphen/patterns/nb.js"),
  fi: () => import("hyphen/patterns/fi.js"),
  pl: () => import("hyphen/patterns/pl.js"),
  cs: () => import("hyphen/patterns/cs.js"),
  ru: () => import("hyphen/patterns/ru.js"),
  uk: () => import("hyphen/patterns/uk.js"),
};
// Languages that share another's patterns.
const SAME: Record<string, string> = { no: "nb", nn: "nb", "en-au": "en-gb", "en-nz": "en-gb", "en-ie": "en-gb", "en-in": "en-gb", "en-za": "en-gb" };

/** The patterns' name for a language tag, English when the book names none, or null when there are none. */
export function patternsName(language: string | undefined): string | null {
  const tag = (language ?? "").trim().toLowerCase().replaceAll("_", "-") || "en";
  for (const t of [tag, tag.split("-")[0]!]) {
    const name = SAME[t] ?? t;
    if (PATTERNS[name]) return name;
  }
  return null;
}

const loaded = new Map<string, Promise<WordBreaks | null>>();

/** Where words break in a language, once its patterns are loaded; null when it has none or they fail to load. */
export function hyphenatorFor(language: string | undefined): Promise<WordBreaks | null> {
  const name = patternsName(language);
  if (!name) return Promise.resolve(null);
  let p = loaded.get(name);
  if (!p) {
    p = Promise.all([import("hyphen/hyphen.js"), PATTERNS[name]!()])
      .then(([{ default: createHyphenator }, { default: patterns }]) => {
        const hyphenate = createHyphenator(patterns, { hyphenChar: SOFT_HYPHEN, minWordLength: 1, html: false });
        return (word: string) => {
          const out: number[] = [];
          let at = 0;
          for (const ch of hyphenate(word)) {
            if (ch === SOFT_HYPHEN) out.push(at);
            else at += ch.length;
          }
          return out;
        };
      })
      .catch(() => null);
    loaded.set(name, p);
  }
  return p;
}
