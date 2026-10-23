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

/**
 * Adding a folder the old way, Settings → Add a folder, when the app is
 * signed in to a server: its admin's folder goes into the server, and
 * everyone's shelf fills from it; nobody else adds folders.
 */
describe("adding a folder through a server", () => {
  let dir: string;
  let server: RibbonServer;
  let url = "";
  let shelf = "";
  let copies = "";
  let memberPassword = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-app-add-"));
    ({ shelf, copies } = makeLibraries(dir));
    const made = await serverWithAdmin(dir);
    server = made.server;
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${made.admin}` } })).json() as { code: string };
    memberPassword = "a brother's password";
    await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: memberPassword } });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const until = async (ok: () => boolean, ms = 15_000) => {
    for (let i = 0; i < ms / 25 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  };

  async function signedIn(name: string, password: string, picked: string) {
    const home = mkdtempSync(path.join(dir, "home-"));
    const pickFolder = vi.fn(async () => picked);
    const platform: Platform = { host: nodeHost(), pickFolder, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => home, reveal: async () => undefined, reset: async () => false } };
    const c = new AppController(platform);
    await c.boot();
    await c.connectServer(url, name, password);
    return { c, pickFolder };
  }

  it("puts the admin's folder on everyone's shelf, and only the admin adds one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const admin = await signedIn("admin", "a long password", shelf);
    const brother = await signedIn("brother", memberPassword, shelf);
    await until(() => admin.c.getState().canAddFolders && !brother.c.getState().canAddFolders);
    expect(admin.c.getState().canAddFolders).toBe(true);
    expect(brother.c.getState().canAddFolders).toBe(false);

    // The brother's Add a folder does nothing: no picker, nothing added.
    await brother.c.pickLibrary();
    expect(brother.pickFolder).not.toHaveBeenCalled();

    // The admin's goes into the server, with progress as a scan shows it, and both shelves fill.
    const stages: string[] = [];
    const watching = setInterval(() => {
      const s = admin.c.getState().scanning;
      if (s?.copying && s.stage && stages.at(-1) !== s.stage) stages.push(s.stage);
    }, 10);
    await admin.c.pickLibrary();
    clearInterval(watching);
    expect(admin.pickFolder).toHaveBeenCalledTimes(1);
    expect(stages[0]).toBe("Looking through shelf…");
    expect(admin.c.getState().scanning).toBeNull();
    const titles = (c: AppController) => c.getState().books.map((b) => b.book.title).sort();
    expect(titles(admin.c)).toEqual(["Long Book", "Red Book"]);
    await until(() => titles(brother.c).length === 2);
    expect(titles(brother.c)).toEqual(["Long Book", "Red Book"]);
  });

  it("shows two folders added at once as one line that never takes turns", async () => {
    const admin = await signedIn("admin", "a long password", shelf);
    await until(() => admin.c.getState().canAddFolders);
    admin.pickFolder.mockResolvedValueOnce(copies);
    const stages: string[] = [];
    const watching = setInterval(() => {
      const stage = admin.c.getState().scanning?.stage;
      if (stage && stages.at(-1) !== stage) stages.push(stage);
    }, 5);
    await Promise.all([admin.c.pickLibrary(), admin.c.pickLibrary()]);
    clearInterval(watching);
    expect(stages[0]).toBe("Looking through copies… Then 1 more folder.");
    // Each line shows once: nothing goes back to a line it showed before.
    expect(new Set(stages).size).toBe(stages.length);
    expect(admin.c.getState().scanning).toBeNull();
  });

  it("says so when the server can't see the folder", async () => {
    const admin = await signedIn("admin", "a long password", path.join(dir, "not on the server"));
    await until(() => admin.c.getState().canAddFolders);
    await admin.c.pickLibrary();
    expect(admin.c.getState().error).toBe("The server can't see not on the server. It reads a folder at the path it has on this machine, so the folder has to be at that same path on the server's computer too.");
  });
});
