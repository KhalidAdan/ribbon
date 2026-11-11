/**
 * Work that runs one at a time, and once more when it's asked for while it
 * runs (docs/STATE-MACHINES.md): a folder's scan. An ask while it runs isn't
 * lost, and isn't a second run beside the first: it's one more run after,
 * which every ask made meanwhile shares, with what each asked for merged,
 * and waits for. So whoever asks gets a run that began after they asked.
 *
 * ```
 *   idle ── ask ──▶ running ── ask ──▶ running, again after ── it ends ──▶ running (the again) ── it ends ──▶ idle
 *                      └──────────────────── it ends ────────────────────▶ idle
 * ```
 */
export class Rerun<A> {
  private state: { status: "idle" } | { status: "running"; again: { asked: A; done: Promise<void>; go: () => void } | null } = { status: "idle" };

  /**
   * `run` is the work, given what was asked; `merge` puts two asks for the
   * same run together; `idle` is told when the last run ends with nothing
   * asked after it, and whether it ended well.
   */
  constructor(
    private readonly run: (asked: A) => Promise<void>,
    private readonly merge: (a: A, b: A) => A,
    private readonly idle: (ok: boolean) => void = () => undefined,
  ) {}

  /** A run is under way. */
  get running(): boolean {
    return this.state.status === "running";
  }

  /**
   * Ask for a run. Idle, it begins now; running, one more run follows this
   * one. Resolves when the run that began after the ask has ended, or
   * rejects with what it threw.
   */
  ask(asked: A): Promise<void> {
    const s = this.state;
    if (s.status === "idle") return this.begin(asked);
    if (s.again) {
      s.again.asked = this.merge(s.again.asked, asked);
      return s.again.done;
    }
    let go = () => {};
    const started = new Promise<void>((resolve) => (go = resolve));
    const again: { asked: A; done: Promise<void>; go: () => void } = { asked, done: Promise.resolve(), go };
    // The run after begins once this one ends; until then the asks made meanwhile gather in it.
    again.done = started.then(() => this.begin(again.asked));
    s.again = again;
    return again.done;
  }

  private begin(asked: A): Promise<void> {
    this.state = { status: "running", again: null };
    const ran = this.run(asked);
    ran.then(
      () => this.ended(true),
      () => this.ended(false),
    );
    return ran;
  }

  private ended(ok: boolean): void {
    const s = this.state;
    if (s.status === "running" && s.again) {
      s.again.go();
      return;
    }
    this.state = { status: "idle" };
    this.idle(ok);
  }
}
