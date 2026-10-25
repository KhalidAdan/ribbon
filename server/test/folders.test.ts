import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { findFolder } from "../src/library/folders.ts";
import { importAs, makeLibraries, serverWithAdmin } from "./fixture.ts";

/**
 * A folder the admin picked on another computer, found where the server has
 * it: the share the apps add folders from, mounted somewhere else here.
 */
describe("a folder picked on another computer", () => {
  let dir: string;
  let share: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-folders-"));
    // The share, as this machine has it: a "Books" folder deep in it, and another "Books" at its top.
    share = path.join(dir, "mnt", "media");
    mkdirSync(path.join(share, "Audiobooks", "Fantasy", "Books"), { recursive: true });
    mkdirSync(path.join(share, "Books"), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is found under the server's folders from a Windows drive, a Windows share, or a Mac", async () => {
    const deep = path.join(share, "Audiobooks", "Fantasy");
    expect(await findFolder("M:\\Audiobooks\\Fantasy", [share])).toBe(deep);
    expect(await findFolder("\\\\nas\\media\\Audiobooks\\Fantasy\\", [share])).toBe(deep);
    expect(await findFolder("/Volumes/media/Audiobooks/Fantasy", [share])).toBe(deep);
  });

  it("is the longest stretch of its path that's there, not a shorter one of the same name", async () => {
    expect(await findFolder("M:\\Audiobooks\\Fantasy\\Books", [share])).toBe(path.join(share, "Audiobooks", "Fantasy", "Books"));
    expect(await findFolder("M:\\Books", [share])).toBe(path.join(share, "Books"));
  });

  it("is taken as it is when it's on this machine, and looked for nowhere else", async () => {
    const here = path.join(share, "Books");
    expect(await findFolder(here, [])).toBe(here);
    expect(await findFolder("M:\\Audiobooks\\Fantasy", [])).toBeNull();
  });

  it("isn't found when it's not there, or when its path climbs out of the folders", async () => {
    expect(await findFolder("M:\\Audiobooks\\Science Fiction", [share])).toBeNull();
    expect(await findFolder("M:\\", [share])).toBeNull();
    expect(await findFolder("M:\\..\\media\\Books", [share])).toBeNull();
  });
});

describe("adding a folder picked on Windows", () => {
  let dir: string;
  let server: RibbonServer;
  let admin = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-windows-"));
    // The shelf is at <dir>/shelf here; on the Windows computer the share holding it is drive M:.
    makeLibraries(dir);
    ({ server, admin } = await serverWithAdmin(dir, { folders: [dir] }));
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies its books in from where the server has the share", async () => {
    const { status, job } = await importAs(server, admin, "M:\\shelf\\Author Two");
    expect(status).toBe(202);
    expect(job.state).toBe("done");
    expect(job.progress).toMatchObject({ folder: path.join(dir, "shelf", "Author Two"), found: 1, added: 1 });
  });

  it("says where it looked when the folder isn't there", async () => {
    const answer = await server.app.inject({ method: "POST", url: "/api/library/import", payload: { folder: "M:\\shelf\\Author Three" }, headers: { authorization: `Bearer ${admin}` } });
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toEqual({ error: `The server can't find M:\\shelf\\Author Three in ${dir}.` });
  });
});
