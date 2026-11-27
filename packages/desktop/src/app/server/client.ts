import { panelsFrom, type Panel } from "@ribbon/core/comic/panels";
import type { DailyGoal } from "@ribbon/core/goal";
import type { DeviceInfo, LogRecord } from "@ribbon/core/poslog";
import type { EditValues } from "@ribbon/core/edits";
import type { ComicShape } from "@ribbon/core/comic-name";
import type { Run, SharedMatch } from "@ribbon/core/comicvine";
import type { FoundSentence, ServerBook, ServerBookDetail, ServerJob, ServerSeries } from "@ribbon/core/server-books";

export type { ImportProgress, ServerJob } from "@ribbon/core/server-books";

/** A book of a series as a device sends it: by its server id, with its number (null for none, left out to keep the server's), and whether it's on the shelf. */
export interface SeriesBookSent {
  id: string;
  number?: number | null;
  shelved: boolean;
}

/**
 * The library a server lists (`GET /api/books`): its books, the ones its
 * admin deleted, and what it can do with a book's details. `editFields` is
 * every field its edits take (null from a server from before it said,
 * which takes only 0.51.0's), and `comicVine` whether it looks comics up
 * on ComicVine, which its owner turns on.
 */
export interface ServerLibrary {
  books: ServerBook[];
  deleted: string[];
  etag: string | null;
  editFields: string[] | null;
  comicVine: boolean;
}

/** A run of a series on ComicVine as a server offers it, with the address of its small picture there, or null. */
export type ServerRun = Run & { picture: string | null };

/** What a server's ComicVine says of a comic, to be shown beside it before it's kept (`GET /api/books/:id/comicvine`). */
export interface ServerLookedUp {
  address: string;
  as: ComicShape;
  values: EditValues;
  run: Run | null;
}

/** What a comic is looked up by on a server: an address, a run's issue by number, how its number is read; what's left out is the comic's own. */
export interface ServerLookUp {
  address?: string;
  issue?: string;
  as: ComicShape;
}

/** How a server signs people in: this app asks for a name and a password, or sends them to the browser. */
export type SignInWay = { kind: "password" } | { kind: "browser"; name: string };

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

/** Someone on a server, as it lists its people to its admin. */
export interface ServerPerson {
  id: string;
  /** The name they sign in with. */
  name: string;
  /** The name they are shown by. */
  displayName: string;
  role: string;
}

/**
 * A server's people, and how someone new joins: by a link its admin makes (a server that keeps its own accounts), or
 * through its sign-in provider, whose own admin lets people in (`address` is where, when the server says). Null from
 * a server too old to say.
 */
export interface ServerPeople {
  people: ServerPerson[];
  joining: { by: "invite" } | { by: "provider"; name: string; address?: string } | null;
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
   * How this server signs people in: with a name and a password this app
   * asks for, or in the browser, on pages of whatever proves who its people
   * are (`name`: "Pocket ID"). A server from before it could say takes a
   * name and a password.
   */
  static async howToSignIn(url: string): Promise<SignInWay> {
    const r = await reach(`${url}/api/sign-in`, {});
    if (r.status === 404) return { kind: "password" };
    if (!r.ok) throw new ServerError(await said(r, "That doesn't look like a Ribbon server."), r.status);
    const way = (await r.json().catch(() => null)) as { kind?: string; name?: string } | null;
    if (way?.kind === "browser") return { kind: "browser", name: way.name ?? "your browser" };
    if (way?.kind === "password") return { kind: "password" };
    throw new ServerError("That doesn't look like a Ribbon server.");
  }

  /**
   * Sign in through the system browser (docs/SERVER.md, section 6).
   * `browser` opens the server's sign-in page and resolves with what the
   * browser came back carrying: a one-time `code`, or the `error` that says
   * why there's none. The code alone is worth nothing: it's traded along
   * with a secret made here, whose hash the server was given at the start.
   */
  static async signInThroughBrowser(url: string, device: string, browser: (start: string) => Promise<Record<string, string>>): Promise<{ client: ServerClient; person: string }> {
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const back = await browser(`${url}/sign-in/start?challenge=${challenge}`);
    if (!back.code) throw new ServerError(back.error ?? "The browser came back without a sign-in. Try again.");
    const r = await reach(`${url}/api/sign-in/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: back.code, verifier, device }) });
    if (!r.ok) throw new ServerError(await said(r, "The server didn't finish that sign-in."), r.status);
    const done = (await r.json()) as { token?: string; user?: { name?: string } };
    if (!done.token || !done.user?.name) throw new ServerError("The server didn't hand back a sign-in. Is it a Ribbon server?");
    return { client: new ServerClient(url, done.token), person: done.user.name };
  }

  /**
   * The library and the ids of the books deleted from it, or `"unchanged"`
   * when the server says the copy this device has (its ETag) is still right.
   * A server from before books could be deleted lists none.
   */
  async books(etag: string | null): Promise<ServerLibrary | "unchanged"> {
    const r = await this.get("/api/books", etag ? { "if-none-match": etag } : {});
    if (r.status === 304) return "unchanged";
    const { books, deleted, editFields, comicVine } = (await r.json()) as { books: ServerBook[]; deleted?: string[]; editFields?: unknown; comicVine?: unknown };
    return {
      books,
      deleted: deleted ?? [],
      etag: r.headers.get("etag"),
      editFields: Array.isArray(editFields) ? editFields.filter((f): f is string => typeof f === "string") : null,
      comicVine: comicVine === true,
    };
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

  /**
   * As the admin: a book's edits, for everyone, in place of the ones it had
   * (none takes them back), with a picture for its cover, or null for its
   * files' cover; left out, its cover stays as it is.
   */
  async saveEdits(serverId: string, values: EditValues, cover?: Uint8Array | null): Promise<void> {
    const sent = { values, ...(cover === undefined ? {} : { cover: cover && { image: toBase64(cover) } }) };
    await this.send(`/api/books/${encodeURIComponent(serverId)}/edits`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(sent) });
  }

  // ComicVine, the server's (docs/BOOK-DETAILS.md, section 7): the admin's, on a server whose owner set a key.

  /** The runs ComicVine has by a series' name, of the year given, in the order a person is offered them. */
  async comicVineRuns(name: string, year: number | null): Promise<ServerRun[]> {
    const query = new URLSearchParams({ name, ...(year !== null ? { year: String(year) } : {}) });
    return ((await (await this.get(`/api/comicvine/runs?${query.toString()}`)).json()) as { runs: ServerRun[] }).runs;
  }

  /** A run's small picture, which the server fetched from ComicVine: at the address its offer gave, which is the server's own. */
  async comicVineRunPicture(address: string): Promise<Blob> {
    if (!address.startsWith("/api/comicvine/runs/")) throw new ServerError("That isn't a picture of the server's.");
    return (await this.get(address)).blob();
  }

  /** What ComicVine says of a comic, looked up as asked; nothing is kept. */
  async lookUpOnComicVine(serverId: string, asked: ServerLookUp): Promise<ServerLookedUp> {
    const query = new URLSearchParams({ as: asked.as, ...(asked.address ? { address: asked.address } : {}), ...(asked.issue ? { issue: asked.issue } : {}) });
    return ((await (await this.get(`/api/books/${encodeURIComponent(serverId)}/comicvine?${query.toString()}`)).json()) as { lookedUp: ServerLookedUp }).lookedUp;
  }

  /** "Use these": the same look-up, kept as the comic's match for everyone, in place of the one it had. */
  async keepComicVineMatch(serverId: string, asked: ServerLookUp): Promise<SharedMatch> {
    const r = await this.send(`/api/books/${encodeURIComponent(serverId)}/comicvine`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(asked) });
    return ((await r.json()) as { matched: SharedMatch }).matched;
  }

  /** "Forget the match": what ComicVine said goes, whole, for everyone. */
  async forgetComicVineMatch(serverId: string): Promise<void> {
    await this.send(`/api/books/${encodeURIComponent(serverId)}/comicvine`, { method: "DELETE" });
  }

  /** A comic's panels, for the pages that have them marked, by the page counted from 0 (docs/COMICS.md, section 14). */
  async panels(serverId: string): Promise<Map<number, Panel[]>> {
    const answer = (await (await this.get(`/api/books/${encodeURIComponent(serverId)}/panels`)).json()) as { pages?: { page: number; panels: unknown }[] };
    return new Map((answer.pages ?? []).flatMap(({ page, panels }) => {
      const read = panelsFrom(panels);
      return read && read.length > 0 ? [[page - 1, read] as [number, Panel[]]] : [];
    }));
  }

  /** As the admin: one page's panels, in reading order, for everyone, in place of the ones it had. An empty list takes them away. `page` counts from 0. */
  async savePanels(serverId: string, page: number, panels: readonly Panel[]): Promise<void> {
    await this.send(`/api/books/${encodeURIComponent(serverId)}/pages/${page + 1}/panels`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ panels }) });
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

  /** The sentences of every book on the server that best match words someone remembers, best first: what the Apple app's Find a line shows. */
  async search(words: string): Promise<FoundSentence[]> {
    return ((await (await this.get(`/api/search?q=${encodeURIComponent(words)}`)).json()) as { results: FoundSentence[] }).results;
  }

  /** A file of a book, for the host to download. */
  fileUrl(serverId: string, path: string): string {
    return `${this.url}/api/books/${encodeURIComponent(serverId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** A small file of a book, read whole: one of its records. */
  async file(serverId: string, path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(this.fileUrl(serverId, path).slice(this.url.length))).arrayBuffer());
  }

  /** One page of a comic as its picture, for a device that keeps no copy of the book. `page` counts from 0. */
  async page(serverId: string, page: number): Promise<Blob> {
    return (await this.get(`/api/books/${encodeURIComponent(serverId)}/pages/${page + 1}`)).blob();
  }

  /** A cover's bytes at one of the widths the server makes (200, 400 or 800). */
  async cover(hash: string, width: number): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(`/covers/${hash}-${width}.jpg`)).arrayBuffer());
  }

  /** The person's daily goal, as the server keeps it (packages/core/src/goal.ts). */
  async goal(): Promise<DailyGoal> {
    return ((await (await this.get("/api/goal")).json()) as { goal: DailyGoal }).goal;
  }

  /** Choose a daily goal: the server keeps it unless one was chosen later, and answers with the goal that stands. */
  async chooseGoal(goal: DailyGoal): Promise<DailyGoal> {
    const r = await this.send("/api/goal", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(goal) });
    return ((await r.json()) as { goal: DailyGoal }).goal;
  }

  /** Who's signed in: their name, and whether they're the server's admin. */
  async me(): Promise<{ name: string; role: string }> {
    return ((await (await this.get("/api/me")).json()) as { user: { name: string; role: string } }).user;
  }

  /** As the admin: everyone on the server, and how someone new joins it. */
  async people(): Promise<ServerPeople> {
    const told = (await (await this.get("/api/people")).json()) as { people: ServerPerson[]; joining?: ServerPeople["joining"] };
    // A server from before 0.54 doesn't say how people join: then nothing is offered.
    return { people: told.people, joining: told.joining ?? null };
  }

  /** As the admin of a server that keeps its own accounts: a link that lets one person make theirs, good once. */
  async invite(): Promise<{ url: string; expiresAt: string }> {
    return (await (await this.send("/api/invites", { method: "POST" })).json()) as { url: string; expiresAt: string };
  }

  /** As the admin: sign someone out of every device, so they sign in again. Their books and places are untouched. */
  async signOutEverywhere(personId: string): Promise<void> {
    await this.send(`/api/people/${encodeURIComponent(personId)}/sign-out`, { method: "POST" });
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

/** Bytes as base64 that's safe in an address: no `+`, `/` or padding. */
function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes as base64, a piece at a time: a picture is too many bytes to spread into one call. */
function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
