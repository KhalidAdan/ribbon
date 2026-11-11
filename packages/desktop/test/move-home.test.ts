import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppController, type HomeMover, type Platform } from "../src/app/controller";
import type { HomeMovePlan } from "@ribbon/core/home-move";
import { isPlaying } from "@ribbon/core/playback";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";

const GB = 1024 ** 3;
const PLAN: Omit<HomeMovePlan, "picked"> = { from: "C:\\Users\\k\\AppData\\Local\\Ribbon", to: "D:\\Ribbon", bytes: 4 * GB, files: 1200, freeBytes: 900 * GB };

/** A mover that does nothing on disk, and says what it was asked and what was going on when it copied. */
class FakeMover implements HomeMover {
  picked: string | null = "D:\\";
  plan: Omit<HomeMovePlan, "picked"> | Error = PLAN;
  fails: Error | null = null;
  copies: { picked: string; playing: boolean; reading: boolean }[] = [];
  restarts = 0;
  constructor(private readonly c: () => AppController) {}
  pick = async () => this.picked;
  check = async () => {
    if (this.plan instanceof Error) throw this.plan;
    return this.plan;
  };
  run = async (picked: string, onProgress: (done: number, total: number) => void) => {
    const s = this.c().getState();
    this.copies.push({ picked, playing: isPlaying(s.player.status), reading: s.reading !== null });
    onProgress(GB, 4 * GB);
    if (this.fails) throw this.fails;
    onProgress(4 * GB, 4 * GB);
  };
  restart = async () => void this.restarts++;
}

/** Moving the Ribbon folder (core/home-move.ts): asked about, refused, moved, failed. */
describe("moving the Ribbon folder", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = proofWorld();
  });
  afterEach(() => restore());

  async function app(): Promise<{ c: AppController; mover: FakeMover }> {
    let c: AppController | null = null;
    const mover = new FakeMover(() => c!);
    const home: Platform["home"] = { path: async () => PLAN.from, reveal: async () => undefined, reset: async () => false, move: mover };
    c = new AppController(proofPlatform(proofHost(proofLibrary(), new Holds()), { home }, [ROOT]));
    await c.boot();
    await settle();
    return { c, mover };
  }

  it("asks with where it goes and how much it holds, and cancelling changes nothing", async () => {
    const { c, mover } = await app();
    expect(c.canMoveHome()).toBe(true);
    await c.chooseHomePlace();
    expect(c.getState().homeMove).toEqual({ status: "asking", plan: { ...PLAN, picked: "D:\\" } });
    c.cancelHomeMove();
    expect(c.getState().homeMove).toEqual({ status: "none" });
    expect(mover.copies).toEqual([]);
    c.destroy();
  });

  it("asks nothing when no folder is picked, and says why when one can't be used", async () => {
    const { c, mover } = await app();
    mover.picked = null;
    await c.chooseHomePlace();
    expect(c.getState().homeMove).toEqual({ status: "none" });
    mover.picked = "C:\\Users\\k\\AppData\\Local\\Ribbon\\mirror";
    mover.plan = new Error("That's inside the Ribbon folder. Pick a folder outside it.");
    await c.chooseHomePlace();
    expect(c.getState().homeMove).toEqual({ status: "refused", why: "That's inside the Ribbon folder. Pick a folder outside it." });
    c.destroy();
  });

  it("stops playing and closes the reader before it copies, then starts Ribbon again", async () => {
    const { c, mover } = await app();
    await c.playBook(c.getState().books.find((b) => b.book.title === "Paired")!);
    await c.openReading(c.getState().books.find((b) => b.book.title === "Only")!.book.id);
    await settle();
    expect(isPlaying(c.getState().player.status)).toBe(true);
    expect(c.getState().reading).not.toBeNull();

    await c.chooseHomePlace();
    await c.moveHome();
    expect(mover.copies).toEqual([{ picked: "D:\\", playing: false, reading: false }]);
    expect(c.getState().homeMove).toEqual({ status: "restarting", to: "D:\\Ribbon" });
    expect(mover.restarts).toBe(1);
    // A key pressed to play while Ribbon starts again plays nothing.
    await c.play();
    await settle();
    expect(isPlaying(c.getState().player.status)).toBe(false);
    c.destroy();
  });

  it("doesn't move to a disk without room for it", async () => {
    const { c, mover } = await app();
    mover.plan = { ...PLAN, freeBytes: 4 * GB };
    await c.chooseHomePlace();
    await c.moveHome();
    expect(c.getState().homeMove.status).toBe("asking");
    expect(mover.copies).toEqual([]);
    c.destroy();
  });

  it("says why a copy failed, and starts Ribbon again where it was when asked", async () => {
    const { c, mover } = await app();
    mover.fails = new Error("could not copy D:\\Ribbon\\servers\\ab\\Dune.mp3: There is not enough space on the disk. (os error 112)");
    await c.chooseHomePlace();
    await c.moveHome();
    expect(c.getState().homeMove).toEqual({ status: "failed", why: "could not copy D:\\Ribbon\\servers\\ab\\Dune.mp3: There is not enough space on the disk. (os error 112)" });
    expect(mover.restarts).toBe(0);
    await c.restartAfterMove();
    expect(mover.restarts).toBe(1);
    c.destroy();
  });
});
