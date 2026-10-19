import { useEffect } from "react";
import type { AppController } from "../app/controller";
import { SPEED_STEP } from "../core/speed";

/** Space, arrows, brackets, plus and minus, B. Ignored while typing. */
export function useKeys(c: AppController): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // A held key repeats: one toggle per press, or play and pause flicker.
      if (e.repeat && (e.key === " " || e.key === "k")) {
        e.preventDefault();
        return;
      }
      // A focused slider moves itself with the arrows.
      if (t?.getAttribute("role") === "slider" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      const s = c.getState();
      // The reader has its own keys.
      if (s.reading) return;
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
