/**
 * What changed in a version of Ribbon, in a few plain lines, for the note
 * the desktop shows after it has updated itself and for Settings. The notes
 * are part of the app (packages/desktop/src/whats-new.ts), so reading them
 * asks the internet nothing; each release adds its own
 * (docs/RELEASING.md, section 3).
 */
export interface ReleaseNotes {
  version: string;
  /** What changed, each a sentence someone using Ribbon would recognise. */
  points: string[];
}

/** Whether version `a` is newer than `b`: by its numbers, so 0.10.0 is newer than 0.9.0. */
export function newerThan(a: string, b: string): boolean {
  const parts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * The notes to show someone who last ran `seen` and now runs `running`: every
 * version after the one they saw, up to the one running, the newest first.
 * None for a first run (`seen` is null: there is nothing to compare with, and
 * a new Ribbon needs no telling what changed), for the same version, and
 * for a version older than the one seen.
 */
export function newsSince(notes: readonly ReleaseNotes[], seen: string | null, running: string): ReleaseNotes[] {
  if (seen === null || !newerThan(running, seen)) return [];
  return notes.filter((n) => newerThan(n.version, seen) && !newerThan(n.version, running)).sort((a, b) => (newerThan(a.version, b.version) ? -1 : 1));
}
