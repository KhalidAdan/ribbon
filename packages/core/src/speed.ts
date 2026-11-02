export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3.0;
export const SPEED_STEP = 0.05;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/** Snap to the nearest 0.05 and clamp. Avoids 1.2500000001 in the UI. */
export function snapSpeed(speed: number): number {
  const snapped = Math.round(clampSpeed(speed) / SPEED_STEP) * SPEED_STEP;
  return clampSpeed(Number(snapped.toFixed(2)));
}

/** Wall-clock milliseconds left in `remainingMs` of audio at `speed`. */
export function remainingAtSpeed(remainingMs: number, speed: number): number {
  const s = clampSpeed(speed);
  return Math.max(0, Math.round(Math.max(0, remainingMs) / s));
}

/** `1:02:03`, `59:59`, `0:05`. Never negative, never fractional. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `13h 24m`, `24 min`, `36 sec`: the coarse form for "left in the book". */
export function formatLeft(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m} min`;
  return `${total} sec`;
}

export function formatSpeed(speed: number): string {
  const s = snapSpeed(speed);
  return `${Number.isInteger(s) ? s.toFixed(0) : s.toFixed(2).replace(/0$/, "")}×`;
}
