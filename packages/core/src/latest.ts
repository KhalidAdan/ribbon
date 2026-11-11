/**
 * Asks where only the newest counts (docs/STATE-MACHINES.md): opening a
 * book, opening the reader. `ask()` begins one and supersedes every ask
 * before it; the ask it returns says whether it's still the newest, which
 * slow work checks after every wait, and stops when it isn't.
 *
 * ```
 *   ask 1 ──▶ current ── ask 2 begins ──▶ superseded (ask 1 stops at its next check)
 * ```
 *
 * Nothing is cancelled: superseded work finishes whatever step it's in, and
 * only what it would do after (show a book, take the player) is left undone.
 */
export class Latest {
  private newest = 0;

  /** Begin an ask, superseding every one before it. */
  ask(): Ask {
    const mine = ++this.newest;
    return { current: () => mine === this.newest };
  }
}

export interface Ask {
  /** No ask has begun since this one. */
  current(): boolean;
}
