// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AppController, type AppState, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { nodeHost } from "@ribbon/host-node/node";
import { TopBar } from "../src/ui/Shell";
import { ControllerContext } from "../src/ui/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Transcribing for a server runs behind everything, and closing Ribbon
 * waits on it or stops it, so the top of every page says when it's going.
 */
describe("the top bar", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  /** The bar with the app's state as given, and what it says about what's going on. */
  const said = (state: Partial<AppState>) => {
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
    const app = new AppController(platform);
    (app as unknown as { set(s: Partial<AppState>): void }).set(state);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <ControllerContext.Provider value={app}>
          <TopBar crumbs={[]} query="" onQuery={() => undefined} count={null} onSubmit={() => undefined} />
        </ControllerContext.Provider>,
      ),
    );
    return host.querySelector("[role=status]")?.textContent ?? null;
  };

  it("says nothing when nothing's going on", () => {
    expect(said({})).toBeNull();
  });

  it("says which book is being transcribed, and how far along it is", () => {
    expect(said({ transcribingForServer: { title: "Era of Ruin", done: 40, total: 100 } })).toBe("Transcribing Era of Ruin…40%");
  });

  it("gives way to a check of the folders, which ends soon", () => {
    const scanning = { walked: 0, done: 0 } as AppState["scanning"];
    expect(said({ scanning, transcribingForServer: { title: "Era of Ruin", done: 40, total: 100 } })).toBe("Checking for changes…");
  });
});
