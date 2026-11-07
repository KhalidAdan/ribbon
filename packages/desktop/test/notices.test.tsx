// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController, type AppState, type Notice, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { nodeHost } from "@ribbon/host-node/node";
import { Notices, noticeWords } from "../src/ui/Notices";
import { ControllerContext } from "../src/ui/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  // Sonner keeps its toasts between renders, as the app keeps one set: cleared for the next test.
  toast.dismiss();
  await until(() => !document.querySelector("[data-sonner-toast]"));
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** Sonner draws a toast on the next tick, and takes one off a frame and 200ms after it's dismissed: wait until the page says so, or two seconds. */
async function until(check: () => boolean): Promise<void> {
  for (let waited = 0; !check() && waited < 2_000; waited += 20) await act(() => new Promise((r) => setTimeout(r, 20)));
}
const shows = (words: string) => until(() => text().includes(words));
const gone = (words: string) => until(() => !text().includes(words));

/** A controller with nothing open, and a way to set its state by hand. */
function app() {
  const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
  const c = new AppController(platform);
  const set = (patch: Partial<AppState>) => act(() => (c as unknown as { set(p: Partial<AppState>): void }).set(patch));
  return { c, set };
}

/** The notes drawn for the controller's state, and what they say. */
async function drawn(c: AppController) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<ControllerContext.Provider value={c}><Notices /></ControllerContext.Provider>));
}
const text = () => document.body.textContent ?? "";
/** A button by its words, or (`within`) by words it holds among others. */
const button = (words: string, { within = false } = {}) => [...document.querySelectorAll("button")].find((b) => (within ? b.textContent?.includes(words) : b.textContent === words));

const transcribing: Notice = { id: 1, what: "transcribing", title: "Night Lords", forServer: true };

describe("the notes over the page", () => {
  it("says a book's transcribing has begun, and lets it go when it's clicked away", async () => {
    const { c, set } = app();
    await drawn(c);
    set({ notices: [transcribing] });
    await shows("Transcribing Night Lords");
    expect(text()).toContain("For the server, so every device reads it along.");
    await act(async () => button("Transcribing Night Lords", { within: true })!.click());
    await gone("Transcribing Night Lords");
    expect(c.getState().notices).toEqual([]);
    expect(text()).not.toContain("Transcribing Night Lords");
  });

  it("keeps a book that couldn't be transcribed until it's dismissed, with why", async () => {
    const { c, set } = app();
    await drawn(c);
    set({ notices: [{ id: 2, what: "not-transcribed", title: "Night Lords", forServer: true, why: "This EPUB is locked with DRM, so Ribbon cannot open it." }] });
    await shows("Couldn't transcribe Night Lords");
    expect(text()).toContain("This EPUB is locked with DRM");
    await act(async () => button("Dismiss")!.click());
    await gone("Couldn't transcribe");
    expect(c.getState().notices).toEqual([]);
    expect(text()).not.toContain("Couldn't transcribe");
  });

  it("shows an error until it's dismissed, and a new one in its place", async () => {
    const { c, set } = app();
    await drawn(c);
    set({ error: "Could not open the folder." });
    await shows("Could not open the folder.");
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Could not open the folder.");
    set({ error: "Still trying to reach the server." });
    await shows("Still trying to reach the server.");
    await gone("Could not open the folder.");
    expect(document.querySelectorAll("[role=alert]")).toHaveLength(1);
    expect(text()).toContain("Still trying to reach the server.");
    await act(async () => button("Dismiss")!.click());
    await gone("Still trying");
    expect(c.getState().error).toBeNull();
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("takes an error away when it's put right on its own", async () => {
    const { c, set } = app();
    await drawn(c);
    set({ error: "Still trying to reach the server." });
    await shows("Still trying to reach the server.");
    set({ error: null });
    await gone("Still trying");
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("keeps a note set again just after it was cleared, before Sonner's word that the old one went", async () => {
    // Frames run when the test says: a hidden window runs none, and Sonner marks a toast gone a frame after it's dismissed.
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (frames.set(++next, f), next));
    vi.stubGlobal("cancelAnimationFrame", (n: number) => frames.delete(n));
    const frame = () => act(() => [...frames.entries()].forEach(([n, f]) => (frames.delete(n), f(performance.now()))));
    try {
      const { c, set } = app();
      await drawn(c);
      set({ speechNudge: true });
      await shows("Read along sentence by sentence");
      set({ speechNudge: false });
      await frame();
      set({ speechNudge: true });
      await act(() => new Promise((r) => setTimeout(r, 50)));
      await frame();
      await frame();
      await act(() => new Promise((r) => setTimeout(r, 300)));
      expect(c.getState().speechNudge).toBe(true);
      expect(text()).toContain("Read along sentence by sentence");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the daily goal met and the offer of a speech model together, where one used to hide the other", async () => {
    const { c, set } = app();
    await drawn(c);
    set({ goalMet: { minutes: 20, streakDays: 5 }, speechNudge: true, error: "Could not open the folder." });
    await shows("Could not open the folder.");
    expect(text()).toContain("Daily goal met");
    expect(text()).toContain("20 minutes with your books today. 5 days in a row.");
    expect(text()).toContain("Read along sentence by sentence");
    expect(text()).toContain("Could not open the folder.");
    await act(async () => button("Not now")!.click());
    await gone("Read along sentence by sentence");
    expect(c.getState().speechNudge).toBe(false);
    expect(text()).not.toContain("Read along sentence by sentence");
  });
});

describe("the note that a new version is ready", () => {
  const ready = { on: true, checkedAt: 1, ready: "0.30.0", putOff: false };

  it("offers to restart while nothing plays, goes while a book plays, and comes back when it stops", async () => {
    const { c, set } = app();
    await drawn(c);
    set({ update: ready });
    await shows("Ribbon 0.30.0 is ready");
    expect(text()).toContain("Restart to update now, or it updates the next time you close Ribbon.");
    set({ player: { ...c.getState().player, playing: true } });
    await gone("Ribbon 0.30.0 is ready");
    // Gone for the book playing, not put off.
    expect(c.getState().update?.putOff).toBe(false);
    set({ player: { ...c.getState().player, playing: false } });
    await shows("Ribbon 0.30.0 is ready");
  });

  it("isn't offered while a book is transcribed", async () => {
    const { c, set } = app();
    await drawn(c);
    set({ update: ready, transcribingForServer: { title: "Voidscarred", done: 302, total: 612 } });
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(text()).not.toContain("is ready");
    set({ transcribingForServer: null });
    await shows("Ribbon 0.30.0 is ready");
  });

  it("puts the offer off on Later, and restarts on Restart to update", async () => {
    const { c, set } = app();
    const restart = vi.spyOn(c, "restartToUpdate").mockResolvedValue();
    await drawn(c);
    set({ update: ready });
    await shows("Ribbon 0.30.0 is ready");
    await act(async () => button("Restart to update")!.click());
    expect(restart).toHaveBeenCalledOnce();
    await act(async () => button("Later")!.click());
    await gone("Ribbon 0.30.0 is ready");
    expect(c.getState().update?.putOff).toBe(true);
  });
});

describe("what a transcribing note says", () => {
  it("says what's going on, for the server or for this computer", () => {
    expect(noticeWords(transcribing)).toEqual({ title: "Transcribing Night Lords", line: "For the server, so every device reads it along. The top bar says how far it has got." });
    expect(noticeWords({ ...transcribing, forServer: false }).line).toBe("It reads along once its whole narration is heard.");
    expect(noticeWords({ ...transcribing, what: "reads-along" })).toEqual({ title: "Night Lords reads along now", line: "Its transcript is on the server, so every device reads it along." });
    expect(noticeWords({ ...transcribing, what: "reads-along", forServer: false }).line).toBe("Its whole narration is heard and found in the text.");
  });
});

describe("transcribing notes in the controller", () => {
  const book = { book: { id: "b1", title: "Night Lords" } } as ScannedBook;
  const notes = (c: AppController) => c as unknown as { noteTranscribing(b: ScannedBook, forServer: boolean): void; notTranscribed(b: ScannedBook, forServer: boolean, why: string): "failed" };

  it("says a book's transcribing has begun once a session, however often it stops and starts again", () => {
    const { c } = app();
    notes(c).noteTranscribing(book, true);
    notes(c).noteTranscribing(book, true);
    notes(c).noteTranscribing(book, false);
    expect(c.getState().notices).toEqual([{ id: 1, what: "transcribing", title: "Night Lords", forServer: true }]);
  });

  it("says why a book couldn't be transcribed, each time, and lets a note go by its id", () => {
    const { c } = app();
    expect(notes(c).notTranscribed(book, true, "There isn't room on this computer to download it.")).toBe("failed");
    notes(c).noteTranscribing({ book: { id: "b2", title: "Soul Hunter" } } as ScannedBook, true);
    expect(c.getState().notices.map((n) => n.what)).toEqual(["not-transcribed", "transcribing"]);
    c.dismissNotice(1);
    expect(c.getState().notices).toEqual([{ id: 2, what: "transcribing", title: "Soul Hunter", forServer: true }]);
  });
});
