/**
 * The reader's typography: a few steps of size, spacing and width, pages
 * or scrolling, justified or not. Kept per device in the app's settings.
 */

export interface ReadingSettings {
  /** Index into SIZES. */
  size: number;
  /** Index into LEADINGS. */
  spacing: number;
  /** Index into MEASURES. */
  width: number;
  layout: "pages" | "scroll";
  justify: boolean;
  /** Read-along: mark the sentence being read while following the narrator. */
  highlight: boolean;
}

/** Text sizes in CSS pixels. */
export const SIZES = [16, 17.5, 19, 21, 23.5, 26];
/** Line height as a multiple of the size. */
export const LEADINGS = [1.45, 1.6, 1.75];
/** The widest a column of text gets, in ems: about 60, 70 and 85 characters. */
export const MEASURES = [27, 32, 38];

export const DEFAULT_READING: ReadingSettings = { size: 2, spacing: 1, width: 1, layout: "pages", justify: true, highlight: true };

const within = (v: unknown, list: readonly unknown[], fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < list.length ? v : fallback);

export function parseReading(v: unknown): ReadingSettings {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return {
    size: within(o.size, SIZES, DEFAULT_READING.size),
    spacing: within(o.spacing, LEADINGS, DEFAULT_READING.spacing),
    width: within(o.width, MEASURES, DEFAULT_READING.width),
    layout: o.layout === "scroll" ? "scroll" : "pages",
    justify: o.justify !== false,
    highlight: o.highlight !== false,
  };
}

export interface Metrics {
  size: number;
  lineHeight: number;
  /** Width of one column of text, px. */
  column: number;
  /** Columns side by side: two on a wide window in pages, else one. */
  columns: 1 | 2;
  gap: number;
  /** Height of a page of text, px. */
  pageHeight: number;
  /** Room above and below the text. */
  margin: number;
}

/** How the text is set in a viewport of this size. */
export function metricsFor(s: ReadingSettings, viewport: { width: number; height: number }): Metrics {
  const size = SIZES[s.size]!;
  const lineHeight = Math.round(size * LEADINGS[s.spacing]!);
  const measure = Math.round(MEASURES[s.width]! * size);
  const side = Math.max(16, Math.round(viewport.width * 0.05));
  const gap = Math.round(size * 3);
  const room = Math.max(160, viewport.width - 2 * side);
  // Two pages side by side once each can be most of a full measure.
  const columns: 1 | 2 = s.layout === "pages" && room >= 2 * measure * 0.85 + gap ? 2 : 1;
  const column = Math.min(measure, columns === 2 ? Math.floor((room - gap) / 2) : room);
  const margin = Math.max(24, Math.round(lineHeight * 1.25));
  const pageHeight = Math.max(lineHeight * 4, viewport.height - 2 * margin);
  return { size, lineHeight, column, columns, gap, pageHeight, margin };
}
