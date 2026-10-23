import type { Host } from "../../host/host";
import { logName, parseLog, type DeviceInfo, type LogRecord } from "../../core/poslog";
import { RIBBON_DIR } from "../../core/scan/walk";
import type { ServerClient } from "./client";

/** How many records go up in one request: a first sync of a long-used device sends its whole log. */
const BATCH = 500;

/** What's kept here between launches: the server's cursor, every record as last read, and this device's not sent yet. */
interface Kept {
  cursor: string | null;
  records: LogRecord[];
  devices: DeviceInfo[];
  pending: LogRecord[];
}

/**
 * A server's position log (docs/POSITION-FORMAT.md, docs/SERVER.md section 11),
 * as a server's source keeps it in place of `.ribbon/positions/`. The server
 * holds the log, in its database: this device's records go up as it adds
 * them, and everyone's come down by the server's cursor. Here there's one
 * small file, the log as last read and what's still to send, so a launch
 * draws every place at once and listening offline loses nothing.
 */
export class ServerLog {
  private kept: Kept | null = null;
  private run: Promise<boolean> | null = null;
  private again = false;

  constructor(
    private readonly client: ServerClient,
    private readonly host: Host,
    /** The server's folder on this device (downloads, and this file). */
    private readonly root: string,
    /** Who this device is in the log (LibraryService). */
    private readonly device: () => Promise<DeviceInfo>,
  ) {}

  /** Every record known here, this device's included, and who the devices are. */
  async all(): Promise<{ records: LogRecord[]; devices: DeviceInfo[] }> {
    const kept = await this.load();
    return { records: kept.records, devices: kept.devices };
  }

  /** A record this device just added: in the log here at once, and sent with the next sync. */
  async add(record: LogRecord): Promise<void> {
    const kept = await this.load();
    kept.records.push(record);
    kept.pending.push(record);
    await this.save();
  }

  /**
   * Send what's waiting, then take what's new. True when something came
   * down. One at a time: asked again while one runs, it runs once more
   * after, and both callers wait for that.
   */
  sync(): Promise<boolean> {
    if (this.run) {
      this.again = true;
      return this.run;
    }
    this.run = (async () => {
      let came = false;
      do {
        this.again = false;
        await this.send();
        came = (await this.take()) || came;
      } while (this.again);
      return came;
    })().finally(() => {
      this.run = null;
    });
    return this.run;
  }

  private async send(): Promise<void> {
    const kept = await this.load();
    if (kept.pending.length === 0) return;
    const me = await this.device();
    while (kept.pending.length > 0) {
      const batch = kept.pending.slice(0, BATCH);
      // The server keeps a record sent twice once, so a batch cut off by a lost connection is simply sent again.
      await this.client.sendPlaces(me, batch);
      kept.pending = kept.pending.slice(batch.length);
      await this.save();
    }
  }

  private async take(): Promise<boolean> {
    const kept = await this.load();
    const have = new Set(kept.records.map(key));
    let came = false;
    for (let more = true; more; ) {
      const answer = await this.client.places(kept.cursor);
      for (const r of answer.records) {
        if (have.has(key(r))) continue;
        have.add(key(r));
        kept.records.push(r);
        came = true;
      }
      kept.devices = answer.devices;
      kept.cursor = answer.cursor;
      more = answer.more === true;
    }
    await this.save();
    return came;
  }

  private async load(): Promise<Kept> {
    if (this.kept) return this.kept;
    const read = await this.host
      .readFile(this.at("server-log.json"))
      .then((b) => JSON.parse(new TextDecoder().decode(b)) as Kept)
      .catch(() => null);
    if (read) this.kept = read;
    else {
      const own = await this.fromFolderLog();
      this.kept = { cursor: null, records: [...own], devices: [], pending: own };
    }
    return this.kept;
  }

  /**
   * Ribbon 0.14 kept a server's log in the folder, as a library does: this
   * device's records there are sent once more (the server keeps each once),
   * so nothing written before the change is lost.
   */
  private async fromFolderLog(): Promise<LogRecord[]> {
    const me = await this.device();
    const text = await this.host
      .readFile(this.at("positions", logName(me.id)))
      .then((b) => new TextDecoder().decode(b))
      .catch(() => "");
    return parseLog(text).records.filter((r) => r.dev === me.id);
  }

  private async save(): Promise<void> {
    await this.host.mkdir(this.at());
    await this.host.writeFile(this.at("server-log.json"), new TextEncoder().encode(JSON.stringify(this.kept)));
  }

  private at(...parts: string[]): string {
    return this.host.join(this.root, RIBBON_DIR, ...parts);
  }
}

/** A record's identity in the log: its device and sequence number. */
function key(r: LogRecord): string {
  return `${r.dev}#${r.seq}`;
}
