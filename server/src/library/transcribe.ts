import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, setPriority } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { wordIndex, type WordAt } from "../../../src/core/reading/anchors.ts";
import type { BookText } from "../../../src/core/reading/booktext.ts";
import { transcriptFromRows, transcriptRows } from "../../../src/core/reading/narration.ts";
import { narrationLanguage, placeStretch, STRETCH_MS, stretchesOf, type PlacedPhrase, type Said, type Stretch } from "../../../src/core/reading/transcript.ts";
import type { Jobs } from "../jobs.ts";
import { bookDir, type BookIndex, type StoredBook } from "./books.ts";
import { readStored } from "./prepare.ts";
import { stateOf, type MadeReadAlong, type ReadAlongs, type Standing } from "./readalong.ts";
import { keepHeard, recordRows } from "./records.ts";

/** Minutes of narration heard to a call; then the next book is chosen again, so a book someone opens goes to the front. */
const PER_CALL = 8;

/** How the server hears: the `ribbon-speech` command (src-tauri/speech), the whisper model, and how many threads it may take. */
export interface SpeechConfig {
  tool: string;
  model: string;
  threads: number;
}

/** How transcribing is going, as the job keeps it. */
export interface TranscribeProgress {
  /** The book being transcribed, and how much of its narration is: stretches done, of all. */
  book: string | null;
  done: number;
  total: number;
  /** Minutes of narration heard since the job started, and how long that took: this machine's pace. */
  minutes: number;
  tookMs: number;
}

/**
 * The narration transcribed on the server, the last stage of preparing a
 * book (docs/SERVER.md, section 9): each book's audio heard a minute at a
 * time by `ribbon-speech`, the apps' own hearing, and each phrase placed in
 * the text by the apps' own code (src/core/reading/transcript.ts). What's
 * heard is merged into the book's `records/aligned.csv` with what devices
 * sent (records.ts), so the TV reads along to the sentence and a device that
 * downloads the book has the transcript with it.
 *
 * One job, in a lane of its own, that runs until there's nothing left to
 * hear: hours a book on a slow machine, so adding a folder never waits on
 * it. After every few minutes of narration it chooses again: a book someone
 * opened goes first, from where they are, then the newest. It runs behind
 * everything else on the machine, on as many threads as it's given. A
 * stretch already transcribed, here or on a device, is never heard again.
 */
export class Transcriber {
  /** The books someone opened, the latest last, with where they were when known. */
  private readonly wanted = new Map<string, number | null>();
  /** Books with nothing left to hear, or nothing to hear at all. */
  private readonly finished = new Set<string>();
  /** Stretches that couldn't be heard this run, by book and start: tried again on the next. */
  private readonly failed = new Set<string>();
  /** Books heard in since the server started, and the books whose standing has been said in the log. */
  private readonly heardIn = new Set<string>();
  private readonly told = new Set<string>();
  private running = false;
  private again = false;
  private stopped = false;
  private listener: Listener | null = null;
  private index: { text: BookText; words: WordAt[] } | null = null;

  constructor(
    private readonly deps: { dataDir: string; books: BookIndex; readAlongs: ReadAlongs; speech: SpeechConfig | null; log?: { info(message: string): void; warn(message: string): void } },
  ) {}

  /** Whether this server can transcribe: it has the command, a model, and can read EPUBs. */
  get available(): boolean {
    return this.deps.speech !== null && this.deps.readAlongs.available;
  }

  /** Someone opened a book, and is at `ms` of it when that's known: it's heard next, from there on. */
  want(id: string, ms: number | null = null): void {
    const known = ms ?? this.wanted.get(id) ?? null;
    this.wanted.delete(id);
    this.wanted.set(id, known);
  }

  /** Hear whatever's left in the library, as a job, unless one is hearing already; a book added since it looked is found either way. */
  start(jobs: Jobs): void {
    if (!this.available || this.stopped) return;
    this.finished.clear();
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    const first: TranscribeProgress = { book: null, done: 0, total: 0, minutes: 0, tookMs: 0 };
    jobs.start<TranscribeProgress>("transcribe", first, (report) => this.run(first, report).finally(() => (this.running = false)), null, "speech");
  }

  /** Stop hearing: the stretches being heard are let go, and everything kept stays. */
  stop(): void {
    this.stopped = true;
    this.listener?.close(true);
  }

  private async run(progress: TranscribeProgress, report: (p: TranscribeProgress) => void): Promise<TranscribeProgress> {
    try {
      for (;;) {
        const next = this.stopped ? null : await this.next();
        if (!next) {
          if (!this.again || this.stopped) break;
          this.again = false;
          continue;
        }
        const t0 = Date.now();
        const heard = await this.hear(next);
        progress.book = next.stored.book.title;
        progress.done = next.done + heard;
        progress.total = next.total;
        progress.minutes += heard;
        progress.tookMs += Date.now() - t0;
        report(progress);
      }
    } finally {
      this.listener?.close();
      this.listener = null;
    }
    progress.book = null;
    return progress;
  }

  /** The next stretches to hear: the book someone opened last that has some left, else the newest. */
  private async next(): Promise<{ id: string; stored: StoredBook; made: MadeReadAlong; todo: Stretch[]; done: number; total: number } | null> {
    const newest = this.deps.books
      .list()
      .map((b) => b.id)
      .reverse();
    for (const id of new Set([...[...this.wanted.keys()].reverse(), ...newest])) {
      if (this.finished.has(id) || !this.deps.books.has(id)) continue;
      const stored = await readStored(this.deps.dataDir, id);
      // A book with no text to place the words in, or whose EPUB can't be read, or that reads along by its own Media Overlay, has nothing to hear.
      const made = stored?.book.ebook && stored.files.length > 0 ? await this.deps.readAlongs.of(id, stored).catch(() => null) : null;
      if (!stored || !made || made.alignment.how !== "chapter") {
        if (stored && made) this.tell(id, stored.book.title, made.standing);
        this.finished.add(id);
        continue;
      }
      const spans = transcriptFromRows(await recordRows(this.deps.dataDir, id, "aligned")).spans;
      const all = stretchesOf(stored.files);
      const todo = all.filter((x) => !spans.has(x.startMs) && !this.failed.has(`${id}@${x.startMs}`));
      if (todo.length === 0) {
        this.tell(id, stored.book.title, made.standing);
        this.finished.add(id);
        continue;
      }
      // From a minute before where they are onward, then what's behind them, nearest first: as a device hears it.
      const focus = this.wanted.get(id) ?? null;
      if (focus !== null) {
        const key = (x: Stretch) => (x.startMs >= focus - STRETCH_MS ? x.startMs - focus : 2 * (focus - x.startMs));
        todo.sort((a, b) => key(a) - key(b));
      }
      return { id, stored, made, todo, done: all.length - todo.length, total: all.length };
    }
    return null;
  }


  /**
   * Say once how a book there's nothing left to hear in reads along. One
   * still by chapter needs a person (docs/SERVER.md, section 9): it's never
   * left to be found on the TV.
   */
  private tell(id: string, title: string, standing: Standing): void {
    if (this.told.has(id)) return;
    const percent = Math.round(standing.check.placed * 100);
    const state = stateOf(standing, true);
    if (state === "flagged") this.deps.log?.warn(`"${title}" is transcribed and still reads along by chapter (${percent}% to the sentence): its EPUB and audiobook may be different editions, or its pairing needs fixing`);
    else if (state === "unpaired") this.deps.log?.warn(`"${title}" reads along by chapter: its text and narration didn't pair, so nothing heard can be placed; its pairing needs fixing`);
    else if (state === "sentence" && this.heardIn.has(id)) this.deps.log?.info(`"${title}" is transcribed, and reads along by sentence (${percent}%)`);
    else return;
    this.told.add(id);
  }

  /** Hear a few of a book's stretches, place what was said in its text, and keep it. How many were heard. */
  private async hear(next: { id: string; stored: StoredBook; made: MadeReadAlong; todo: Stretch[] }): Promise<number> {
    const { id, stored, made } = next;
    const speech = this.deps.speech!;
    const language = narrationLanguage(made.text.ebook.meta.language, stored.book.language);
    if (this.listener?.language !== language) {
      this.listener?.close();
      this.listener = new Listener(speech, language);
    }
    const batch = next.todo.slice(0, PER_CALL);
    const dir = bookDir(this.deps.dataDir, id);
    const answers = await this.listener.hear(batch.map((x) => ({ path: path.join(dir, ...stored.files[x.file]!.path.split("/")), startMs: x.offset })));
    if (this.index?.text !== made.text) this.index = { text: made.text, words: wordIndex(made.text) };
    const spans = new Map<number, number>();
    const said: PlacedPhrase[] = [];
    batch.forEach((x, i) => {
      const answer = answers[i];
      if (!Array.isArray(answer)) {
        this.failed.add(`${id}@${x.startMs}`);
        this.deps.log?.warn(`could not hear "${stored.book.title}" at ${x.startMs} ms: ${answer?.error ?? "no answer"}`);
        return;
      }
      spans.set(x.startMs, x.endMs);
      // The file's times, as the book's.
      const shift = x.startMs - x.offset;
      const phrases = answer.map((s) => ({ startMs: s.startMs + shift, endMs: s.endMs + shift, words: s.words.trim() })).filter((s) => s.words);
      said.push(...placeStretch(this.index!.words, made.alignment, x, phrases).said);
    });
    if (spans.size > 0) await keepHeard(this.deps.dataDir, id, "aligned", transcriptRows({ spans, said }));
    this.heardIn.add(id);
    return spans.size;
  }
}

/** What `ribbon-speech` answers for a clip: the phrases heard, with times in milliseconds of its file, or why it couldn't. */
type Heard = Said[] | { error: string };

/**
 * The `ribbon-speech` command, running for as long as there's narration
 * to hear, so the model is loaded once: a batch of clips goes in as a
 * line, and a line comes back with what was heard of each. Behind
 * everything else on the machine: the lowest priority it can be given.
 */
class Listener {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly answers: ((line: string | null) => void)[] = [];
  private said = "";

  constructor(
    speech: SpeechConfig,
    readonly language: string | null,
  ) {
    this.child = spawn(speech.tool, [speech.model, String(STRETCH_MS / 1000), language ?? "auto", "1", String(speech.threads)]);
    try {
      setPriority(this.child.pid!, constants.priority.PRIORITY_LOW);
    } catch {
      // Not allowed here, or the command didn't start (said below): it hears at the usual priority.
    }
    this.child.stderr.on("data", (b: Buffer) => (this.said = (this.said + b.toString()).slice(-2000)));
    this.child.on("error", (e) => (this.said = e.message));
    // A command that died is said by its answers: a write after that mustn't take the server with it.
    this.child.stdin.on("error", () => undefined);
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.answers.shift()?.(line));
    this.lines.on("close", () => this.answers.splice(0).forEach((answer) => answer(null)));
  }

  /** What was heard of each clip, in order. */
  hear(clips: { path: string; startMs: number }[]): Promise<Heard[]> {
    return new Promise((resolve, reject) => {
      this.answers.push((line) => {
        if (line === null) return reject(new Error(`ribbon-speech stopped: ${this.said.trim().split("\n").at(-1) ?? "no reason given"}`));
        const answer = JSON.parse(line) as Heard[] | { error: string };
        if (!Array.isArray(answer)) return reject(new Error(`ribbon-speech refused the clips: ${answer.error}`));
        resolve(answer);
      });
      this.child.stdin.write(`${JSON.stringify(clips)}\n`);
    });
  }

  /** Done with it: it lets the model go and ends. `now`: without waiting for the batch it's hearing, which takes minutes on a slow machine. */
  close(now = false): void {
    this.child.stdin.end();
    if (now) this.child.kill();
  }
}
