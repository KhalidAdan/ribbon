import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { LOG_EXT, parseLog, ribbonClaim, textClaim, type DeviceInfo, type LogRecord } from "@ribbon/core/poslog";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { localIdOf } from "@ribbon/core/server-books";
import { isDeviceId, type Places } from "../places.ts";
import type { ListedBook } from "./books.ts";
import { librariesOf } from "./records.ts";

/** One library's position logs: every device's records, and who the devices are. */
interface FolderLog {
  records: LogRecord[];
  devices: Map<string, DeviceInfo>;
}

/**
 * What a folder knows of where someone is in its books, brought in with the
 * books (docs/SERVER.md, section 11): someone who used Ribbon alone and then
 * adds a server keeps their place, bookmarks and listening history.
 *
 * Every record in the folder's position logs about a book comes in as it
 * was written, keeping its device and sequence number. The server keeps a
 * record once by those two, so adding a folder again adds nothing twice, and
 * a record's place among that device's others never changes, so an old place
 * can't get ahead of a newer one. Only the name of the book changes: a folder
 * knows a book by its path, and the server's book has an id of its own.
 *
 * They become the places of the person adding the folder, since a log doesn't
 * say whose it is. Only the logs are read: a place that only Ribbon 0.4's
 * per-book files hold stays there.
 */
export class FolderPlaces {
  /** Each library's logs, read once however many of its books come in. */
  private readonly logs = new Map<string, Promise<FolderLog>>();

  constructor(
    private readonly places: Places,
    private readonly person: string,
  ) {}

  /** Bring in the records about one book from every library it may have been kept in. How many were new. */
  async carry(root: string, scanned: ScannedBook, listed: ListedBook): Promise<number> {
    const here = localIdOf(listed);
    let added = 0;
    for (const library of librariesOf(root, scanned)) {
      const log = await this.log(library.dir);
      const byDevice = new Map<string, LogRecord[]>();
      for (const record of log.records) {
        const renamed = onServer(record, library.id, here);
        if (!renamed) continue;
        const records = byDevice.get(record.dev) ?? [];
        records.push(renamed);
        byDevice.set(record.dev, records);
      }
      for (const [device, records] of byDevice) added += this.places.append(this.person, log.devices.get(device) ?? { id: device, name: "" }, records).added;
    }
    return added;
  }

  private log(ribbon: string): Promise<FolderLog> {
    let log = this.logs.get(ribbon);
    if (!log) {
      log = readLog(path.join(ribbon, "positions"));
      this.logs.set(ribbon, log);
    }
    return log;
  }
}

/** A library's logs. A folder with none reads as empty, and a device that isn't one the server can name is left out. */
async function readLog(dir: string): Promise<FolderLog> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const records: LogRecord[] = [];
  const devices = new Map<string, DeviceInfo>();
  // Named first and only then opened: the folder also holds a file per book for older versions, and whatever a network drive leaves there.
  for (const name of names) {
    if (name.endsWith(LOG_EXT)) records.push(...parseLog(await readFile(path.join(dir, name), "utf8")).records.filter((r) => isDeviceId(r.dev)));
    else if (name.endsWith(".json")) {
      const device = deviceFrom(await readFile(path.join(dir, name), "utf8"));
      if (device) devices.set(device.id, device);
    }
  }
  return { records, devices };
}

function deviceFrom(text: string): DeviceInfo | null {
  try {
    const device = JSON.parse(text) as Partial<DeviceInfo>;
    return typeof device.id === "string" ? { id: device.id, name: typeof device.name === "string" ? device.name : "", ...(typeof device.app === "string" ? { app: device.app } : {}) } : null;
  } catch {
    return null;
  }
}

/** A record about the book `from`, its audio or its text, as a record about `to`. Null for a record about another book. */
function onServer(record: LogRecord, from: string, to: string): LogRecord | null {
  const audio = ribbonClaim(from);
  const text = textClaim(from);
  if (!record.book.ids.includes(audio) && !record.book.ids.includes(text)) return null;
  return { ...record, book: { ...record.book, ids: record.book.ids.map((id) => (id === audio ? ribbonClaim(to) : id === text ? textClaim(to) : id)) } };
}
