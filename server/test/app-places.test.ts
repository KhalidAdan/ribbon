import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { ServerClient } from "../../src/app/server/client.ts";
import { PlacesSync } from "../../src/app/server/places-sync.ts";
import { encodeRecord, logName, mergePlaces, parseLog, ribbonClaim, type LogRecord } from "../../src/core/poslog.ts";
import { nodeHost } from "../../src/host/node.ts";
import { serverWithAdmin } from "./fixture.ts";

const PHONE = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DESKTOP = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BROTHERS_PHONE = "urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BOOK = ribbonClaim("red");

/** A place in a book, as a device appends it to its log (docs/POSITION-FORMAT.md, section 3.1). */
const pos = (dev: string, seq: number, ms: number) => ({ v: 1, dev, seq, t: new Date(1_790_000_000_000 + seq).toISOString(), k: "pos", book: { ids: [BOOK] }, why: "pause", ms });

/**
 * The apps' side of places (src/app/server/places-sync.ts) against this
 * server: each device is a server source's folder on its own disk, with
 * its log in it, carried to and from the server.
 */
describe("places between the apps, through the server", () => {
  let dir: string;
  let server: RibbonServer;
  let url = "";
  let owner = "";
  let brother = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-app-places-"));
    const made = await serverWithAdmin(dir);
    server = made.server;
    owner = made.admin;
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${owner}` } })).json() as { code: string };
    brother = ((await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: "a long password" } })).json() as { token: string }).token;
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A device: its folder for the server's source, a way to add to its own log, and what its folder holds from every log. */
  async function device(id: string, name: string, token: string) {
    const root = mkdtempSync(path.join(dir, "device-"));
    const positions = path.join(root, ".ribbon", "positions");
    await mkdir(positions, { recursive: true });
    return {
      sync: new PlacesSync(new ServerClient(url, token), nodeHost(), root, async () => ({ id, name, app: "ribbon" })),
      append: (r: object) => appendFile(path.join(positions, logName(id)), encodeRecord(r as LogRecord)),
      rewriteOwnLog: (records: object[]) => writeFile(path.join(positions, logName(id)), records.map((r) => encodeRecord(r as LogRecord)).join("")),
      async records(): Promise<LogRecord[]> {
        const names = (await readdir(positions)).filter((n) => n.endsWith(".ndjson"));
        return (await Promise.all(names.map(async (n) => parseLog(await readFile(path.join(positions, n), "utf8")).records))).flat();
      },
      async deviceNames(): Promise<string[]> {
        const names = (await readdir(positions)).filter((n) => n.endsWith(".json"));
        return Promise.all(names.map(async (n) => (JSON.parse(await readFile(path.join(positions, n), "utf8")) as { name: string }).name));
      },
    };
  }

  it("takes a place from the phone to the desktop, once, and only what's new after", async () => {
    const phone = await device(PHONE, "Ribbon on Ann's iPhone", owner);
    const desktop = await device(DESKTOP, "Ribbon on the desk", owner);

    await phone.append(pos(PHONE, 1, 60_000));
    expect(await phone.sync.sync()).toBe(false);
    expect(await desktop.sync.sync()).toBe(true);
    expect(mergePlaces(await desktop.records()).get("red")).toMatchObject({ dev: PHONE, ms: 60_000 });
    expect(await desktop.deviceNames()).toEqual(["Ribbon on Ann's iPhone"]);
    expect(await desktop.sync.sync()).toBe(false);

    // The desktop moves on; the phone hears of it, and the desktop's copy of the phone's log only grows by what's new.
    await desktop.append(pos(DESKTOP, 4, 90_000));
    await phone.append(pos(PHONE, 3, 75_000));
    await desktop.sync.sync();
    expect(await phone.sync.sync()).toBe(true);
    expect(mergePlaces(await phone.records()).get("red")).toMatchObject({ dev: DESKTOP, ms: 90_000 });
    await desktop.sync.sync();
    expect((await desktop.records()).filter((r) => r.dev === PHONE).map((r) => r.seq)).toEqual([1, 3]);
  });

  it("sends nothing twice when the log here is compacted", async () => {
    const phone = await device(PHONE, "Ribbon on Ann's iPhone", owner);
    await phone.append(pos(PHONE, 10, 1_000));
    await phone.append(pos(PHONE, 11, 2_000));
    await phone.sync.sync();
    // Compacting keeps the latest place per book: the same record, already sent.
    await phone.rewriteOwnLog([pos(PHONE, 11, 2_000)]);
    await phone.append(pos(PHONE, 12, 3_000));
    await phone.sync.sync();

    const fresh = await device(DESKTOP, "Ribbon on the desk", owner);
    await fresh.sync.sync();
    expect((await fresh.records()).filter((r) => r.dev === PHONE).map((r) => r.seq)).toEqual([1, 3, 10, 11, 12]);
  });

  it("keeps each person's places their own", async () => {
    const brothers = await device(BROTHERS_PHONE, "Ribbon on a brother's phone", brother);
    await brothers.append(pos(BROTHERS_PHONE, 20, 5_000));
    await brothers.sync.sync();
    const desktop = await device(DESKTOP, "Ribbon on the desk", owner);
    await desktop.sync.sync();
    expect((await desktop.records()).some((r) => r.dev === BROTHERS_PHONE)).toBe(false);
    expect((await brothers.records()).map((r) => r.dev)).toEqual([BROTHERS_PHONE]);
  });

  it("says over the event stream when another device moved a place", async () => {
    const heard: { type: string; data: unknown }[] = [];
    const stop = new AbortController();
    const listening = new ServerClient(url, owner).events((type, data) => heard.push({ type, data }), stop.signal).catch(() => undefined);
    // Give the stream a moment to open before anything is sent.
    await new Promise((r) => setTimeout(r, 200));
    const phone = await device(PHONE, "Ribbon on Ann's iPhone", owner);
    await phone.append(pos(PHONE, 30, 7_000));
    await phone.sync.sync();
    for (let i = 0; i < 40 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    stop.abort();
    await listening;
    expect(heard).toEqual([{ type: "places", data: { device: PHONE } }]);
  });
});
