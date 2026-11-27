import type { ReleaseNotes } from "@ribbon/core/whats-new";

/**
 * What changed in each version, the newest first: what Ribbon shows after it
 * has updated itself, and under Settings (ui/WhatsNew.tsx). A release adds
 * its own at the top (docs/RELEASING.md, section 3), in the words of its
 * notes on GitHub, cut to the lines someone would notice. Only the last few
 * versions are kept.
 */
export const RELEASES: readonly ReleaseNotes[] = [
  {
    version: "0.54.0",
    points: [
      "Press ? for every key Ribbon answers to.",
      "After Ribbon updates itself, it says what changed. That's this.",
      "An author's or a narrator's name on a book's page leads to everything of theirs you have.",
    ],
  },
  {
    version: "0.53.0",
    points: [
      "The bookcase opens without loading your covers: only the cover of the book in hand is fetched, and it comes into focus as it arrives.",
      "On the bookcase the arrow keys go from book to book, and carry on from a shelf's end to the next shelf.",
    ],
  },
  {
    version: "0.52.0",
    points: [
      "A comic keeps details of its own: its issue or volume, who wrote, drew, inked, coloured and lettered it, its cover date and its story arcs.",
      "ComicVine can fill a comic's details in, when you turn it on in Settings.",
      "The form for editing a book asks only what its kind of book has.",
    ],
  },
];
