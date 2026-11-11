import { describe, expect, it } from "vitest";
import { Latest } from "@ribbon/core/latest";

describe("asks where only the newest counts", () => {
  it("an ask is current until another begins, and never again after", () => {
    const opening = new Latest();
    const first = opening.ask();
    expect(first.current()).toBe(true);
    const second = opening.ask();
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
    opening.ask();
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(false);
  });

  it("asks of one kind leave another kind's alone", () => {
    const player = new Latest();
    const reader = new Latest();
    const play = player.ask();
    reader.ask();
    expect(play.current()).toBe(true);
  });
});
