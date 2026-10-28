import type { DeviceInfo, LogRecord } from "../../core/poslog";
import type { EditValues } from "../../core/edits";
import type { ServerBook, ServerBookDetail, ServerSeries } from "../../core/server-books";

/** How a folder being added to a server is going (server/src/library/importer.ts, `ImportProgress`). */
export interface ImportProgress {
  folder: string;
  found: number;
  added: number;
  skipped: number;
  failed: number;
  current: string | null;
  notes: string[];
}

/** A book of a series as a device sends it: by its server id, with its number (null for none, left out to keep the server's), and whether it's on the shelf. */
export interface SeriesBookSent {
  id: string;
  number?: number | null;
  shelved: boolean;
}

/** A job on the server: adding a folder, for now. */
export interface ServerJob {
  id: string;
  state: "waiting" | "running" | "done" | "failed";
  progress: ImportProgress;
  error: string | null;
}

/** Something a server said no to, or couldn't be asked, in words to show. */
export class ServerError extends Error {
  constructor(
    message: string,
    /** 401: the sign-in has run out or was taken back. */
    readonly status = 0,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

/**
 * A Ribbon server, as this app talks to it (docs/SERVER.md, section 10):
 * JSON over HTTP, signed in with a token in a header. Downloads of a
 * book's files go through the host instead, straight to disk.
 */
export class ServerClient {
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  /** Sign in with a name and a password; the token is this device's from then on. */
  static async signIn(url: string, name: string, password: string): Promise<ServerClient> {
    const r = await reach(`${url}/api/auth/sign-in/username`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, password }) });
    if (r.status === 401) throw new ServerError("That name and password don't match an account on this server.", 401);
    if (!r.ok) throw new ServerError(await said(r, "The server didn't take that sign-in."), r.status);
    const token = r.headers.get("set-auth-token");
    if (!token) throw new ServerError("The server didn't hand back a sign-in. Is it a Ribbon server?");
    return new ServerClient(url, token);
  }

  /**
   * The library and the ids of the books deleted from it, or `"unchanged"`
   * when the server says the copy this device has (its ETag) is still right.
   * A server from before books could be deleted lists none.
   */
  async books(etag: string | null): Promise<{ books: ServerBook[]; deleted: string[]; etag: string | null } | "unchanged"> {
    const r = await this.get("/api/books", etag ? { "if-none-match": etag } : {});
    if (r.status === 304) return "unchanged";
    const { books, deleted } = (await r.json()) as { books: ServerBook[]; deleted?: string[] };
    return { books, deleted: deleted ?? [], etag: r.headers.get("etag") };
  }

  /** The library's series, or `"unchanged"` when this device's copy (its ETag) is still right. A server from before it kept series answers 404. */
  async series(etag: string | null): Promise<{ series: ServerSeries[]; etag: string | null } | "unchanged"> {
    const r = await this.get("/api/series", etag ? { "if-none-match": etag } : {});
    if (r.status === 304) return "unchanged";
    return { series: ((await r.json()) as { series: ServerSeries[] }).series, etag: r.headers.get("etag") };
  }

  /** As the admin: make a series of these books, in this order, for everyone. */
  async createSeries(name: string, books: readonly SeriesBookSent[]): Promise<void> {
    await this.send("/api/series", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, books }) });
  }

  /** As the admin: a series' name and its books in order, for everyone. */
  async saveSeries(id: string, name: string, books: readonly SeriesBookSent[]): Promise<void> {
    await this.send(`/api/series/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, books }) });
  }

  /** As the admin: a book's edits, for everyone, in place of the ones it had (none takes them back). */
  async saveEdits(serverId: string, values: EditValues): Promise<void> {
    await this.send(`/api/books/${encodeURIComponent(serverId)}/edits`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values }) });
  }

  /** As the admin: delete a series, for everyone. Its books stay. */
  async deleteSeries(id: string): Promise<void> {
    await this.send(`/api/series/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** As the admin: delete a book from the server, for everyone. */
  async deleteBook(serverId: string): Promise<void> {
    await this.send(`/api/books/${encodeURIComponent(serverId)}`, { method: "DELETE" });
  }

  async book(serverId: string): Promise<ServerBookDetail> {
    return (await (await this.get(`/api/books/${encodeURIComponent(serverId)}`)).json()) as ServerBookDetail;
  }

  /** A file of a book, for the host to download. */
  fileUrl(serverId: string, path: string): string {
    return `${this.url}/api/books/${encodeURIComponent(serverId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** A small file of a book, read whole: one of its records. */
  async file(serverId: string, path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(this.fileUrl(serverId, path).slice(this.url.length))).arrayBuffer());
  }

  /** A cover's bytes at one of the widths the server makes (200, 400 or 800). */
  async cover(hash: string, width: number): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(`/covers/${hash}-${width}.jpg`)).arrayBuffer());
  }

  /** Who's signed in: their name, and whether they're the server's admin. */
  async me(): Promise<{ name: string; role: string }> {
    return ((await (await this.get("/api/me")).json()) as { user: { name: string; role: string } }).user;
  }

  /** As the admin: add a folder on the server's machine. The server copies its books in as a job. */
  async importFolder(folder: string): Promise<ServerJob> {
    const r = await this.send("/api/library/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder }) });
    return ((await r.json()) as { job: ServerJob }).job;
  }

  async job(id: string): Promise<ServerJob> {
    return ((await (await this.get(`/api/jobs/${encodeURIComponent(id)}`)).json()) as { job: ServerJob }).job;
  }

  /** What this device heard at moments of a book's narration (`heard`), as the CSV kept beside it, for the server to merge with its own. */
  async sendRecord(serverId: string, kind: "heard", csv: Uint8Array): Promise<void> {
    await this.send(`/api/books/${encodeURIComponent(serverId)}/records/${kind}`, { method: "POST", headers: { "content-type": "text/csv; charset=utf-8" }, body: new TextDecoder().decode(csv) });
  }

  /** A book's transcript, whole, as the CSV kept beside it, kept by the server in place of what it had (#152). The admin's devices only. */
  async putTranscript(serverId: string, csv: Uint8Array): Promise<void> {
    await this.send(`/api/books/${encodeURIComponent(serverId)}/transcript`, { method: "PUT", headers: { "content-type": "text/csv; charset=utf-8" }, body: new TextDecoder().decode(csv) });
  }

  /** How much of each book's narration the server has transcribed, the books still missing some first: what the admin's devices with a graphics card work through. */
  async transcripts(): Promise<{ id: string; title: string; done: number; total: number }[]> {
    return ((await (await this.get("/api/library/transcripts")).json()) as { books: { id: string; title: string; done: number; total: number }[] }).books;
  }

  /** This person's position records from every device, newer than the cursor (none: from the start), the cursor to ask with next, and whether there's more past it. */
  async places(after: string | null): Promise<{ records: LogRecord[]; devices: DeviceInfo[]; cursor: string; more?: boolean }> {
    return (await (await this.get(`/api/places${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json()) as { records: LogRecord[]; devices: DeviceInfo[]; cursor: string; more?: boolean };
  }

  /** Records this device appended to its log, for the server to add to its copy of that log. */
  async sendPlaces(device: DeviceInfo, records: readonly LogRecord[]): Promise<void> {
    await this.send("/api/places", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: { id: device.id, name: device.name, ...(device.app ? { app: device.app } : {}) }, records }) });
  }

  /**
   * The server's events for this person (a place moved on another device,
   * the library changed), each as it comes, until the stream ends or
   * `signal` stops it.
   */
  async events(onEvent: (type: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
    const r = await this.send("/api/events", { headers: { accept: "text/event-stream" }, signal });
    if (!r.body) return;
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      const { events, rest } = takeEvents(buffer);
      buffer = rest;
      for (const e of events) onEvent(e.type, e.data);
    }
  }

  private get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(path, { headers });
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const r = await reach(`${this.url}${path}`, { ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.headers as Record<string, string>) } });
    if (r.status === 401) throw new ServerError("Sign in to the server again.", 401);
    if (!r.ok && r.status !== 304) throw new ServerError(await said(r, `The server answered ${r.status}.`), r.status);
    return r;
  }
}

/**
 * Whole events out of a server-sent event stream read so far: `event:`
 * names one, `data:` holds its JSON, a blank line ends it, and a line
 * starting `:` is a comment (the server's heartbeat). What's left is the
 * start of an event still arriving.
 */
export function takeEvents(buffer: string): { events: { type: string; data: unknown }[]; rest: string } {
  const events: { type: string; data: unknown }[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    try {
      events.push({ type, data: JSON.parse(data.join("\n")) as unknown });
    } catch {
      /* not JSON: not one of the server's */
    }
  }
  return { events, rest };
}

/** A request, with a failure to connect said as such. */
async function reach(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ServerError(`Couldn't reach ${new URL(url).host}. Is the server running, and can this device reach it?`);
  }
}

/** The server's own words for a refusal, when it gave some. */
async function said(r: Response, otherwise: string): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? otherwise;
}
