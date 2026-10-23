import { readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { encodeRecord, parseLog, type DeviceInfo, type LogRecord } from "../../src/core/poslog.ts";

/** A device's id, as the position log writes it: a random UUID, never derived from anything (docs/POSITION-FORMAT.md, section 2). */
const DEVICE_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most records one answer carries; a device asks again, from the cursor, for the rest. */
const PAGE = 2000;

export interface NewPlaces {
  records: LogRecord[];
  /** Who wrote them, by device id: what a device calls itself ("Ribbon on Ann's iPhone"). */
  devices: DeviceInfo[];
  /** What to ask with next time, so only newer records come back. */
  cursor: string;
  /** More than one answer holds: ask again with the cursor. */
  more: boolean;
}

/**
 * Each person's places on the server (docs/SERVER.md, section 5), in its
 * database: one row for each record a device appended to its position log
 * (docs/POSITION-FORMAT.md), in the order the server took them, and one row
 * per device saying who it is. A device sends what it appended; a record
 * sent twice, by a retry, is kept once, by its device and sequence number.
 * The server never changes a record, and merging stays the apps' own
 * (`src/core/poslog.ts`).
 *
 * Reading is by cursor, the last row a device has read: only newer records
 * come back, and nothing when nothing's new. The whole log also comes back
 * as one file in the position-log format, so a person's places are theirs
 * to take away.
 */
export class Places {
  constructor(private readonly db: DatabaseSync) {}

  /** Add a device's records. Records that aren't valid, or that another device wrote, are left out and counted; `added` is how many were new. */
  append(personId: string, device: DeviceInfo, records: readonly unknown[], now = Date.now()): { accepted: number; skipped: number; added: number } {
    if (!DEVICE_ID.test(device.id)) throw new PlacesError("A device's id is a urn:uuid: made once per installation.");
    let accepted = 0;
    let skipped = 0;
    let added = 0;
    const insert = this.db.prepare("INSERT OR IGNORE INTO place (person_id, device_id, seq, record, added_at) VALUES (?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO place_device (person_id, device_id, name, app) VALUES (?, ?, ?, ?) ON CONFLICT (person_id, device_id) DO UPDATE SET name = excluded.name, app = excluded.app")
        .run(personId, device.id, device.name ?? "", device.app ?? null);
      for (const record of records) {
        const line = typeof record === "object" && record !== null ? encodeRecord(record as Record<string, unknown>) : "";
        const parsed = parseLog(line).records[0];
        // Single writer: a device only ever adds to its own log.
        if (!parsed || parsed.dev !== device.id) {
          skipped++;
          continue;
        }
        accepted++;
        added += Number(insert.run(personId, device.id, parsed.seq, line.trimEnd(), now).changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { accepted, skipped, added };
  }

  /** The last sequence number the server has from a device: what its next record must go past. 0 for a device it hasn't heard from. */
  lastSeq(personId: string, deviceId: string): number {
    return Number(this.db.prepare("SELECT max(seq) AS seq FROM place WHERE person_id = ? AND device_id = ?").get(personId, deviceId)?.seq ?? 0);
  }

  /** Every record newer than `after`, from every one of the person's devices, and the cursor to ask with next. */
  since(personId: string, after: string | undefined): NewPlaces {
    const from = /^\d+$/.test(after ?? "") ? Number(after) : 0;
    const rows = this.db.prepare("SELECT id, record FROM place WHERE person_id = ? AND id > ? ORDER BY id LIMIT ?").all(personId, from, PAGE + 1);
    const page = rows.slice(0, PAGE);
    const records = parseLog(page.map((r) => String(r.record)).join("\n")).records;
    const devices = this.db
      .prepare("SELECT device_id, name FROM place_device WHERE person_id = ?")
      .all(personId)
      .map((d) => ({ id: String(d.device_id), name: String(d.name) }));
    const last = page.at(-1);
    return { records, devices, cursor: String(last ? Number(last.id) : from), more: rows.length > PAGE };
  }

  /** The person's whole log, every device's records in the order the server took them: the position-log format, one record a line. */
  export(personId: string): string {
    return this.db
      .prepare("SELECT record FROM place WHERE person_id = ? ORDER BY id")
      .all(personId)
      .map((r) => `${String(r.record)}\n`)
      .join("");
  }

  /**
   * Places a server before 0.15 kept as files (`people/<id>/places/`, one
   * log per device), taken into the database once. Each folder is renamed
   * when it's in, so this runs once, and the files stay for anyone who
   * wants them.
   */
  async importFiles(dataDir: string): Promise<number> {
    let imported = 0;
    const people = await readdir(path.join(dataDir, "people")).catch(() => [] as string[]);
    for (const person of people) {
      const dir = path.join(dataDir, "people", person, "places");
      const names = await readdir(dir).catch(() => null);
      if (!names) continue;
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const info = await readFile(path.join(dir, name), "utf8").then((t) => JSON.parse(t) as DeviceInfo).catch(() => null);
        if (!info?.id || !DEVICE_ID.test(info.id)) continue;
        const log = await readFile(path.join(dir, name.replace(/\.json$/, ".ndjson")), "utf8").catch(() => "");
        imported += this.append(person, info, parseLog(log).records).added;
      }
      await rename(dir, `${dir}-imported`);
    }
    return imported;
  }
}

/** Something about a request for places that can't be done, said to the person asking. */
export class PlacesError extends Error {}
