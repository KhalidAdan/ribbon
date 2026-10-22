import type { Host } from "../../host/host";
import { deviceFileName, encodeRecord, logName, parseLog, type DeviceInfo, type LogRecord } from "../../core/poslog";
import { RIBBON_DIR } from "../../core/scan/walk";
import type { ServerClient } from "./client";

/** How many records go up in one request: a first sync of a long-used device sends its whole log. */
const BATCH = 500;

/** How far the sync has got, kept in the server's folder: the server's cursor, and the last of this device's records it has taken. */
interface SyncState {
  cursor: string | null;
  pushedSeq: number;
}

/**
 * Places through a Ribbon server (docs/SERVER.md, sections 10 and 11).
 *
 * A server's source keeps the position log in its folder as any library
 * does: this device appends to its own log there, and reading merges every
 * log there. This carries the logs between that folder and the server.
 * What this device appended goes up by sequence number, so compacting the
 * log here changes nothing. What other devices appended comes down by the
 * server's cursor, into copies of their logs beside this one's. The server
 * adds a device's records to that device's log and no other, so nothing
 * can conflict, and the merge is the one every library uses
 * (docs/POSITION-FORMAT.md).
 */
export class PlacesSync {
  private state: SyncState | null = null;
  private run: Promise<boolean> | null = null;
  private again = false;

  constructor(
    private readonly client: ServerClient,
    private readonly host: Host,
    private readonly root: string,
    /** Who this device is in the log (LibraryService). */
    private readonly device: () => Promise<DeviceInfo>,
  ) {}

  /**
   * Send what this device appended, then take what the others did. True
   * when something came down. One at a time: asked again while one runs,
   * it runs once more after, and both callers wait for that.
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
        await this.push();
        came = (await this.pull()) || came;
      } while (this.again);
      return came;
    })().finally(() => {
      this.run = null;
    });
    return this.run;
  }

  private async push(): Promise<void> {
    const state = await this.load();
    const me = await this.device();
    const text = await this.host
      .readFile(this.at(logName(me.id)))
      .then((b) => new TextDecoder().decode(b))
      .catch(() => "");
    const mine = parseLog(text)
      .records.filter((r) => r.dev === me.id && r.seq > state.pushedSeq)
      .sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < mine.length; i += BATCH) {
      const batch = mine.slice(i, i + BATCH);
      await this.client.sendPlaces(me, batch);
      state.pushedSeq = batch[batch.length - 1]!.seq;
      await this.save();
    }
  }

  private async pull(): Promise<boolean> {
    const state = await this.load();
    const me = await this.device();
    const answer = await this.client.places(state.cursor);
    const theirs = new Map<string, LogRecord[]>();
    for (const r of answer.records) if (r.dev !== me.id) theirs.set(r.dev, [...(theirs.get(r.dev) ?? []), r]);
    await this.host.mkdir(this.at());
    for (const d of answer.devices) {
      if (d.id !== me.id) await this.host.writeFile(this.at(deviceFileName(d.id)), new TextEncoder().encode(`${JSON.stringify(d)}\n`));
    }
    // From the start of every log (a first sync, or the cursor lost), each copy is written whole; after that, only added to.
    const whole = state.cursor === null;
    for (const [dev, records] of theirs) {
      const lines = new TextEncoder().encode(records.map((r) => encodeRecord(r)).join(""));
      await (whole ? this.host.writeFile(this.at(logName(dev)), lines) : this.append(this.at(logName(dev)), lines));
    }
    state.cursor = answer.cursor;
    await this.save();
    return theirs.size > 0;
  }

  private async append(path: string, data: Uint8Array): Promise<void> {
    if (this.host.appendFile) return this.host.appendFile(path, data);
    const before = await this.host.readFile(path).catch(() => new Uint8Array());
    const both = new Uint8Array(before.length + data.length);
    both.set(before);
    both.set(data, before.length);
    await this.host.writeFile(path, both);
  }

  private async load(): Promise<SyncState> {
    if (!this.state) {
      const kept = await this.host
        .readFile(this.host.join(this.root, RIBBON_DIR, "server-places.json"))
        .then((b) => JSON.parse(new TextDecoder().decode(b)) as Partial<SyncState>)
        .catch(() => null);
      this.state = { cursor: typeof kept?.cursor === "string" ? kept.cursor : null, pushedSeq: typeof kept?.pushedSeq === "number" ? kept.pushedSeq : 0 };
    }
    return this.state;
  }

  private async save(): Promise<void> {
    await this.host.mkdir(this.host.join(this.root, RIBBON_DIR));
    await this.host.writeFile(this.host.join(this.root, RIBBON_DIR, "server-places.json"), new TextEncoder().encode(JSON.stringify(this.state)));
  }

  /** In the positions folder, where every library keeps its log. */
  private at(...parts: string[]): string {
    return this.host.join(this.root, RIBBON_DIR, "positions", ...parts);
  }
}
