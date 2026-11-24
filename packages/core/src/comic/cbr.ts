/**
 * A CBR (docs/COMICS.md, section 13): a comic whose pages are in a RAR
 * archive rather than a zip. Its pages, their order and its limits are a
 * CBZ's (pages.ts); a host lists it and reads one entry by name, as it
 * does a zip. What is a CBR's alone is here: how one is told from a zip,
 * and the two kinds Ribbon refuses.
 */

/** How every RAR archive starts: "Rar!", then two bytes that never change. */
const RAR_START = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];

/**
 * True when a file's first bytes are a RAR archive's. A file is what it
 * starts as, not what it is called: comics named .cbr are often zips, and
 * some named .cbz are RARs.
 */
export function startsAsRar(start: Uint8Array): boolean {
  return start.length >= RAR_START.length && RAR_START.every((byte, i) => start[i] === byte);
}

/**
 * Why a CBR is refused. Every host says it in these words (Rust's are in
 * `packages/desktop/src-tauri/cbr/src/lib.rs`, checked against these), so
 * the sentence a person reads is the same wherever the comic was opened.
 */
export const CBR_REFUSALS = {
  /** Its pages are encrypted: the same line as AAX and locked EPUBs. */
  locked: "It is locked with a password, and Ribbon opens only comics that aren't.",
  /** One comic cut into several files: Ribbon reads a book from one. */
  split: "It is one part of an archive split across several files, and Ribbon reads a comic from one file.",
} as const;

/** The sentence, when what a host threw on opening a comic is one of the refusals; null for anything else. */
export function cbrRefusal(thrown: unknown): string | null {
  const said = thrown instanceof Error ? thrown.message : String(thrown);
  return Object.values(CBR_REFUSALS).find((sentence) => said.includes(sentence)) ?? null;
}
