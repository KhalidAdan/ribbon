import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppController } from "../src/app/controller";
import { wantsToPlay } from "@ribbon/core/playback";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";

/**
 * The computer going to sleep: a book that's playing is paused first, so
 * it doesn't start by itself, out loud, the moment a laptop's lid opens.
 */
describe("the computer going to sleep", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = proofWorld();
  });
  afterEach(() => restore());

  /** Ribbon open on the proofs' library, and the way its computer says it's going to sleep. */
  async function app() {
    const sleeps: (() => void)[] = [];
    let listening = 0;
    const onSystemSleep = (heard: () => void) => {
      sleeps.push(heard);
      listening++;
      return () => void listening--;
    };
    const c = new AppController(proofPlatform(proofHost(proofLibrary(), new Holds()), { onSystemSleep }, [ROOT]));
    await c.boot();
    const uninstall = c.installLifecycle();
    await settle();
    const paired = c.getState().books.find((b) => b.book.title === "Paired")!;
    return { c, paired, uninstall, goToSleep: () => sleeps.forEach((heard) => heard()), listening: () => listening };
  }

  it("pauses a book that's playing, and it stays paused after the wake", async () => {
    const { c, paired, goToSleep } = await app();
    await c.playBook(paired);
    await settle();
    expect(wantsToPlay(c.getState().player.status)).toBe(true);

    goToSleep();
    expect(c.getState().player.status).toBe("paused");
    // The lid opens: time has passed, and nothing starts the book.
    await settle();
    await settle();
    expect(c.getState().player.status).toBe("paused");

    // It plays again when asked.
    await c.play();
    await settle();
    expect(wantsToPlay(c.getState().player.status)).toBe(true);
    c.destroy();
  });

  it("leaves a paused book as it is", async () => {
    const { c, paired, goToSleep } = await app();
    await c.playBook(paired);
    await settle();
    c.pause();
    const before = c.getState().player;

    goToSleep();
    await settle();
    expect(c.getState().player).toEqual(before);
    c.destroy();
  });

  it("does nothing with no book open, and stops listening when the lifecycle is uninstalled", async () => {
    const { c, uninstall, goToSleep, listening } = await app();
    goToSleep();
    expect(c.getState().player.status).toBe("paused");
    expect(listening()).toBe(1);
    uninstall();
    expect(listening()).toBe(0);
    c.destroy();
  });
});
