/**
 * How the player keeps going when a file will not. Pure numbers, so the
 * policy is tested apart from any media element.
 */

/** No forward progress for this long, while the listener wants to play, is a stall. */
export const STALL_MS = 15_000;

const DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const MAX_DELAY_MS = 30_000;

/**
 * Wait before reload number `attempt` (0-based). Quick at first, for a
 * blip; then patient, for a share that is reconnecting; never giving up.
 */
export function recoveryDelayMs(attempt: number): number {
  if (!(attempt >= 0)) return DELAYS_MS[0]!;
  return DELAYS_MS[Math.floor(attempt)] ?? MAX_DELAY_MS;
}
