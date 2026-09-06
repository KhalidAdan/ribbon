import type { Transform } from "@culvert/stream";

/**
 * Pass the first item at once, then at most one item per `ms`: the
 * latest one, when the window closes. The shape a live view wants from
 * a source that can burst, where every item makes the previous one
 * stale. A five-line generator gets this wrong: it cannot emit on a
 * timer while parked in `next()`, so the trailing item would wait for
 * the next arrival or the end.
 */
export function coalesce<T>(ms: number): Transform<T, T> {
  return async function* (source) {
    const iterator = source[Symbol.asyncIterator]();
    let next: Promise<IteratorResult<T>> | null = null;
    let last = Number.NEGATIVE_INFINITY;
    let pending: { value: T } | null = null;
    try {
      while (true) {
        next ??= iterator.next();
        let winner: IteratorResult<T> | "flush";
        if (pending) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const flush = new Promise<"flush">((resolve) => {
            timer = setTimeout(() => resolve("flush"), Math.max(0, ms - (Date.now() - last)));
          });
          winner = await Promise.race([next, flush]);
          clearTimeout(timer);
        } else {
          winner = await next;
        }
        if (winner === "flush") {
          const { value } = pending!;
          pending = null;
          last = Date.now();
          yield value;
          continue;
        }
        next = null;
        if (winner.done) break;
        if (Date.now() - last >= ms) {
          pending = null;
          last = Date.now();
          yield winner.value;
        } else {
          pending = { value: winner.value };
        }
      }
      if (pending) yield pending.value;
    } finally {
      await iterator.return?.();
    }
  };
}
