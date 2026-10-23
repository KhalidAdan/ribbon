import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { ServerClient } from "../../src/app/server/client.ts";
import { ServerLog } from "../../src/app/server/server-log.ts";
import { encodeRecord, logName, mergePlaces, ribbonClaim, type LogRecord } from "../../src/core/poslog.ts";
import { nodeHost } from "../../src/host/node.ts";
import { serverWithAdmin } from "./fixture.ts";

const PHONE = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DESKTOP = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BROTHERS_PHONE = "urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BOOK = ribbonClaim("red");

/** A place in a book, as a device appends it to its log (docs/POSITION-FORMAT.md, section 3.1). */
const pos = (dev: string, seq: number, ms: number) => ({ v: 1, dev, seq, t: new Date(1_790_000_000_000 + seq).toISOString(), k: "pos", book: { ids: [BOOK] }, why: "pause", ms }) as LogRecord;

/**
 * The apps' side of places (src/app/server/server-log.ts) against this
 * server: each device keeps the log as last read in its own folder, and the
 * server holds it.
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

  /** A device: the folder its log is kept in, and that log. */
  const device = (id: string, name: string, token: string, root = mkdtempSync(path.join(dir, "device-")), at = url) => ({
    root,
    log: new ServerLog(new ServerClient(at, token), nodeHost(), root, async () => ({ id, name, app: "ribbon" })),
  });
  const placeIn = async (log: ServerLog) => mergePlaces((await log.all()).records).get("red");
  const seqsFrom = async (log: ServerLog, dev: string) => (await log.all()).records.filter((r) => r.dev === dev).map((r) => r.seq);

  it("takes a place from the phone to the desktop, once, and only what's new after", async () => {
    const phone = device(PHONE, "Ribbon on Ann's iPhone", owner);
    const desktop = device(DESKTOP, "Ribbon on the desk", owner);

    await phone.log.add(pos(PHONE, 1, 60_000));
    expect(await phone.log.sync()).toBe(false);
    expect(await desktop.log.sync()).toBe(true);
    expect(await placeIn(desktop.log)).toMatchObject({ dev: PHONE, ms: 60_000 });
    expect((await desktop.log.all()).devices).toEqual([{ id: PHONE, name: "Ribbon on Ann's iPhone" }]);
    expect(await desktop.log.sync()).toBe(false);

    // The desktop moves on; the phone hears of it, and the desktop has each of the phone's records once.
    await desktop.log.add(pos(DESKTOP, 4, 90_000));
    await phone.log.add(pos(PHONE, 3, 75_000));
    await desktop.log.sync();
    expect(await phone.log.sync()).toBe(true);
    expect(await placeIn(phone.log)).toMatchObject({ dev: DESKTOP, ms: 90_000 });
    await desktop.log.sync();
    expect(await seqsFrom(desktop.log, PHONE)).toEqual([1, 3]);
  });

  it("keeps a place made while the server's away, across a restart, and sends it when it's back", async () => {
    const away = device(PHONE, "Ribbon on Ann's iPhone", owner, undefined, "http://127.0.0.1:9");
    await away.log.add(pos(PHONE, 10, 10_000));
    await expect(away.log.sync()).rejects.toThrow(/Couldn't reach/);
    // The app starts again, the server reachable now: the same folder, a new log over it.
    const back = device(PHONE, "Ribbon on Ann's iPhone", owner, away.root);
    expect(await placeIn(back.log)).toMatchObject({ ms: 10_000 });
    await back.log.sync();
    const desktop = device(DESKTOP, "Ribbon on the desk", owner);
    await desktop.log.sync();
    expect(await seqsFrom(desktop.log, PHONE)).toEqual([1, 3, 10]);
  });

  it("sends on what Ribbon 0.14 kept in the folder, and the server keeps each record once", async () => {
    const phone = device(PHONE, "Ribbon on Ann's iPhone", owner);
    // 0.14's log of this device: one record already sent, one not.
    await mkdir(path.join(phone.root, ".ribbon", "positions"), { recursive: true });
    await writeFile(path.join(phone.root, ".ribbon", "positions", logName(PHONE)), [pos(PHONE, 10, 10_000), pos(PHONE, 11, 11_000)].map((r) => encodeRecord(r)).join(""));
    await phone.log.sync();
    const desktop = device(DESKTOP, "Ribbon on the desk", owner);
    await desktop.log.sync();
    expect(await seqsFrom(desktop.log, PHONE)).toEqual([1, 3, 10, 11]);
  });

  it("keeps each person's places their own", async () => {
    const brothers = device(BROTHERS_PHONE, "Ribbon on a brother's phone", brother);
    await brothers.log.add(pos(BROTHERS_PHONE, 20, 5_000));
    await brothers.log.sync();
    const desktop = device(DESKTOP, "Ribbon on the desk", owner);
    await desktop.log.sync();
    expect((await desktop.log.all()).records.some((r) => r.dev === BROTHERS_PHONE)).toBe(false);
    expect((await brothers.log.all()).records.map((r) => r.dev)).toEqual([BROTHERS_PHONE]);
  });

  it("says over the event stream when another device moved a place", async () => {
    const heard: { type: string; data: unknown }[] = [];
    const stop = new AbortController();
    const listening = new ServerClient(url, owner).events((type, data) => heard.push({ type, data }), stop.signal).catch(() => undefined);
    // Give the stream a moment to open before anything is sent.
    await new Promise((r) => setTimeout(r, 200));
    const phone = device(PHONE, "Ribbon on Ann's iPhone", owner);
    await phone.log.add(pos(PHONE, 30, 7_000));
    await phone.log.sync();
    for (let i = 0; i < 40 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    stop.abort();
    await listening;
    expect(heard).toEqual([{ type: "places", data: { device: PHONE } }]);
  });
});
