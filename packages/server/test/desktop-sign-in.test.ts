import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppController, type Platform } from "../../desktop/src/app/controller.ts";
import { memorySettings, memorySources } from "../../desktop/src/app/platform.ts";
import { nodeHost } from "@ribbon/host-node/node";
import { fakeIssuer, signInAt, type FakeIssuer } from "../../auth-pocket-id/test/fake-issuer.ts";
import { buildServer, type RibbonServer } from "../src/app.ts";
import { serverWithAdmin } from "./fixture.ts";

/**
 * The desktop's own controller connecting to a real server, each way a
 * server signs people in. Only the browser is stood in for: where the app
 * would open one and wait for it to come back, the test follows the same
 * addresses itself.
 */
describe("the desktop connecting to a server", () => {
  let dir: string;
  let issuer: FakeIssuer;
  let server: RibbonServer;
  let url = "";
  /** What the stand-in browser does next: goes through with it, or is closed while the app waits. */
  let browser: "signs in" | "is closed" = "signs in";
  let homes = 0;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-desktop-sign-in-"));
    issuer = await fakeIssuer();
    server = await buildServer({
      dataDir: path.join(dir, "data"),
      host: "127.0.0.1",
      port: 0,
      url: "https://ribbon.example",
      secret: "a test secret of thirty-two chars!!",
      signIn: { with: "pocket-id", url: issuer.url, clientId: issuer.clientId, clientSecret: issuer.clientSecret },
      admins: ["ann"],
    });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    await issuer.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    browser = "signs in";
    issuer.refuses = null;
  });

  /** As the app's own does (src-tauri/src/sign_in.rs): open the address, saying where to come back, and resolve with what came back. */
  const standInBrowser: NonNullable<Platform["browserSignIn"]> = {
    async wait(start) {
      if (browser === "is closed") throw new Error("cancelled");
      const out = await fetch(`${start}&return=${encodeURIComponent("http://127.0.0.1:9/signed-in")}`, { redirect: "manual" });
      const { callback } = await signInAt(out.headers.get("location")!);
      // The server knows itself by its public address; the test reaches it where it listens.
      const back = await fetch(`${url}${callback.pathname}${callback.search}`, { redirect: "manual" });
      return Object.fromEntries(new URL(back.headers.get("location")!).searchParams);
    },
    cancel: () => undefined,
  };

  /** The desktop app on a computer of its own, with a Ribbon folder of its own. */
  const desktop = (withBrowser = true) => {
    const home = path.join(dir, `home-${++homes}`);
    const platform: Platform = {
      host: nodeHost(),
      pickFolder: async () => null,
      allowFolder: async () => undefined,
      fileUrl: (p) => `file:///${p}`,
      sources: memorySources(),
      appSettings: memorySettings(),
      home: { path: async () => home, reveal: async () => undefined, reset: async () => false },
      ...(withBrowser ? { browserSignIn: standInBrowser } : {}),
    };
    return new AppController(platform);
  };

  it("learns from the server that its people sign in with Pocket ID", async () => {
    expect(await desktop().howToSignIn(url)).toEqual({ kind: "browser", name: "Pocket ID" });
  });

  it("connects through the browser, as whoever Pocket ID says signed in", async () => {
    const app = desktop();
    await app.connectServerThroughBrowser(url);
    const sources = app.getState().sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.server).toEqual({ url, person: "ann" });
    // The session is this computer's, named for it, and the server answers it.
    expect(server.db.prepare("SELECT device FROM device_session").all().map((row) => String(row.device))).toContainEqual(expect.stringMatching(/^Ribbon on /));
    expect(app.getState().sourceStatus[sources[0]!.id]?.signIn ?? false).toBe(false);
  });

  it("says why, in Pocket ID's refusal as the server put it, and connects to nothing", async () => {
    issuer.refuses = "access_denied";
    const app = desktop();
    await expect(app.connectServerThroughBrowser(url)).rejects.toThrow("isn't allowed in here");
    expect(app.getState().sources).toHaveLength(0);
  });

  it("connects to nothing when the wait for the browser is cancelled", async () => {
    browser = "is closed";
    const app = desktop();
    await expect(app.connectServerThroughBrowser(url)).rejects.toThrow("cancelled");
    expect(app.getState().sources).toHaveLength(0);
  });

  it("says so where it has no browser to open", async () => {
    await expect(desktop(false).connectServerThroughBrowser(url)).rejects.toThrow("can't open a browser");
  });
});

describe("the desktop asking a server with its own accounts how to sign in", () => {
  let dir: string;
  let server: RibbonServer;
  let url = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-desktop-password-"));
    ({ server } = await serverWithAdmin(dir));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is told to ask for a name and a password, and connects with them", async () => {
    const home = path.join(dir, "home");
    const app = new AppController({ host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => home, reveal: async () => undefined, reset: async () => false } });
    expect(await app.howToSignIn(url)).toEqual({ kind: "password" });
    await app.connectServer(url, "admin", "a long password");
    expect(app.getState().sources[0]!.server).toEqual({ url, person: "admin" });
  });
});
