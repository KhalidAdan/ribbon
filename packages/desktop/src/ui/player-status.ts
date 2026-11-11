import { isLoading } from "@ribbon/core/playback";
import type { EngineState } from "../player/engine";

/**
 * What the player says of itself, beside the book in the bar and under it in
 * the full player: one answer for both, so they never disagree. What's wrong
 * comes first, as it says the most ("Could not read the file. Still
 * trying…"), then a reconnect, then loading; null when there's nothing to
 * say. The bar has room for a short word, the full player for a longer one.
 */
export function playerStatus(p: Pick<EngineState, "status" | "error">, room: "short" | "long"): string | null {
  if (p.error) return p.error;
  if (p.status === "reconnecting") return room === "short" ? "Reconnecting…" : "Reconnecting to the file…";
  if (isLoading(p.status)) return "Loading…";
  return null;
}
