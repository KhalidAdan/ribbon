import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Ebook } from "../../../src/core/ebook.ts";
import type { Alignment } from "../../../src/core/reading/align.ts";
import { BookText } from "../../../src/core/reading/booktext.ts";
import { anchorsOf, heardFromRows, pairBook, pairingFromRows, transcriptAnchors, transcriptFromRows, type Narration } from "../../../src/core/reading/narration.ts";
import { overlayAnchors } from "../../../src/core/reading/overlay.ts";
import { BY_SENTENCE, readAlongOf, type ReadAlong, type ReadAlongCheck } from "../../../src/core/reading/readalong.ts";
import { stretchesOf } from "../../../src/core/reading/transcript.ts";
import { bookDir, type StoredBook } from "./books.ts";
import { chaptersWith, correctionsOf, recordRows } from "./chapters.ts";
import type { SearchIndex } from "./search.ts";

const run = promisify(execFile);

/** How many books' read-alongs are kept made: the few being read now. */
const KEPT = 8;

/** A book's read-along, made, with the text it was made from, for finding a place in it, and how that text pairs with the narration. */
export interface MadeReadAlong {
  readAlong: ReadAlong;
  text: BookText;
  alignment: Alignment;
  /** The read-along as it's sent. */
  json: string;
  /** How it reads along, as it was made. */
  standing: Standing;
}

/** How a book reads along: how closely it follows the narration, how it was paired, and how much of the narration is transcribed (minutes of it). */
export interface Standing {
  check: ReadAlongCheck;
  pairedBy: Alignment["how"];
  transcribed: { done: number; total: number };
}

/**
 * Where a book stands, for the admin (docs/SERVER.md, section 9):
 * - `sentence`: it reads along by sentence.
 * - `waiting`: read only, until a device with a graphics card sends its whole transcript.
 * - `unpaired`: its text and narration didn't pair by chapter, so nothing heard can be placed: fix its pairing.
 * - `flagged`: its narration is transcribed and it still doesn't read along by sentence: a different edition, or a pairing to fix.
 */
export type ReadAlongState = "sentence" | "waiting" | "unpaired" | "flagged";

/** Where a book stands (ReadAlongState). */
export function stateOf(s: Standing): ReadAlongState {
  if (s.pairedBy !== "overlay" && s.transcribed.done < s.transcribed.total) return "waiting";
  if (s.check.placed >= BY_SENTENCE) return "sentence";
  if (s.pairedBy === "proportion") return "unpaired";
  return "flagged";
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

  /** How each book read along as it was last made, with what it was made from: two numbers a book, kept for every book. */
  private readonly standings = new Map<string, { stamp: string; standing: Standing }>();

  /**
   * How a book reads along now: as it was last made, or made again when
   * something it's made from changed since (a transcript came in); or why
   * it can't be made.
   */
  async standing(id: string, stored: StoredBook): Promise<Standing | string> {
    const kept = this.standings.get(id);
    if (kept && kept.stamp === (await this.stamp(id, stored))) return kept.standing;
    try {
      return (await this.of(id, stored))?.standing ?? "It has no text, or no narration, to read along.";
    } catch (e) {
      if (e instanceof ReadAlongError) return e.message;
      throw e;
    }
  }

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
    this.standings.set(id, { stamp, standing: made.standing });
    if (this.search && !this.search.isCurrent(id, stamp)) this.search.index(id, stamp, made.readAlong);
    // Most recently asked for last, so the first is the one to let go.
    this.made.set(id, { stamp, made });
    if (this.made.size > KEPT) this.made.delete(this.made.keys().next().value!);
    return made;
  }

  private async make(dir: string, stored: StoredBook): Promise<MadeReadAlong> {
    const text = new BookText(await this.parse(dir, stored));
    // The chapters as a device that downloaded the book has them (chapters.ts).
    const chapters = chaptersWith(stored, await correctionsOf(dir, stored));
    const alignment = pairBook(text, chapters, stored.book.durationMs, await narrationOf(dir, stored, text));
    const spans = transcriptFromRows(await recordRows(dir, stored, "aligned")).spans;
    const stretches = stretchesOf(stored.files);
    const transcribed = { done: stretches.filter((x) => spans.has(x.startMs)).length, total: stretches.length };
    const readAlong = readAlongOf(text, alignment, transcribed);
    return { readAlong, text, alignment, json: JSON.stringify(readAlong), standing: { check: readAlong.check, pairedBy: alignment.how, transcribed } };
  }

  /** A book's EPUB as `ribbon-ebook` reads it: its text and what its package says. */
  async ebook(id: string, stored: StoredBook): Promise<Ebook> {
    if (!this.tool) throw new ReadAlongError("This server can't read EPUBs: the ribbon-ebook command isn't installed (server/README.md).", 503);
    return this.parse(bookDir(this.dataDir, id), stored);
  }

  /** The book's EPUB, parsed by `ribbon-ebook` and kept in its folder (`ebook/`), so it's parsed once. */
  private async parse(dir: string, stored: StoredBook): Promise<Ebook> {
    try {
      const { stdout } = await run(this.tool!, [path.join(dir, stored.book.ebook!), path.join(dir, "ebook")], { maxBuffer: 256 * 1024 * 1024 });
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

/** What the book's records say about its narration (src/core/reading/narration.ts): pairings set by hand, what was heard of it, its transcript, and its own Media Overlay. */
export async function narrationOf(dir: string, stored: StoredBook, text: BookText): Promise<Narration> {
  const [pairing, heard, aligned] = await Promise.all([recordRows(dir, stored, "pairing"), recordRows(dir, stored, "heard"), recordRows(dir, stored, "aligned")]);
  const said = heardFromRows(heard);
  return {
    fixes: pairingFromRows(pairing),
    heard: said.heard,
    anchors: anchorsOf(said.anchors, transcriptAnchors(transcriptFromRows(aligned).said)),
    overlay: overlayAnchors(text, { files: stored.files.map((f) => ({ path: f.path, durationMs: f.durationMs })), durationMs: stored.book.durationMs }),
  };
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
