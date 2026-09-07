import { useEffect, useRef, useState } from "react";
import type { Chapter } from "../core/types";
import { formatDuration } from "../core/speed";

interface Props {
  positionMs: number;
  durationMs: number;
  chapters: Chapter[];
  onSeek: (ms: number) => void;
  label?: string;
}

/**
 * A native range input for the accessibility tree, with chapter ticks
 * drawn over it. While dragging, the label tracks the thumb and the
 * engine is only told where to go on release.
 */
export function Scrubber({ positionMs, durationMs, chapters, onSeek, label = "Position in book" }: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? positionMs;
  const max = Math.max(1, durationMs);
  const progress = `${((shown / max) * 100).toFixed(2)}%`;
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--progress", progress);
  }, [progress]);

  return (
    <div className="relative pt-2">
      <div className="pointer-events-none absolute inset-x-0 top-2 h-1.5" aria-hidden="true">
        {chapters.slice(1).map((ch) => (
          <span key={ch.startMs} className="absolute top-0 h-full w-px bg-white/70 dark:bg-neutral-950/60" style={{ left: `${(ch.startMs / max) * 100}%` }} />
        ))}
      </div>
      <input
        ref={ref}
        type="range"
        name="position"
        aria-label={label}
        aria-valuetext={formatDuration(shown)}
        min={0}
        max={max}
        step={1000}
        value={Math.min(max, shown)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag !== null) onSeek(drag);
          setDrag(null);
        }}
        onKeyUp={() => {
          if (drag !== null) onSeek(drag);
          setDrag(null);
        }}
        onBlur={() => {
          if (drag !== null) onSeek(drag);
          setDrag(null);
        }}
        className="scrubber relative block h-1.5 w-full"
      />
    </div>
  );
}
