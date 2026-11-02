/** What a check found: each expectation passed or failed, and figures worth reading beside them. */
export class Tally {
  readonly failures: string[] = [];
  private passed = 0;

  constructor(private readonly check: string) {}

  /** An expectation: it holds, or the run fails saying so. */
  expect(holds: boolean, what: string, detail = ""): void {
    const line = `${what}${detail ? ` (${detail})` : ""}`;
    if (holds) {
      this.passed++;
      console.log(`  ✓ ${line}`);
    } else {
      this.failures.push(`${this.check}: ${line}`);
      console.log(`  ✗ ${line}`);
    }
  }

  /** A figure to read, not to judge: how long something took. */
  note(what: string): void {
    console.log(`  · ${what}`);
  }

  get summary(): string {
    return `${this.passed} passed, ${this.failures.length} failed`;
  }
}
