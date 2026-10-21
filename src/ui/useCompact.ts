import { useSyncExternalStore } from "react";

/**
 * A phone, or a window as narrow as one. The reader keeps its controls to
 * one small capsule there (src/reader/Dock.tsx). A touch screen counts
 * whatever its width: a finger swipes and taps, where a mouse has the
 * header's buttons and the page's edges.
 */
const COMPACT = "(max-width: 639px), (pointer: coarse)";

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => typeof matchMedia === "function" && matchMedia(COMPACT).matches, () => false);
}

function subscribe(changed: () => void): () => void {
  if (typeof matchMedia !== "function") return () => undefined;
  const query = matchMedia(COMPACT);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}
