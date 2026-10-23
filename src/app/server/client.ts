import type { DeviceInfo, LogRecord } from "../../core/poslog";
import type { ServerBook, ServerBookDetail } from "../../core/server-books";

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

  /** The library, or `"unchanged"` when the server says the copy this device has (its ETag) is still right. */
  async books(etag: string | null): Promise<{ books: ServerBook[]; etag: string | null } | "unchanged"> {
    const r = await this.get("/api/books", etag ? { "if-none-match": etag } : {});
    if (r.status === 304) return "unchanged";
    const { books } = (await r.json()) as { books: ServerBook[] };
    return { books, etag: r.headers.get("etag") };
  }

  async book(serverId: string): Promise<ServerBookDetail> {
    return (await (await this.get(`/api/books/${encodeURIComponent(serverId)}`)).json()) as ServerBookDetail;
  }

  /** A file of a book, for the host to download. */
  fileUrl(serverId: string, path: string): string {
    return `${this.url}/api/books/${encodeURIComponent(serverId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
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
