import { describe, expect, it } from "vitest";
import { AppController } from "../src/app/controller";
import { Held } from "./support/memory-host";
import { Holds, proofHost, proofLibrary, proofPlatform, ROOT, proofWorld, settle } from "./support/proof-app";

/**
 * Read-along turned off for one book (core/edits.ts, `readAlong`), in a
 * library of folders with no server: the choice is kept beside the book
 * with its other edits, the reader opens the book to read only whatever
 * transcript it has, and the speech model is never asked to hear it.
 * Turned back on, the book is as it was: nothing was deleted.
 */

/** A library with "Paired" (audio and its EPUB), on a machine that transcribes; every call to the speech model is noted. */
async function app() {
  const restore = proofWorld();
  const asked: string[] = [];
  const answers = new Held<void>();
  const files = proofLibrary();
  const host = proofHost(files, new Holds(), {
    speechOpenings: async (_model, clips) => {
      asked.push("openings");
      return clips.map((c) => (c.path.endsWith("one.mp3") ? "Chapter One. The lamp was lit at dusk" : "Chapter Two. By morning the sea was calm"));
    },
    speechTranscribe: async (_model, clips, seconds) => {
      asked.push("minutes");
      await answers.wait();
      return clips.map((c) => [{ startMs: c.startMs, endMs: c.startMs + seconds * 1000, words: c.path.endsWith("one.mp3") ? "The lamp was lit at dusk, and the keeper sat down with the ledger." : "By morning the sea was calm and grey." }]);
    },
  });
  const c = new AppController(proofPlatform(host, {}, [ROOT], { speechModel: "/models/ggml-small.bin", speechClipMs: 100 }));
  await c.boot();
  await settle();
  const id = c.getState().books.find((b) => b.book.title === "Paired")!.book.id;
  const readsAlong = () => {
    const r = c.getState().reading;
    return r?.status === "ready" ? r.readsAlong : null;
  };
  /** Open the book to read, and let the model hear all it's asked to. */
  const open = async () => {
    void c.openReading(id);
    await settle();
    answers.resolveAll();
    await settle();
  };
  return { c, id, asked, files, readsAlong, open, done: () => (c.destroy(), restore()) };
}

describe("read-along turned off for a book, in a library of folders", () => {
  it("reads only from the moment it's turned off, keeps the choice beside the book, and reads along again when it's turned back on", async () => {
    const { c, id, asked, files, readsAlong, open, done } = await app();
    try {
      await open();
      expect(readsAlong()).toBe(true);
      const heard = asked.length;

      // Turned off while the book is open: the page stops marking the narrator's sentence there and then.
      await c.saveEdits(id, { readAlong: "off" });
      await settle();
      expect(readsAlong()).toBe(false);
      expect(c.getState().books.find((b) => b.book.id === id)!.book.readAlong).toBe("off");
      expect(files.text(`${ROOT}/.ribbon/edits/${id}.csv`)).toContain("read_along,off");

      // Opened again, it's still read only, and nothing more is heard: its transcript is whole, and stays.
      await c.closeReading();
      await open();
      expect(readsAlong()).toBe(false);
      expect(asked.length).toBe(heard);

      // Back on: it reads along at once, from the transcript it kept.
      await c.saveEdits(id, { readAlong: "" });
      await settle();
      expect(readsAlong()).toBe(true);
      expect(asked.length).toBe(heard);
      expect(c.getState().books.find((b) => b.book.id === id)!.book.readAlong).toBeUndefined();
    } finally {
      done();
    }
  });

  it("is never transcribed while it's off, and is once it's turned back on", async () => {
    const { c, id, asked, readsAlong, open, done } = await app();
    try {
      await c.saveEdits(id, { readAlong: "off" });
      await open();
      expect(readsAlong()).toBe(false);
      expect(asked).toEqual([]);

      await c.saveEdits(id, { readAlong: "" });
      await settle();
      expect(asked).toContain("minutes");
    } finally {
      done();
    }
  });
});
