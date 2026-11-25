import type { WebPdf } from "./pdf";

/**
 * The PDF a comic reader draws from (docs/COMICS.md, section 12), opened
 * once and shared by everything that draws out of it: the pages, and the
 * strip of small pages. Opened when first taken; closed when the last to
 * take it lets go, once what each was still drawing has finished, since a
 * page drawn out of a closed PDF fails.
 */
export class SharedPdf {
  private opened: Promise<WebPdf> | null = null;
  private users = 0;
  private draining: Promise<unknown>[] = [];

  constructor(private readonly where: { url: string; bytes: number }) {}

  /** The PDF, opened now when nobody has it open. pdf.js itself is fetched with the first PDF. */
  take(): Promise<WebPdf> {
    this.users++;
    if (!this.opened) {
      const { url, bytes } = this.where;
      this.opened = import("./pdf").then((m) => m.openWebPdf(url, bytes));
      this.opened.catch(() => undefined);
    }
    return this.opened;
  }

  /** Done with it, once `after` has settled. The last to let go closes it. */
  letGo(after: Promise<unknown> = Promise.resolve()): void {
    this.users--;
    this.draining.push(after);
    if (this.users > 0) return;
    const [opened, draining] = [this.opened, this.draining];
    this.opened = null;
    this.draining = [];
    void Promise.allSettled(draining).then(() => opened?.then((pdf) => pdf.close(), () => undefined));
  }
}
