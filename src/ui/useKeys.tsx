import { useEffect } from "react";
import type { AppController } from "../app/controller";
import { SPEED_STEP } from "../core/speed";

/** Space, arrows, brackets, plus and minus, B. Ignored while typing. */
export function useKeys(c: AppController): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const s = c.getState();
      if (!s.current) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          c.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          c.skip(e.shiftKey ? -10_000 : -30_000);
          break;
        case "ArrowRight":
          e.preventDefault();
          c.skip(e.shiftKey ? 10_000 : 30_000);
          break;
        case "[":
          c.previousChapter();
          break;
        case "]":
          c.nextChapter();
          break;
        case "-":
        case "_":
          void c.setSpeed(s.player.speed - SPEED_STEP);
          break;
        case "=":
        case "+":
          void c.setSpeed(s.player.speed + SPEED_STEP);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);
}
