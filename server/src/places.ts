import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deviceFileName, encodeRecord, logName, parseLog, type DeviceInfo, type LogRecord } from "../../src/core/poslog.ts";

/** A device's id, as the position log writes it: a random UUID, never derived from anything (docs/POSITION-FORMAT.md, section 2). */
const DEVICE_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A person's id from Better Auth, used as a folder name: letters, digits, dashes and underscores only. */
const PERSON_ID = /^[A-Za-z0-9_-]+$/;

/** Where a device has read each log up to: log file name to byte offset, sent back and forth as an opaque string. */
type Cursor = Record<string, number>;

export interface NewPlaces {
  records: LogRecord[];
  /** Who wrote them, by device id: what a device calls itself ("Ribbon on Ann's iPhone"). */
  devices: DeviceInfo[];
  /** What to ask with next time, so only newer records come back. */
  cursor: string;
}

/**
 * Each person's places on the server, as the position log
 * (docs/POSITION-FORMAT.md): `people/<id>/places/`, one append-only
 * `.ndjson` per device and a `.json` saying who the device is. A device
 * sends what it appended; the server adds those lines to that device's
 * log and to no other, so nothing can conflict, and merging stays the
 * apps' own (`src/core/poslog.ts`).
 *
 * Reading is by cursor: how far into each log the device has read. Only
 * whole lines newer than that come back, and nothing when nothing's new.
 */
export class Places {
  constructor(private readonly dataDir: string) {}

  /** Add a device's records to its log. Records that aren't valid, or that another device wrote, are left out and counted. */
  async append(personId: string, device: DeviceInfo, records: readonly unknown[]): Promise<{ accepted: number; skipped: number }> {
    const dir = this.dir(personId);
    if (!DEVICE_ID.test(device.id)) throw new PlacesError("A device's id is a urn:uuid: made once per installation.");
    const lines: string[] = [];
    let skipped = 0;
    for (const record of records) {
      const line = typeof record === "object" && record !== null ? encodeRecord(record as Record<string, unknown>) : "";
      const parsed = parseLog(line).records[0];
      // Single writer: a device only ever adds to its own log.
      if (parsed && parsed.dev === device.id) lines.push(line);
      else skipped++;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, deviceFileName(device.id)), JSON.stringify({ id: device.id, name: device.name ?? "", ...(device.app ? { app: device.app } : {}), format: "ribbon-position-log/1" }));
    // One append for the whole batch: a log only ever grows by whole lines.
    if (lines.length > 0) await appendFile(path.join(dir, logName(device.id)), lines.join(""));
    return { accepted: lines.length, skipped };
  }

  /** Every record newer than `after` in each of the person's logs, and the cursor to ask with next. */
  async since(personId: string, after: string | undefined): Promise<NewPlaces> {
    const dir = this.dir(personId);
    const cursor = decodeCursor(after);
    const records: LogRecord[] = [];
    const devices: DeviceInfo[] = [];
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith(".ndjson")).sort()) {
      const file = path.join(dir, name);
      const from = Math.max(0, cursor[name] ?? 0);
      const size = (await stat(file)).size;
      if (size <= from) continue;
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(size - from);
        await handle.read(buffer, 0, buffer.length, from);
        // Only whole lines: a line still being written is read next time, whole.
        const end = buffer.lastIndexOf(0x0a) + 1;
        if (end === 0) continue;
        records.push(...parseLog(buffer.subarray(0, end).toString("utf8")).records);
        cursor[name] = from + end;
      } finally {
        await handle.close();
      }
    }
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const info = await readFile(path.join(dir, name), "utf8").then((t) => JSON.parse(t) as DeviceInfo).catch(() => null);
      if (info?.id) devices.push({ id: info.id, name: info.name ?? "" });
    }
    return { records, devices, cursor: encodeCursor(cursor) };
  }

  private dir(personId: string): string {
    if (!PERSON_ID.test(personId)) throw new PlacesError("Not a person on this server.");
    return path.join(this.dataDir, "people", personId, "places");
  }
}

/** Something about a request for places that can't be done, said to the person asking. */
export class PlacesError extends Error {}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** A cursor as a device sent it, or the start of every log when it's absent or unreadable. */
function decodeCursor(after: string | undefined): Cursor {
  if (!after) return {};
  try {
    const parsed = JSON.parse(Buffer.from(after, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([k, v]) => k.endsWith(".ndjson") && !k.includes("/") && typeof v === "number" && Number.isFinite(v)));
  } catch {
    return {};
  }
}
