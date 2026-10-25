import { describe, expect, it } from "vitest";
import { nodeHost } from "../src/host/node";
import { AppController, type AppState, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";

/**
 * Closing Ribbon while it transcribes (#158): it asks first, saying what
 * it's transcribing and how far it has got, and stays open on a no. With
 * nothing being transcribed it closes without a word.
 */
function closing() {
  const asked: string[] = [];
  let answer = false;
  let mayClose: (() => Promise<boolean>) | null = null;
  const platform: Platform = {
    host: nodeHost(),
    pickFolder: async () => null,
    allowFolder: async () => undefined,
    fileUrl: (p) => `file:///${p}`,
    sources: memorySources(),
    onWindowClose: (_flush, ask) => {
      mayClose = ask;
      return () => undefined;
    },
    askToClose: async (why) => {
      asked.push(why);
      return answer;
    },
  };
  const c = new AppController(platform);
  c.installLifecycle();
  const set = (patch: Partial<AppState>) => (c as unknown as { set(p: Partial<AppState>): void }).set(patch);
  return { c, asked, set, close: () => mayClose!(), answer: (yes: boolean) => (answer = yes) };
}

describe("closing while transcribing", () => {
  it("closes without asking when nothing is being transcribed", async () => {
    const { asked, close } = closing();
    expect(await close()).toBe(true);
    expect(asked).toEqual([]);
  });

  it("asks while the server's books are transcribed, with the book and how far, and stays open on a no", async () => {
    const { c, asked, set, close, answer } = closing();
    set({ transcribingForServer: { title: "Voidscarred", done: 302, total: 612 } });
    expect(c.transcribingNow()).toBe("Voidscarred for the server, 49% of the way");
    expect(await close()).toBe(false);
    expect(asked).toEqual(["Ribbon is transcribing Voidscarred for the server, 49% of the way. Closing stops it, and it carries on from there the next time Ribbon is open."]);
    answer(true);
    expect(await close()).toBe(true);
  });
});
