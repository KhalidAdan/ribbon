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

  describe("anthologies", () => {
    const primarchs = [
      f("20. The Primarchs/02 Feat of Iron/01.mp3"),
      f("20. The Primarchs/01 The Reflection Crackd/01.mp3"),
      f("20. The Primarchs/01 The Reflection Crackd/02.mp3"),
      f("20. The Primarchs/01 The Reflection Crackd/cover.jpg"),
      f("21. Fear to Tread/01.mp3"),
    ];

    it("folds a numbered folder of numbered subfolders into one book with parts", () => {
      const g = groupBooks(primarchs);
      expect(g.map((x) => x.path)).toEqual(["20. The Primarchs", "21. Fear to Tread"]);
      const a = g[0]!;
      expect(a.name).toBe("20. The Primarchs");
      expect(a.parts!.map((p) => p.name)).toEqual(["The Reflection Crackd", "Feat of Iron"]);
      expect(a.audio.map((x) => x.relPath)).toEqual(["20. The Primarchs/01 The Reflection Crackd/01.mp3", "20. The Primarchs/01 The Reflection Crackd/02.mp3", "20. The Primarchs/02 Feat of Iron/01.mp3"]);
      expect(a.covers[0]!.relPath).toBe("20. The Primarchs/01 The Reflection Crackd/cover.jpg");
    });

    it("prefers the anthology folder's own cover", () => {
      const g = groupBooks([...primarchs, f("20. The Primarchs/cover.jpg")]);
      expect(g[0]!.covers[0]!.relPath).toBe("20. The Primarchs/cover.jpg");
    });

    it("never folds the library root, and needs the folder itself to be numbered", () => {
      expect(groupBooks([f("01. A/x.mp3"), f("02. B/x.mp3")]).map((x) => x.path)).toEqual(["01. A", "02. B"]);
      expect(groupBooks([f("Extras/1. A/x.mp3"), f("Extras/2. B/x.mp3")]).map((x) => x.path)).toEqual(["Extras/1. A", "Extras/2. B"]);
    });

    it("leaves a numbered folder alone when it has audio of its own or an unnumbered child", () => {
      expect(groupBooks([f("20. X/intro.mp3"), f("20. X/01 A/x.mp3")]).map((x) => x.path)).toEqual(["20. X/intro.mp3", "20. X/01 A"]);
      expect(groupBooks([f("20. X/01 A/x.mp3"), f("20. X/Bonus/x.mp3")]).map((x) => x.path)).toEqual(["20. X/01 A", "20. X/Bonus"]);
    });

    it("takes the outermost anthology when they nest", () => {
      const g = groupBooks([f("5. Outer/1. Inner/1. Deep/x.mp3"), f("5. Outer/2. Other/x.mp3")]);
      expect(g.map((x) => x.path)).toEqual(["5. Outer"]);
      expect(g[0]!.parts!.map((p) => p.name)).toEqual(["Inner", "Other"]);
    });
  });
});
