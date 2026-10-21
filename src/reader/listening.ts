import type { AppController } from "../app/controller";
import type { BookText, TextPlace } from "../core/reading/booktext";
import { chapterAt } from "../core/scan/chapters";
import { formatLeft } from "../core/speed";
import { useAppState } from "../ui/store";

/** What the reader shows: from the first character on screen to the last. */
export interface Visible {
  from: TextPlace;
  to: TextPlace;
}

/**
 * The audiobook as the reader sees it: whether one is loaded and which,
 * where its narrator is, and whether that is on the page shown. It draws
 * again when one of these changes (the time left, by the minute), not on
 * every tick of the player. Without the text yet, the narrator counts as
 * on the page.
 */
export function useListening(bookId: string, text: BookText | null, visible: Visible | null, c: AppController) {
  return useAppState((s) => {
    const cur = s.current;
    const p = s.player;
    const here = cur?.book.book.id === bookId;
    let where = "";
    let onPage = true;
    if (here && cur) {
      const i = chapterAt(cur.book.chapters, p.positionMs);
      const ch = i >= 0 ? cur.book.chapters[i] : undefined;
      where = ch ? `${ch.title} · ${formatLeft((ch.endMs - p.positionMs) / (p.speed || 1))} left` : `${formatLeft((p.durationMs - p.positionMs) / (p.speed || 1))} left`;
      const narrator = c.narratorInText();
      if (narrator && visible && text) {
        const n = text.chars(narrator);
        onPage = n >= text.chars(visible.from) && n <= text.chars(visible.to);
      }
    }
    return { loaded: !!cur, title: cur?.book.book.title, here, where, onPage, playing: p.playing, finding: !!s.reading?.finding, following: !!s.reading?.following };
  });
}
