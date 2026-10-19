import { describe, expect, it } from "vitest";
import { exportPath, exportPlan } from "../src/core/reading/export";
import { overlayAnchors } from "../src/core/reading/overlay";
import { alignBook } from "../src/core/reading/align";
import { groupBooks } from "../src/core/scan/group";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";
import type { FileEntry } from "../src/core/scan/walk";

const ONE = ["The waygate hung before them. It was a giant circle of wraithbone.", "Eluadhri said nothing. Then she laughed."];
const TWO = ["Somewhere beyond, the webway waited.", "Older than any of them, it was patient as stone."];

function book(): Ebook {
  const section = (href: string, paras: string[]) => ({ href, linear: true, overlay: null, chars: paras.join("").length, blocks: [{ k: "h" as const, runs: [{ t: href.startsWith("one") ? "One" : "Two" }] }, ...paras.map((t) => ({ k: "p" as const, runs: [{ t }] }))] });
  return {
    format: EBOOK_FORMAT,
    meta: { title: "T", authors: [], identifiers: [], language: "en" },
    layout: "reflowable",
    sections: [section("one.xhtml", ONE), section("two.xhtml", TWO)],
    toc: [
      { label: "One", section: 0, block: 0, depth: 0 },
      { label: "Two", section: 1, block: 0, depth: 0 },
    ],
  };
}

describe("the read-along export's plan", () => {
  it("times every sentence of each chapter in that chapter's own stretch of the audiobook, across its files", () => {
    const e = book();
    // Two audio chapters, the second split across two files at 90 s.
    const chapters = [{ title: "One", startMs: 0, endMs: 60_000 }, { title: "Two", startMs: 60_000, endMs: 120_000 }];
    const a = alignBook(e, chapters, 120_000);
    const plan = exportPlan(e, a, [{ path: "/b/1.mp3", durationMs: 90_000 }, { path: "/b/2.mp3", durationMs: 30_000 }], "/b/Book.epub");
    expect(plan.out).toBe("/b/Book (read-along).epub");
    expect(plan.sections.map((s) => s.href)).toEqual(["one.xhtml", "two.xhtml"]);
    const one = plan.sections[0]!;
    // The heading and four sentences, in order, each starting where the last ends, from the chapter's own 0.
    expect(one.sentences.map((s) => [s.block, s.start])).toEqual([[0, 0], [1, 0], [1, 30], [2, 0], [2, 23]]);
    expect(one.sentences[0]!.beginMs).toBe(0);
    for (let i = 1; i < one.sentences.length; i++) expect(one.sentences[i]!.beginMs).toBe(one.sentences[i - 1]!.endMs);
    expect(one.audio).toEqual([{ path: "/b/1.mp3", fromMs: one.bookMs, toMs: one.bookMs + one.sentences[one.sentences.length - 1]!.endMs }]);
    // Chapter two's audio runs from the first file into the second.
    const two = plan.sections[1]!;
    expect(two.audio.map((p) => p.path)).toEqual(["/b/1.mp3", "/b/2.mp3"]);
    expect(two.audio[0]!.toMs).toBe(90_000);
    expect(two.audio[1]!.fromMs).toBe(0);
  });

  it("names the export beside its original", () => {
    expect(exportPath("C:/Books/Voidscarred.epub")).toBe("C:/Books/Voidscarred (read-along).epub");
    expect(exportPath("x.EPUB")).toBe("x (read-along).epub");
  });

  it("is read back onto the recording by where each audio file says it starts", () => {
    const e = book();
    e.sections[0]!.blocks[1]!.ids = [{ id: "ribbon-s1-2", at: 0 }];
    e.sections[0]!.narration = [{ id: "ribbon-s1-2", audio: "OEBPS/ribbon/audio/001-at-61000ms.m4a", begin: 1200, end: 4000 }];
    const anchors = overlayAnchors(e, { files: [{ path: "VoidscarredWarhammer40000_ep7.mp3", durationMs: 120_000 }], durationMs: 120_000 });
    expect(anchors).toEqual([{ ms: 62_200, chars: 3 }]);
  });
});

describe("an export beside its original", () => {
  const f = (relPath: string): FileEntry => ({ relPath, absPath: `/lib/${relPath}`, name: relPath.slice(relPath.lastIndexOf("/") + 1), sizeBytes: 1, mtimeMs: 0 });

  it("stands in for it: the book is read from the export, and the original is not a book of its own", () => {
    const g = groupBooks([f("Aeldari/VoidscarredWarhammer40000_ep7.mp3"), f("Aeldari/Voidscarred -- Mike Brooks.epub"), f("Aeldari/Voidscarred -- Mike Brooks (read-along).epub")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.ebook).toBe("Aeldari/Voidscarred -- Mike Brooks (read-along).epub");
    const loose = groupBooks([f("VoidscarredWarhammer40000_ep7.mp3"), f("Horus.mp3"), f("Voidscarred -- Mike Brooks.epub"), f("Voidscarred -- Mike Brooks (read-along).epub")]);
    expect(loose.find((b) => b.name.startsWith("Voidscarred"))!.ebook).toBe("Voidscarred -- Mike Brooks (read-along).epub");
    expect(loose.filter((b) => b.audio.length === 0)).toEqual([]);
  });
});
