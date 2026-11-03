import { useEffect, useState } from "react";

/** The river comes in once the narration has played this long with the page following it, as on the TV (ReadingSession.swift, `riverAfterMs`). */
export const RIVER_AFTER_MS = 5_000;

/**
 * The river (docs/READING.md, section 6), as on the TV: once the narration
 * has flowed a few seconds with the page following it, every word but the
 * sentence being read steps back (index.css), so it stands out with nothing
 * moving. Whatever stops the flow (a pause, a page turned by hand, a tap, a
 * selection) brings the words back at once, and the few seconds start over.
 */
export function useRiver(flowing: boolean): boolean {
  const [river, setRiver] = useState(false);
  useEffect(() => {
    if (!flowing) return setRiver(false);
    const wait = setTimeout(() => setRiver(true), RIVER_AFTER_MS);
    return () => clearTimeout(wait);
  }, [flowing]);
  // Back at once: in the same render the flow stops in, not one after.
  return flowing && river;
}
