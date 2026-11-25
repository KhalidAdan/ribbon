import type { DatabaseSync } from "node:sqlite";
import { panelsFrom, panelsProblem, type Panel } from "@ribbon/core/comic/panels";

/**
 * The panels of the library's comics (docs/COMICS.md, section 14): for
 * each page that has been divided, its panels in the order they are read.
 * What a panel is, and what a page's panels may be, is core's to say
 * (packages/core/src/comic/panels.ts); this only keeps them.
 *
 * A page is kept by its name in the comic's archive (a PDF's by "page=4"),
 * as a comic's place is, so its panels stay with it whatever its number.
 * They are the library's, like a book's edits: one set for everyone,
 * changed by the admin, and the last change stands.
 *
 * A page with no panels kept has not been looked at. A page looked at and
 * left whole is kept as one panel the size of the page.
 */
export class ComicPanels {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every divided page of a comic, by the page's name. */
  of(bookId: string): Map<string, Panel[]> {
    const out = new Map<string, Panel[]>();
    for (const row of this.db.prepare("SELECT page, panels FROM comic_panels WHERE book_id = ?").all(bookId)) {
      const panels = panelsFrom(parsed(String(row.panels)));
      if (panels && panels.length > 0) out.set(String(row.page), panels);
    }
    return out;
  }

  /** One page's panels, in order; none when it hasn't been divided. */
  ofPage(bookId: string, page: string): Panel[] {
    const row = this.db.prepare("SELECT panels FROM comic_panels WHERE book_id = ? AND page = ?").get(bookId, page);
    return (row && panelsFrom(parsed(String(row.panels)))) || [];
  }

  /**
   * Keep a page's panels in place of the ones it had. An empty list takes
   * them away. Returns why they can't be kept, in a sentence, or null when
   * they are.
   */
  keep(bookId: string, page: string, panels: readonly Panel[], by: string): string | null {
    const problem = panelsProblem(panels);
    if (problem) return problem;
    if (panels.length === 0) {
      this.db.prepare("DELETE FROM comic_panels WHERE book_id = ? AND page = ?").run(bookId, page);
      return null;
    }
    this.db
      .prepare("INSERT INTO comic_panels (book_id, page, panels, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (book_id, page) DO UPDATE SET panels = excluded.panels, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(bookId, page, JSON.stringify(panels), by, this.now());
    return null;
  }

  /** How many of each comic's pages are divided, by book: for a list that says how far along each is. */
  counts(): Map<string, number> {
    return new Map(this.db.prepare("SELECT book_id, count(*) AS pages FROM comic_panels GROUP BY book_id").all().map((row) => [String(row.book_id), Number(row.pages)]));
  }

  /** A comic taken off the server takes its panels with it. */
  forget(bookId: string): void {
    this.db.prepare("DELETE FROM comic_panels WHERE book_id = ?").run(bookId);
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
