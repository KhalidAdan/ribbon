import type { PagesUp } from "./session";
import { COLUMNS } from "./scroll";
import type { Fit } from "./size";

/**
 * What is behind the page (docs/COMICS.md, section 15): Ribbon's own ground,
 * the light or dark of the app, or black, grey or white.
 */
export type Ground = "ribbon" | "black" | "grey" | "white";

/** The grounds in the order `B` goes through them. */
export const GROUNDS: readonly Ground[] = ["ribbon", "black", "grey", "white"];

/** The ground after this one, round again after white. */
export function nextGround(ground: Ground): Ground {
  return GROUNDS[(GROUNDS.indexOf(ground) + 1) % GROUNDS.length]!;
}

/** How comics are shown on this machine: kept with the app's settings, the same for every comic. */
export interface ComicSettings {
  /** One page at a time, or two as a printed comic opens. */
  up: PagesUp;
  /** The whole page in the window; the page as wide as the window, scrolled down; or as tall as it, a wide page moved sideways. */
  fit: Fit;
  /** The strip of small pages along the foot (comic/strip.ts): hidden until asked for. */
  strip: boolean;
  /** What is behind the page: Ribbon's own until someone chooses, so no screen changes until then. */
  ground: Ground;
  /** One long scroll (comic/scroll.ts), rather than pages turned: for every comic, until a person says otherwise. */
  scroll: boolean;
  /** How wide the long scroll's column is, as a part of the window (one of `COLUMNS`). */
  column: number;
}

export const COMIC_DEFAULTS: ComicSettings = { up: "one", fit: "page", strip: false, ground: "ribbon", scroll: false, column: 1 };

/** The settings as kept, with anything missing or unknown at its default. */
export function parseComicSettings(v: unknown): ComicSettings {
  const kept = (typeof v === "object" && v !== null ? v : {}) as Partial<Record<keyof ComicSettings, unknown>>;
  return {
    up: kept.up === "two" ? "two" : COMIC_DEFAULTS.up,
    fit: kept.fit === "width" || kept.fit === "height" ? kept.fit : COMIC_DEFAULTS.fit,
    strip: typeof kept.strip === "boolean" ? kept.strip : COMIC_DEFAULTS.strip,
    ground: GROUNDS.includes(kept.ground as Ground) ? (kept.ground as Ground) : COMIC_DEFAULTS.ground,
    scroll: typeof kept.scroll === "boolean" ? kept.scroll : COMIC_DEFAULTS.scroll,
    column: COLUMNS.includes(kept.column as number) ? (kept.column as number) : COMIC_DEFAULTS.column,
  };
}

/** Which comics are read right to left, where a person said so: by book id, over what the comic's own details say. */
export function parseDirections(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, rtl] of Object.entries(v as Record<string, unknown>)) if (typeof rtl === "boolean") out[id] = rtl;
  return out;
}
