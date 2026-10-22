import type { ServerBook, ServerBookDetail } from "../../core/server-books";

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

  private async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const r = await reach(`${this.url}${path}`, { headers: { authorization: `Bearer ${this.token}`, ...headers } });
    if (r.status === 401) throw new ServerError("Sign in to the server again.", 401);
    if (!r.ok && r.status !== 304) throw new ServerError(await said(r, `The server answered ${r.status}.`), r.status);
    return r;
  }
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
