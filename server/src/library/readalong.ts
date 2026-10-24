import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bytesToRows, type Row } from "../../../src/core/csv.ts";
import type { Ebook } from "../../../src/core/ebook.ts";
import { BookText } from "../../../src/core/reading/booktext.ts";
import { anchorsOf, heardFromRows, pairBook, pairingFromRows, transcriptAnchors, transcriptFromRows } from "../../../src/core/reading/narration.ts";
import { overlayAnchors } from "../../../src/core/reading/overlay.ts";
import { readAlongOf, type ReadAlong, type ReadAlongCheck } from "../../../src/core/reading/readalong.ts";
import { applyCorrections, buildChapters, rowsToCorrections } from "../../../src/core/scan/chapters.ts";
import { bookDir, type StoredBook } from "./books.ts";
import type { SearchIndex } from "./search.ts";

const run = promisify(execFile);

/** How many books' read-alongs are kept made: the few being read now. */
const KEPT = 8;

/** A book's read-along, made, with the text it was made from, for finding a place in it. */
export interface MadeReadAlong {
  readAlong: ReadAlong;
  text: BookText;
  /** The read-along as it's sent. */
  json: string;
}

/** A read-along that can't be made, said to the person asking. */
export class ReadAlongError extends Error {
  constructor(
    message: string,
    /** 503: this server can't make any; 422: this book's text can't be read. */
    readonly status: 503 | 422,
  ) {
    super(message);
  }
}

/**
 * Read-along for devices that only draw and play (docs/SERVER.md, section
 * 8: the Apple TV): each book's text, parsed by the code the apps parse it
 * with (the `ribbon-ebook` command, src-tauri/ebook), paired with its
 * narration by the code the apps pair it with (src/core/reading/narration.ts),
 * with when each sentence is read (src/core/reading/readalong.ts).
 *
 * Made when a device first asks, and again when the book or a record it
 * carries changes: a transcript coming in, a pairing fixed by hand. The
 * parsed text is kept in the book's folder (`ebook/`), so a book is parsed
 * once; the read-alongs of the books being read are kept in memory. A
 * read-along made from something new is searched from then on (SearchIndex),
 * and how closely it follows the narration is said in the log (`checked`).
 */
export class ReadAlongs {
  private readonly made = new Map<string, { stamp: string; made: MadeReadAlong }>();

  constructor(
    private readonly dataDir: string,
    private readonly tool: string | null,
    private readonly search: SearchIndex | null = null,
    private readonly log: { info(message: string): void } | null = null,
  ) {}

  /** Whether this server can make read-alongs at all. */
  get available(): boolean {
    return this.tool !== null;
  }

  /** A book's read-along as it stands, or null when it has no text, or no audio to read it along with. */
  async of(id: string, stored: StoredBook): Promise<MadeReadAlong | null> {
    if (!this.tool) throw new ReadAlongError("This server can't read EPUBs: the ribbon-ebook command isn't installed (server/README.md).", 503);
    if (!stored.book.ebook || stored.files.length === 0) return null;
    const dir = bookDir(this.dataDir, id);
    const stamp = await this.stamp(id, stored);
    const kept = this.made.get(id);
    this.made.delete(id);
    const made = kept?.stamp === stamp ? kept.made : await this.make(dir, stored);
    if (made !== kept?.made) this.log?.info(`read-along for "${stored.book.title}": ${checked(made.readAlong.check)}`);
    if (this.search && !this.search.isCurrent(id, stamp)) this.search.index(id, stamp, made.readAlong);
    // Most recently asked for last, so the first is the one to let go.
    this.made.set(id, { stamp, made });
    if (this.made.size > KEPT) this.made.delete(this.made.keys().next().value!);
    return made;
  }

  private async make(dir: string, stored: StoredBook): Promise<MadeReadAlong> {
    const text = new BookText(await this.parse(path.join(dir, stored.book.ebook!), path.join(dir, "ebook")));
    const rows = async (kind: string): Promise<Row[]> => (stored.records?.includes(kind) ? (await bytesToRows(await readFile(path.join(dir, "records", `${kind}.csv`)))).rows : []);
    const [pairing, heard, aligned, corrections] = await Promise.all([rows("pairing"), rows("heard"), rows("aligned"), rows("corrections")]);
    const durationMs = stored.book.durationMs;
    // The chapters as a device that downloaded the book has them: the files' own, with the hand corrections carried in.
    const fixes = rowsToCorrections(corrections);
    const chapters = fixes.length > 0 ? applyCorrections(buildChapters(stored.files), fixes, durationMs, stored.files).chapters : stored.chapters;
    const said = heardFromRows(heard);
    const alignment = pairBook(text, chapters, durationMs, {
      fixes: pairingFromRows(pairing),
      heard: said.heard,
      anchors: anchorsOf(said.anchors, transcriptAnchors(transcriptFromRows(aligned).said)),
      overlay: overlayAnchors(text, { files: stored.files.map((f) => ({ path: f.path, durationMs: f.durationMs })), durationMs }),
    });
    const readAlong = readAlongOf(text, alignment);
    return { readAlong, text, json: JSON.stringify(readAlong) };
  }

  /** The book's text, parsed by `ribbon-ebook` and kept in `cache`. */
  private async parse(epub: string, cache: string): Promise<Ebook> {
    try {
      const { stdout } = await run(this.tool!, [epub, cache], { maxBuffer: 256 * 1024 * 1024 });
      return JSON.parse(stdout) as Ebook;
    } catch (e) {
      const said = (e as { stderr?: string }).stderr?.trim();
      throw new ReadAlongError(said ? `This book's EPUB can't be read: ${said}` : "This book's EPUB can't be read.", 422);
    }
  }

  /** What a book's read-along is made from, as it is now: the book's record, its EPUB, its records, and the parser. */
  async stamp(id: string, stored: StoredBook): Promise<string> {
    const dir = bookDir(this.dataDir, id);
    const files = ["book.json", stored.book.ebook!, ...(stored.records ?? []).map((kind) => `records/${kind}.csv`)].map((f) => path.join(dir, f));
    const stamps = await Promise.all([...files, this.tool!].map((f) => stat(f).then((s) => `${s.size}:${s.mtimeMs}`, () => "-")));
    return stamps.join("|");
  }
}

/** How closely a read-along follows its narration, in words: "0% of the sentences read placed to the sentence, the rest by chapter; …". */
export function checked(check: ReadAlongCheck): string {
  const percent = Math.round(check.placed * 100);
  const placed = `${percent}% of the sentences read placed to the sentence${percent < 100 ? ", the rest by chapter" : ""}`;
  const heard = check.heldOut;
  if (!heard) return `${placed}; nothing heard inside chapters to check it against`;
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  return `${placed}; ${heard.moments} moments heard, each left out in turn: ${s(heard.medianMs)} off at the median, ${s(heard.worstMs)} at worst`;
}
