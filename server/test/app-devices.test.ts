import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { AppController, type Platform } from "../../src/app/controller.ts";
import { memorySettings, memorySources } from "../../src/app/platform.ts";
import { nodeHost } from "../../src/host/node.ts";
import { importAs, makeLibraries, serverWithAdmin } from "./fixture.ts";

/**
 * Two of one person's devices, each the whole app (AppController) on its
 * own folders, signed in to this server: what one does, the other hears
 * of over the event stream and takes in.
 */
describe("one person's two devices, through the server", () => {
  let dir: string;
  let server: RibbonServer;
  let url = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-app-devices-"));
    const made = await serverWithAdmin(dir);
    server = made.server;
    await importAs(server, made.admin, makeLibraries(dir).shelf);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  };

  async function aDevice(): Promise<AppController> {
    const home = mkdtempSync(path.join(dir, "home-"));
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => home, reveal: async () => undefined, reset: async () => false } };
    const c = new AppController(platform);
    await c.boot();
    await c.connectServer(url, "admin", "a long password");
    await until(() => c.getState().books.length === 2);
    return c;
  }

  it("finishing a book on one shows it finished on the other", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const phone = await aDevice();
    const desktop = await aDevice();
    const book = phone.getState().books.find((b) => b.book.title === "Red Book")!;
    expect(book.remote).toBeTruthy();

    await phone.markFinished(book.book.id);
    const finishedOn = (c: AppController) => c.getState().history.reads.some((r) => r.book.ids.includes(`urn:ribbon:${book.book.id}`) && !!r.finished);
    expect(finishedOn(phone)).toBe(true);
    await until(() => finishedOn(desktop));
    expect(finishedOn(desktop)).toBe(true);
  });
});
