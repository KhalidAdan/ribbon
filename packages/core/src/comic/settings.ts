import type { PagesUp } from "./session";

/** How comics are shown on this machine: kept with the app's settings, the same for every comic. */
export interface ComicSettings {
  /** One page at a time, or two as a printed comic opens. */
  up: PagesUp;
  /** The whole page in the window, or the page as wide as the window, scrolled down. */
  fit: "page" | "width";
}

export const COMIC_DEFAULTS: ComicSettings = { up: "one", fit: "page" };

/** The settings as kept, with anything missing or unknown at its default. */
export function parseComicSettings(v: unknown): ComicSettings {
  const kept = (typeof v === "object" && v !== null ? v : {}) as Partial<Record<keyof ComicSettings, unknown>>;
  return { up: kept.up === "two" ? "two" : COMIC_DEFAULTS.up, fit: kept.fit === "width" ? "width" : COMIC_DEFAULTS.fit };
}

/** Which comics are read right to left, where a person said so: by book id, over what the comic's own details say. */
export function parseDirections(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, rtl] of Object.entries(v as Record<string, unknown>)) if (typeof rtl === "boolean") out[id] = rtl;
  return out;
}
