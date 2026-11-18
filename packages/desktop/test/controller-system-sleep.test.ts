import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../src/app/controller";
import { wantsToPlay } from "@ribbon/core/playback";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";

/**
 * A laptop's lid closed and opened. A Mac pauses the book for the sleep
 * through its media controls, and as it wakes it asks for the book to play
 * again. Nobody asked for that, so Ribbon doesn't answer it.
 */
describe("the computer sleeping and waking", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = proofWorld();
  });
  afterEach(() => restore());

  /** Ribbon open on the proofs' library with Paired playing, and the computer's way of saying it sleeps and wakes. */
  async function app() {
    const told: { sleeping: () => void; woke: () => void }[] = [];
    const onSystemSleep = (sleeping: () => void, woke: () => void) => {
      const one = { sleeping, woke };
      told.push(one);
      return () => void told.splice(told.indexOf(one), 1);
    };
    const c = new AppController(proofPlatform(proofHost(proofLibrary(), new Holds()), { onSystemSleep }, [ROOT]));
    await c.boot();
    const uninstall = c.installLifecycle();
    await settle();
    await c.playBook(c.getState().books.find((b) => b.book.title === "Paired")!);
    await settle();
    const playing = () => wantsToPlay(c.getState().player.status);
    return {
      c,
      playing,
      uninstall,
      listening: () => told.length,
      /** The lid closes: the Mac says so, and pauses the book as a media key would. */
      closeLid() {
        told.forEach((t) => t.sleeping());
        c.pause();
      },
      wake: () => told.forEach((t) => t.woke()),
    };
  }

  it("a play the system asks for as the computer wakes leaves the book paused", async () => {
    const { c, playing, closeLid, wake } = await app();
    expect(playing()).toBe(true);
    closeLid();

    // The lid opens. The Mac's request can come before Ribbon hears of the wake, or after.
    c.playAskedBySystem();
    wake();
    c.playAskedBySystem();
    await settle();
    expect(playing()).toBe(false);
    expect(c.getState().player.status).toBe("paused");
    c.destroy();
  });

  it("the listener's own play still works at once after a wake", async () => {
    const { c, playing, closeLid, wake } = await app();
    closeLid();
    wake();
    c.togglePlay();
    await settle();
    expect(playing()).toBe(true);
    c.destroy();
  });

  it("a media key plays the book again once the wake is a few seconds past", async () => {
    const { c, playing, closeLid, wake } = await app();
    closeLid();
    wake();
    await vi.advanceTimersByTimeAsync(6_000);
    c.playAskedBySystem();
    await settle();
    expect(playing()).toBe(true);
    c.destroy();
  });

  it("a media key plays a paused book when the computer never slept", async () => {
    const { c, playing } = await app();
    c.pause();
    c.playAskedBySystem();
    await settle();
    expect(playing()).toBe(true);
    c.destroy();
  });

  it("stops listening when the lifecycle is uninstalled", async () => {
    const { c, uninstall, listening } = await app();
    expect(listening()).toBe(1);
    uninstall();
    expect(listening()).toBe(0);
    c.destroy();
  });
});
