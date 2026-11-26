/**
 * A summary someone else's service writes in HTML, made plain paragraphs:
 * Audible's (packages/server/src/library/describe.ts) and ComicVine's
 * (comicvine.ts). Its words are kept as they came; only the markup goes.
 * A paragraph, a heading or an item of a list ends a line of its own, and
 * entities are the letters they stand for.
 */

/** The named entities summaries use: markup's own, and typography's. */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…" };

/** A summary as a catalog writes it, in HTML, as plain paragraphs. */
export function summaryText(html: string): string {
  return html
    .replace(/<\/(?:p|h[1-6]|blockquote|div)>\s*/gi, "\n\n")
    .replace(/<br\s*\/?>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
