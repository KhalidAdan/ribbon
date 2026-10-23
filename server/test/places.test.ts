import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { RibbonServer } from "../src/app.ts";
import { deviceFileName, logName, parseLog } from "../../src/core/poslog.ts";
import { serverWithAdmin } from "./fixture.ts";

const PHONE = "urn:uuid:11111111-1111-4111-8111-111111111111";
const DESKTOP = "urn:uuid:22222222-2222-4222-8222-222222222222";
const BROTHERS_PHONE = "urn:uuid:33333333-3333-4333-8333-333333333333";

/** A place in a book, as a device appends it to its log (docs/POSITION-FORMAT.md, section 3.1). */
const pos = (dev: string, seq: number, ms: number) => ({ v: 1, dev, seq, t: new Date(1_790_000_000_000 + seq).toISOString(), k: "pos", book: { ids: ["urn:ribbon:book:red"] }, why: "pause", ms });

// Each person's places, by device, read by cursor: only what's new, and
// nothing at all when nothing is.
describe("places", () => {
  let dir: string;
  let server: RibbonServer;
  let owner = "";
  let brother = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-places-"));
    const made = await serverWithAdmin(dir);
    server = made.server;
    owner = made.admin;
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${owner}` } })).json() as { code: string };
    brother = ((await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: "a long password" } })).json() as { token: string }).token;
  });
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const send = (token: string, device: { id: string; name: string }, records: unknown[]) => server.app.inject({ method: "POST", url: "/api/places", payload: { device, records }, headers: { authorization: `Bearer ${token}` } });
  const read = async (token: string, after?: string) => {
    const r = await server.app.inject({ method: "GET", url: `/api/places${after ? `?after=${after}` : ""}`, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    return r.json() as { records: { dev: string; ms: number }[]; devices: { id: string; name: string }[]; cursor: string };
  };

  let cursor = "";

  it("keeps what a device sends, in that device's own log", async () => {
    const sent = await send(owner, { id: PHONE, name: "Ribbon on the phone" }, [pos(PHONE, 1, 60_000), pos(PHONE, 2, 61_000)]);
    expect(sent.json()).toEqual({ accepted: 2, skipped: 0, added: 2 });
    const all = await read(owner);
    expect(all.records.map((r) => r.ms)).toEqual([60_000, 61_000]);
    expect(all.devices).toEqual([{ id: PHONE, name: "Ribbon on the phone" }]);
    cursor = all.cursor;
  });

  it("sends nothing when nothing is new, and only what's new after that", async () => {
    expect((await read(owner, cursor)).records).toEqual([]);
    await send(owner, { id: DESKTOP, name: "Ribbon on the desktop" }, [pos(DESKTOP, 3, 90_000)]);
    const fresh = await read(owner, cursor);
    expect(fresh.records.map((r) => [r.dev, r.ms])).toEqual([[DESKTOP, 90_000]]);
    expect((await read(owner, fresh.cursor)).records).toEqual([]);
    cursor = fresh.cursor;
  });

  it("keeps each person's places to themselves", async () => {
    expect((await read(brother)).records).toEqual([]);
    await send(brother, { id: BROTHERS_PHONE, name: "phone" }, [pos(BROTHERS_PHONE, 1, 5_000)]);
    expect((await read(brother)).records.map((r) => r.ms)).toEqual([5_000]);
    expect((await read(owner, cursor)).records).toEqual([]);
  });

  it("takes from a device only its own records, and only valid ones", async () => {
    const mixed = await send(owner, { id: PHONE, name: "Ribbon on the phone" }, [pos(DESKTOP, 4, 1), { v: 1, nonsense: true }, "not a record", pos(PHONE, 5, 70_000)]);
    expect(mixed.json()).toEqual({ accepted: 1, skipped: 3, added: 1 });
    const bad = await send(owner, { id: "../../etc", name: "x" }, [pos(PHONE, 6, 1)]);
    expect(bad.statusCode).toBe(400);
    cursor = (await read(owner, cursor)).cursor;
  });

  it("keeps a record sent twice once, as a retry sends it", async () => {
    const first = await send(owner, { id: PHONE, name: "Ribbon on the phone" }, [pos(PHONE, 7, 80_000)]);
    const again = await send(owner, { id: PHONE, name: "Ribbon on the phone" }, [pos(PHONE, 7, 80_000)]);
    expect(first.json()).toEqual({ accepted: 1, skipped: 0, added: 1 });
    expect(again.json()).toEqual({ accepted: 1, skipped: 0, added: 0 });
    expect((await read(owner, cursor)).records.map((r) => r.ms)).toEqual([80_000]);
  });

  it("hands back the whole log as a file in the position-log format", async () => {
    const r = await server.app.inject({ method: "GET", url: "/api/places/export", headers: { authorization: `Bearer ${owner}` } });
    expect(r.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="ribbon-places-.+\.ndjson"$/);
    const log = parseLog(r.body);
    expect(log.skipped).toBe(0);
    expect(log.records.map((x) => [x.dev, x.seq])).toEqual([[PHONE, 1], [PHONE, 2], [DESKTOP, 3], [PHONE, 5], [PHONE, 7]]);
  });

  it("asks for a sign-in", async () => {
    expect((await server.app.inject({ method: "GET", url: "/api/places" })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "POST", url: "/api/places", payload: {} })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(401);
  });

  it("tells a person's other devices at once that their place moved", async () => {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.app.server.address() as AddressInfo).port;
    const abort = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { authorization: `Bearer ${owner}` }, signal: abort.signal });
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const until = async (text: string) => {
      while (!seen.includes(text)) seen += decoder.decode((await reader.read()).value);
    };
    await until(": connected");
    await send(owner, { id: DESKTOP, name: "Ribbon on the desktop" }, [pos(DESKTOP, 8, 95_000)]);
    await until("event: places");
    expect(seen).toContain(`data: {"device":"${DESKTOP}"}`);
    abort.abort();
  });
});

describe("places a server kept as files before", () => {
  it("are taken into the database once, and the files set aside", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ribbon-places-files-"));
    const kept = path.join(dir, "data", "people", "person-1", "places");
    mkdirSync(kept, { recursive: true });
    writeFileSync(path.join(kept, logName(PHONE)), [pos(PHONE, 1, 1_000), pos(PHONE, 2, 2_000)].map((r) => `${JSON.stringify(r)}\n`).join(""));
    writeFileSync(path.join(kept, deviceFileName(PHONE)), JSON.stringify({ id: PHONE, name: "Ribbon on the phone" }));
    const { server } = await serverWithAdmin(dir);
    const all = server.places.since("person-1", undefined);
    expect(all.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(all.devices).toEqual([{ id: PHONE, name: "Ribbon on the phone" }]);
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(`${kept}-imported`)).toBe(true);
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
