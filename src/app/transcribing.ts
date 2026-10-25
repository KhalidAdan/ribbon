import type { Alignment } from "../core/reading/align";
import type { WordAt } from "../core/reading/anchors";
import { placeStretch, stretchesOf, type PlacedPhrase, type Said } from "../core/reading/transcript";

/**
 * A book's narration transcribed whole (#152): every minute of it, from the
 * start of its first file to the end of its last, in order, heard by the
 * speech model on a machine with a graphics card and matched to the text as
 * it comes. The same for the book open in the reader and for a server's
 * books transcribed in the background, so a transcript is made one way.
 *
 * A minute that couldn't be heard isn't kept, so it's heard again; one heard
 * to have nothing in it is kept as that, with the model that heard it, so
 * the two are never confused. A transcript is whole when every minute is
 * kept, and only then does the book read along.
 */

/** Minutes heard in one call to the speech model. */
export const MINUTES_PER_CALL = 8;

/** What a book's transcript is kept in as it grows: the minutes transcribed, which model heard each, every phrase and where it was found. */
export interface TranscriptSoFar {
  spans: Map<number, number>;
  heardBy: Map<number, string>;
  said: PlacedPhrase[];
  aligned: Map<number, number>;
  dirty: boolean;
}

export interface Transcription {
  transcript: TranscriptSoFar;
  /** The book's audio files, each with where it is on this machine. */
  files: readonly { path: string; durationMs: number }[];
  /** The text's words, to find what's heard in. */
  index: readonly WordAt[];
  /** The text paired with the audio as it is now: where to look for each minute's words. */
  alignment: () => Alignment;
  /** Hear clips of the audio, a minute from each start: each one's phrases, or null when it couldn't be heard. */
  hear: (clips: { path: string; startMs: number }[]) => Promise<(Said[] | null)[]>;
  /** The model that hears, by its file's name (`ggml-small-q5_1`): kept with each minute. */
  model: string;
  /** Keep what's transcribed so far: called after every few minutes. */
  keep: () => Promise<void>;
  /** How far it has got: minutes transcribed, of all. */
  progress: (done: number, total: number) => void;
  /** Whether to go on: false once the book is closed, or another needs the model. */
  still: () => boolean;
}

/**
 * Transcribe what's left of a book's narration, from the first minute not
 * yet transcribed to the end. `whole` when every minute is; `stopped` when
 * `still` said to stop; `failed` when a whole call's minutes couldn't be
 * heard, rather than going round again (the next try starts where this one
 * stopped).
 */
export async function transcribeWhole(t: Transcription): Promise<"whole" | "stopped" | "failed"> {
  const all = stretchesOf(t.files);
  const { transcript } = t;
  for (;;) {
    const left = all.filter((x) => !transcript.spans.has(x.startMs));
    t.progress(all.length - left.length, all.length);
    if (left.length === 0) return "whole";
    if (!t.still()) return "stopped";
    const batch = left.slice(0, MINUTES_PER_CALL);
    const said = await t.hear(batch.map((x) => ({ path: t.files[x.file]!.path, startMs: x.offset })));
    const alignment = t.alignment();
    let heard = 0;
    batch.forEach((x, i) => {
      const phrases = said[i];
      // Couldn't be heard: not kept, so it's heard again.
      if (!phrases) return;
      heard++;
      transcript.spans.set(x.startMs, x.endMs);
      transcript.heardBy.set(x.startMs, t.model);
      transcript.dirty = true;
      // The file's times, as the book's.
      const shift = x.startMs - x.offset;
      const inBook = phrases
        .map((s) => ({ startMs: s.startMs + shift, endMs: s.endMs + shift, words: s.words.trim(), ...(s.wordMs ? { wordMs: s.wordMs.map((w) => w + shift) } : {}) }))
        .filter((s) => s.words);
      if (inBook.length === 0) return;
      const placed = placeStretch(t.index, alignment, x, inBook);
      for (const an of placed.anchors) transcript.aligned.set(an.ms, an.chars);
      transcript.said.push(...placed.said);
    });
    await t.keep();
    if (heard === 0) return "failed";
  }
}

/** A speech model's name, as kept with each minute it heard: its file's name without the extension. */
export function modelName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.bin$/i, "");
}
