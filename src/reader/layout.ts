import { flow, paginate, type Flow, type LaidBlock, type Page } from "../core/reading/pages";
import type { Metrics } from "../core/reading/typography";
import type { Typesetter } from "./typeset";

/**
 * One chapter laid out for the page: its blocks set in lines (pretext),
 * those lines in pages, and in one long column for scrolling. The same
 * function runs in the layout worker and, where no worker can run, on the
 * page itself (layout-engine.ts).
 */
export interface SectionLayout {
  blocks: LaidBlock[];
  pages: Page[];
  flow: Flow;
}

/** Everything a layout depends on besides the book: when any of it changes, every chapter is laid out again. */
export interface LayoutSpec {
  metrics: Metrics;
  justify: boolean;
}

export function specKey(s: LayoutSpec): string {
  const m = s.metrics;
  return `${m.size}:${m.lineHeight}:${m.column}:${m.pageHeight}:${s.justify}`;
}

/** Lay out one chapter. */
export function layOutSection(typesetter: Typesetter, section: number, spec: LayoutSpec): SectionLayout {
  const { metrics: m, justify } = spec;
  const blocks = typesetter.section(section, m, justify);
  // A chapter's opening sinks a little down its first page, as books set them.
  return { blocks, pages: paginate(section, blocks, m.pageHeight, Math.round(m.pageHeight * 0.12)), flow: flow(section, blocks) };
}

/** What the page asks the layout worker. */
export type ToWorker =
  | { kind: "open"; ebook: unknown; images: string[] }
  | { kind: "lay out"; id: number; section: number; spec: LayoutSpec };

/** What the layout worker answers. */
export type FromWorker =
  | { kind: "ready"; hyphenates: boolean }
  | { kind: "laid out"; id: number; section: number; layout: SectionLayout; ms: number }
  | { kind: "failed"; id: number; section: number; message: string };
