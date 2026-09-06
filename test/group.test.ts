import { describe, expect, it } from "vitest";
import { groupBooks } from "../src/core/scan/group";
import type { FileEntry } from "../src/core/scan/walk";

const f = (relPath: string): FileEntry => ({
  relPath,
  absPath: `/lib/${relPath}`,
  name: relPath.slice(relPath.lastIndexOf("/") + 1),
  sizeBytes: 1,
  mtimeMs: 0,
});

describe("groupBooks", () => {
  it("makes a folder with audio one book", () => {
    const g = groupBooks([f("Book/01.mp3"), f("Book/02.mp3"), f("Book/cover.jpg")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.path).toBe("Book");
    expect(g[0]!.name).toBe("Book");
    expect(g[0]!.audio.map((a) => a.relPath)).toEqual(["Book/01.mp3", "Book/02.mp3"]);
    expect(g[0]!.covers[0]!.name).toBe("cover.jpg");
  });

  it("makes a loose root file its own book", () => {
    const g = groupBooks([f("loose.mp3")]);
    expect(g).toEqual([{ path: "loose.mp3", name: "loose", audio: [f("loose.mp3")], covers: [] }]);
  });

  it("groups nested series at the book folder", () => {
    const g = groupBooks([f("Series/Book One/01.mp3"), f("Series/Book One/02.mp3"), f("Series/Book Two/01.mp3")]);
    expect(g.map((x) => x.path)).toEqual(["Series/Book One", "Series/Book Two"]);
    expect(g.map((x) => x.name)).toEqual(["Book One", "Book Two"]);
  });

  it("splits loose audio in a folder that also has book subfolders", () => {
    const g = groupBooks([f("Mixed/bonus.mp3"), f("Mixed/Sub/01.mp3")]);
    expect(g.map((x) => x.path)).toEqual(["Mixed/bonus.mp3", "Mixed/Sub"]);
  });

  it("ignores non-audio files for grouping", () => {
    expect(groupBooks([f("Book/notes.txt"), f("Book/cover.jpg")])).toEqual([]);
  });

  it("ranks cover candidates by name", () => {
    const g = groupBooks([f("B/a.mp3"), f("B/zzz.png"), f("B/folder.png"), f("B/cover.jpg")]);
    expect(g[0]!.covers.map((c) => c.name)).toEqual(["cover.jpg", "folder.png", "zzz.png"]);
  });

  it("keeps walk order", () => {
    const g = groupBooks([f("Z/1.mp3"), f("A/1.mp3")]);
    expect(g.map((x) => x.path)).toEqual(["Z", "A"]);
  });

  it("treats multiple loose root files as separate books", () => {
    const g = groupBooks([f("a.mp3"), f("b.mp3")]);
    expect(g).toHaveLength(2);
  });
});
