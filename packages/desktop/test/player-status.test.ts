// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBACK_STATUSES, type PlaybackStatus } from "@ribbon/core/playback";
import { nodeHost } from "@ribbon/host-node/node";
import { AppController, type AppState, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { PlayButton } from "../src/ui/PlayerBar";
import { playerStatus } from "../src/ui/player-status";
import { ControllerContext } from "../src/ui/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("what the player says of itself", () => {
  it("says the same thing in the bar and the full player, but for room", () => {
    for (const status of PLAYBACK_STATUSES) {
      for (const error of [null, "Could not read the file. Still trying…", "Press play to continue"]) {
        const short = playerStatus({ status, error }, "short");
        const long = playerStatus({ status, error }, "long");
        if (short === "Reconnecting…") expect(long).toBe("Reconnecting to the file…");
        else expect(long).toBe(short);
      }
    }
  });

  it("puts what's wrong first, then a reconnect, then loading", () => {
    expect(playerStatus({ status: "reconnecting", error: "Could not read the file. Still trying…" }, "short")).toBe("Could not read the file. Still trying…");
    expect(playerStatus({ status: "reconnecting", error: null }, "short")).toBe("Reconnecting…");
    expect(playerStatus({ status: "loading", error: null }, "short")).toBe("Loading…");
    expect(playerStatus({ status: "buffering", error: null }, "long")).toBe("Loading…");
    expect(playerStatus({ status: "paused", error: "Press play to continue" }, "long")).toBe("Press play to continue");
  });

  it("says nothing while it plays, rests, or is a moment from sounding", () => {
    for (const status of ["paused", "starting", "playing"] as const) expect(playerStatus({ status, error: null }, "short")).toBeNull();
  });
});

describe("the play button", () => {
  /** The button's name, drawn for a player in `status`. */
  async function named(status: PlaybackStatus): Promise<string | null> {
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
    const c = new AppController(platform);
    (c as unknown as { set(p: Partial<AppState>): void }).set({ player: { ...c.getState().player, status } });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(ControllerContext.Provider, { value: c }, createElement(PlayButton, { size: "md" }))));
    const name = el.querySelector("button")?.getAttribute("aria-label") ?? null;
    act(() => root?.unmount());
    root = null;
    return name;
  }

  it("pauses from the press on, while the file loads and while it reconnects: the listener wants to hear it", async () => {
    expect(await named("paused")).toBe("Play");
    for (const status of ["starting", "loading", "playing", "buffering", "reconnecting"] as const) expect(await named(status)).toBe("Pause");
  });
});
