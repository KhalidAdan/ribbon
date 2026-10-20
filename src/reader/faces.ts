import latinNormal from "@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2?url";
import latinExtNormal from "@fontsource-variable/newsreader/files/newsreader-latin-ext-wght-normal.woff2?url";
import latinItalic from "@fontsource-variable/newsreader/files/newsreader-latin-wght-italic.woff2?url";
import latinExtItalic from "@fontsource-variable/newsreader/files/newsreader-latin-ext-wght-italic.woff2?url";

/**
 * The reader's face: Newsreader with only its weight axis, under its own
 * name. The app's Newsreader has an optical-size axis, which the page
 * applies by size and a canvas may not; pretext measures on a canvas, so
 * the reader uses a face that measures and draws the same everywhere.
 *
 * Defined once, here, and loaded the same way in two places: the page,
 * which draws with it, and the layout worker, which measures with it
 * (layout.worker.ts). Measuring and drawing then cannot disagree.
 */
export const FAMILY_NAME = "Ribbon Text";

const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT = "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

const FACES = [
  { url: latinExtNormal, style: "normal", range: LATIN_EXT },
  { url: latinNormal, style: "normal", range: LATIN },
  { url: latinExtItalic, style: "italic", range: LATIN_EXT },
  { url: latinItalic, style: "italic", range: LATIN },
];

/** Add the reader's faces to a page's or a worker's fonts and load them. Resolves when they can be used. */
export async function addFaces(fonts: FontFaceSet): Promise<void> {
  await Promise.all(
    FACES.map(async (f) => {
      const face = new FontFace(FAMILY_NAME, `url("${new URL(f.url, globalThis.location?.href).href}") format("woff2-variations")`, { style: f.style, weight: "200 800", display: "block", unicodeRange: f.range });
      fonts.add(face);
      await face.load().catch(() => undefined);
    }),
  );
}
