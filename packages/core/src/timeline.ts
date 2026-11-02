/**
 * A book is one timeline in milliseconds from the start of its first
 * file. The player thinks in file offsets. These two functions are the
 * only place the conversion happens, and every boundary is a test case.
 */

export interface Locus {
  fileIndex: number;
  fileOffsetMs: number;
  /** True when the offset is at or past the end of the last file. */
  atEnd: boolean;
}

export function totalDuration(durationsMs: readonly number[]): number {
  let t = 0;
  for (const d of durationsMs) t += Math.max(0, d);
  return t;
}

/** Map a book offset to the file that contains it. Clamps at both ends. */
export function locate(durationsMs: readonly number[], offsetMs: number): Locus {
  const n = durationsMs.length;
  if (n === 0) return { fileIndex: 0, fileOffsetMs: 0, atEnd: true };
  const total = totalDuration(durationsMs);
  if (!(offsetMs > 0)) offsetMs = 0;
  if (offsetMs >= total) {
    // Land on the last file with a positive duration, at its end.
    let last = n - 1;
    while (last > 0 && durationsMs[last]! <= 0) last--;
    return { fileIndex: last, fileOffsetMs: Math.max(0, durationsMs[last]!), atEnd: true };
  }
  let start = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.max(0, durationsMs[i]!);
    if (d === 0) continue;
    if (offsetMs < start + d) {
      return { fileIndex: i, fileOffsetMs: offsetMs - start, atEnd: false };
    }
    start += d;
  }
  // Unreachable given the total check, but keep the type honest.
  return { fileIndex: n - 1, fileOffsetMs: durationsMs[n - 1]!, atEnd: true };
}

/** Inverse of locate. Out-of-range file indexes clamp. */
export function toBookOffset(
  durationsMs: readonly number[],
  fileIndex: number,
  fileOffsetMs: number,
): number {
  const n = durationsMs.length;
  if (n === 0) return 0;
  const i = Math.min(Math.max(0, fileIndex), n - 1);
  let start = 0;
  for (let k = 0; k < i; k++) start += Math.max(0, durationsMs[k]!);
  const d = Math.max(0, durationsMs[i]!);
  const local = Math.min(Math.max(0, fileOffsetMs), d);
  return start + local;
}

/** Start offset of each file in the book timeline. */
export function fileStarts(durationsMs: readonly number[]): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const d of durationsMs) {
    starts.push(t);
    t += Math.max(0, d);
  }
  return starts;
}
