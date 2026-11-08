/**
 * How many words a text has, as a word processor counts them: each run of
 * letters or digits is one word, and an apostrophe or hyphen inside a word
 * ("wasn't", "well-known"), or a point or comma inside a number ("3.5",
 * "10,000"), keeps it one. Dashes, quotes and other punctuation on their own
 * are not words.
 *
 * What a book's thickness on the bookcase is worked out from: its EPUB's
 * words, counted once on the server as its sentences are indexed
 * (packages/server/src/library/search.ts), rather than guessed from the
 * file's size or the narration's length.
 */
export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

const WORD = /[\p{L}\p{N}]+(?:(?:['’\-]|[.,](?=\p{N}))[\p{L}\p{N}]+)*/gu;
