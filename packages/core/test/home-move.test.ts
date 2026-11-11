import { describe, expect, it } from "vitest";
import { fits, homeMoveAfter, MOVE_HEADROOM_BYTES, NO_MOVE, type HomeMove, type HomeMoveEvent, type HomeMovePlan } from "@ribbon/core/home-move";

const GB = 1024 ** 3;
const plan: HomeMovePlan = { picked: "D:\\", from: "C:\\Users\\k\\AppData\\Local\\Ribbon", to: "D:\\Ribbon", bytes: 4 * GB, files: 1200, freeBytes: 900 * GB };
const cramped: HomeMovePlan = { ...plan, freeBytes: 4 * GB };

const after = (now: HomeMove, ...events: HomeMoveEvent[]) => events.reduce(homeMoveAfter, now);

const EVERY_EVENT: HomeMoveEvent[] = [
  { type: "planned", plan },
  { type: "refused", why: "The Ribbon folder is there already." },
  { type: "cancel" },
  { type: "move" },
  { type: "progress", done: 1, total: 2 },
  { type: "moved" },
  { type: "failed", why: "the disk is full" },
];

describe("moving the Ribbon folder", () => {
  it("asks with the plan once a folder is picked and checked, and closes as if nothing happened", () => {
    const asking = after(NO_MOVE, { type: "planned", plan });
    expect(asking).toEqual({ status: "asking", plan });
    expect(after(asking, { type: "cancel" })).toBe(NO_MOVE);
  });

  it("says why when it can't go there, and another folder can be picked", () => {
    const refused = after(NO_MOVE, { type: "refused", why: "That's inside the Ribbon folder." });
    expect(refused).toEqual({ status: "refused", why: "That's inside the Ribbon folder." });
    expect(after(refused, { type: "cancel" })).toBe(NO_MOVE);
    expect(after(refused, { type: "planned", plan })).toEqual({ status: "asking", plan });
  });

  it("moves only when the disk has room, with some to spare", () => {
    expect(fits(plan)).toBe(true);
    expect(fits(cramped)).toBe(false);
    expect(fits({ ...plan, freeBytes: plan.bytes + MOVE_HEADROOM_BYTES })).toBe(true);
    const asking = after(NO_MOVE, { type: "planned", plan: cramped });
    expect(after(asking, { type: "move" })).toBe(asking);
    expect(after(NO_MOVE, { type: "planned", plan }, { type: "move" })).toEqual({ status: "moving", plan, done: 0, total: plan.bytes });
  });

  it("counts the bytes copied, and restarts in the new place once moved", () => {
    const moving = after(NO_MOVE, { type: "planned", plan }, { type: "move" }, { type: "progress", done: GB, total: 4 * GB });
    expect(moving).toEqual({ status: "moving", plan, done: GB, total: 4 * GB });
    // The log grew while it copied: more done than first counted is never more than all of it.
    expect(after(moving, { type: "progress", done: 5 * GB, total: 4 * GB })).toMatchObject({ done: 5 * GB, total: 5 * GB });
    expect(after(moving, { type: "moved" })).toEqual({ status: "restarting", to: "D:\\Ribbon" });
  });

  it("can't be cancelled half way: it finishes, or fails and starts again where it was", () => {
    const moving = after(NO_MOVE, { type: "planned", plan }, { type: "move" });
    for (const event of [{ type: "cancel" }, { type: "planned", plan }, { type: "refused", why: "no" }, { type: "move" }] as HomeMoveEvent[]) {
      expect(after(moving, event)).toBe(moving);
    }
    expect(after(moving, { type: "failed", why: "the disk is full" })).toEqual({ status: "failed", why: "the disk is full" });
  });

  it("stays failed or restarting, whatever happens, until Ribbon starts again", () => {
    for (const end of [{ status: "failed", why: "x" }, { status: "restarting", to: "D:\\Ribbon" }] as HomeMove[]) {
      for (const event of EVERY_EVENT) expect(after(end, event)).toBe(end);
    }
  });

  it("ignores what can't happen yet: progress, moved or failed before moving", () => {
    for (const now of [NO_MOVE, after(NO_MOVE, { type: "planned", plan }), after(NO_MOVE, { type: "refused", why: "no" })]) {
      for (const event of [{ type: "progress", done: 1, total: 2 }, { type: "moved" }, { type: "failed", why: "x" }] as HomeMoveEvent[]) {
        expect(after(now, event)).toBe(now);
      }
    }
  });
});
