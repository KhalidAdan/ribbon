import type { Host } from "../../host/host";
import type { ScannedBook } from "../../core/scan/scan";
import type { Book } from "../../core/types";
import { filedBook, filedDetails, localIdOf, opfFor, seriesFromServer, serverCoverPath, SHELF_COVER_WIDTH, type ServerBook, type ServerBookDetail, type ServerSeries } from "../../core/server-books";
import type { SharedEdits } from "../../core/edits";
import { RIBBON_DIR } from "../../core/scan/walk";
import type { SeriesGroup, SeriesRecord } from "../../core/series";
import { ServerError, type ServerClient } from "./client";
import { bytesToRows, rowsToBytes } from "../../core/csv";
import { TRANSCRIPT_FIELDS, transcriptFromRows, transcriptRows, withMinutesOf } from "../../core/reading/narration";

/** The records kept beside a downloaded book here: what it brought from the server, and what was worked out here. */
const KEPT = ["chapters", "corrections", "heard", "aligned", "pairing", "loudness", "silence", "settings"];

/** A book's id on a server, which names its folder here (server/src/library/importer.ts). */
const SERVER_ID = /^[0-9a-f]{16}$/;

/** A server's book's id there: a download's folder here is named by it. */
export function serverIdOf(book: ScannedBook): string {
  return book.remote?.serverId ?? book.book.path.split("/")[0]!;
}

/** Room left over after a download, so a phone isn't filled to the last byte. */
export const SPACE_MARGIN_BYTES = 200 * 1024 * 1024;

/** A book that won't fit on this device as it stands: how much it needs, and how much there is. */
export class NotEnoughSpace extends Error {
  constructor(
    readonly neededBytes: number,
    readonly freeBytes: number,
  ) {
    super("not enough space for this book");
    this.name = "NotEnoughSpace";
  }
}

/**
 * A Ribbon server's side of a source (docs/SERVER.md, sections 8 and 11).
 * The source's folder is one of Ribbon's own on this device; the books
 * downloaded into it are an ordinary library, read by the scanner like any
 * other. This keeps what the server lists and its series (cached in the
 * folder, so the shelf draws at once on launch and the server answers
 * "unchanged"), the covers of books not downloaded yet, and the downloads
 * themselves.
 */
export class ServerShelf {
  private listed: ServerBook[] = [];
  /** The listed books by their ids on this device. */
  private byLocalId = new Map<string, ServerBook>();
  /** The books the server's admin deleted, by server id. Only these are ever taken off this device unasked: never a book merely missing from the list. */
  private deleted = new Set<string>();
  private etag: string | null = null;
  /** The pictures kept here, by hash: a book's cover shows once it's on disk, never as a broken image. */
  private covers = new Set<string>();
  /** The library's series, the server's own; null until a server that keeps series has answered. */
  private series: ServerSeries[] | null = null;
  private seriesEtag: string | null = null;

  constructor(
    readonly client: ServerClient,
    private readonly host: Host,
    private readonly root: string,
  ) {}

  /** The list as it was last time, from the folder: what the shelf draws before the server answers. */
  async loadCached(): Promise<void> {
    const cached = await this.host
      .readFile(this.at(".ribbon", "server-books.json"))
      .then((b) => JSON.parse(new TextDecoder().decode(b)) as { etag: string | null; books: ServerBook[]; deleted?: string[] })
      .catch(() => null);
    if (cached) {
      this.list(cached.books);
      this.deleted = new Set(cached.deleted ?? []);
      this.etag = cached.etag;
    }
    const series = await this.host
      .readFile(this.at(".ribbon", "server-series.json"))
      .then((b) => JSON.parse(new TextDecoder().decode(b)) as { etag: string | null; series: ServerSeries[] })
      .catch(() => null);
    if (series) {
      this.series = series.series;
      this.seriesEtag = series.etag;
    }
  }

  /** Ask the server for its series; true when they changed. A server from before it kept series has none to give, and the shelf finds series itself. */
  async refreshSeries(): Promise<boolean> {
    const answer = await this.client.series(this.seriesEtag).catch((e: unknown) => {
      if (e instanceof ServerError && e.status === 404) return null;
      throw e;
    });
    if (answer === "unchanged" || answer === null) return false;
    this.series = answer.series;
    this.seriesEtag = answer.etag;
    await this.host.mkdir(this.at(".ribbon"));
    await this.host.writeFile(this.at(".ribbon", "server-series.json"), new TextEncoder().encode(JSON.stringify({ etag: this.seriesEtag, series: this.series })));
    return true;
  }

  /** Whether the server keeps the library's series, so the shelf takes them from it rather than finding its own. */
  get keepsSeries(): boolean {
    return this.series !== null;
  }

  /** Whether a series is one of the server's, by its id. */
  hasSeries(id: string): boolean {
    return this.series?.some((s) => s.id === id) ?? false;
  }

  /** The server's series as the shelf takes them, its books by their ids on this device. */
  seriesOnShelf(): { groups: SeriesGroup[]; records: SeriesRecord[] } {
    return seriesFromServer(this.series ?? [], this.listed);
  }

  /** Ask the server for its list; true when it changed. */
  async refresh(): Promise<boolean> {
    const answer = await this.client.books(this.etag);
    if (answer === "unchanged") return false;
    this.list(answer.books);
    this.deleted = new Set(answer.deleted);
    this.etag = answer.etag;
    await this.host.mkdir(this.at(".ribbon"));
    await this.host.writeFile(this.at(".ribbon", "server-books.json"), new TextEncoder().encode(JSON.stringify({ etag: this.etag, books: this.listed, deleted: answer.deleted })));
    return true;
  }

  /** Whether the server says its admin deleted this book: the one reason a download here is taken off unasked. */
  wasDeleted(serverId: string): boolean {
    return this.deleted.has(serverId);
  }

  /** The server's books that aren't on this device yet, given the ones that are: as their files have them, for the edits are laid over them here. */
  remote(local: readonly ScannedBook[]): ScannedBook[] {
    const here = new Set(local.map((b) => b.book.id));
    return this.listed.filter((b) => !here.has(localIdOf(b))).map(filedBook);
  }

  /** Every listed book by its id here, with the edits the server keeps for it, if any, and the cover it's listed with. */
  listedEdits(): { localId: string; edited: SharedEdits | undefined; cover: ServerBook["cover"] }[] {
    return this.listed.map((b) => ({ localId: localIdOf(b), edited: b.edited, cover: b.cover }));
  }

  /**
   * A downloaded book named as the server's files name it, whatever its
   * files here say (an EPUB on its own names itself): so it's the same book
   * on every device, and an edit to it is an edit to what the server has.
   * The book as it is when the server doesn't list it.
   */
  asListed(book: Book): Book {
    const listed = this.byLocalId.get(book.id);
    if (!listed) return book;
    const filed = filedBook(listed).book;
    const named = { title: filed.title, rawTitle: filed.rawTitle, author: filed.author, narrator: filed.narrator, series: filed.series, seriesIndex: filed.seriesIndex };
    return (Object.keys(named) as (keyof typeof named)[]).every((k) => book[k] === named[k]) ? book : { ...book, ...named };
  }

  /**
   * Find the shelf's cover of every listed book, fetching the ones not kept
   * here yet; each is fetched once, ever. With the server out of reach the
   * ones already here still count. How many covers can show now that
   * couldn't before.
   */
  async fetchCovers(): Promise<number> {
    let found = 0;
    let reachable = true;
    for (const b of this.listed) {
      if (!b.cover || this.covers.has(b.cover.hash)) continue;
      const file = this.at(...serverCoverPath(b.cover.hash).split("/"));
      if (!(await this.host.exists(file))) {
        if (!reachable) continue;
        try {
          const bytes = await this.client.cover(b.cover.hash, SHELF_COVER_WIDTH);
          await this.host.mkdir(this.at(".ribbon", "server-covers"));
          await this.host.writeFile(file, bytes);
        } catch {
          reachable = false;
          continue;
        }
      }
      this.covers.add(b.cover.hash);
      found++;
    }
    return found;
  }

  /** Whether a cover is on disk, so the shelf can draw it. */
  hasCover(hash: string): boolean {
    return this.covers.has(hash);
  }

  /**
   * Download a book into its folder here, named by its server id: its audio,
   * its EPUB, a `metadata.opf` so the scanner names it as the server's files
   * do (its edits are laid over it here), and its cover. The space is
   * checked first; a book that won't fit throws NotEnoughSpace before
   * anything is downloaded. Returns what the server measured of it, for
   * the book's records here.
   */
  async download(book: ScannedBook, onProgress: (done: number, total: number) => void): Promise<ServerBookDetail["analysis"]> {
    const serverId = book.remote?.serverId;
    if (!serverId || !this.host.serverDownload) throw new Error("This device can't keep a server's books.");
    const detail = await this.client.book(serverId);
    const total = detail.files.reduce((s, f) => s + f.sizeBytes, 0) + (detail.ebookBytes ?? 0);
    const free = (await this.host.freeSpace?.(this.root)) ?? Number.POSITIVE_INFINITY;
    if (free < total + SPACE_MARGIN_BYTES) throw new NotEnoughSpace(total + SPACE_MARGIN_BYTES, free);

    const folder = this.at(serverId);
    await this.host.mkdir(folder);
    let before = 0;
    for (const f of detail.files) {
      // The audio sits in the book's folder itself, as the scanner expects one book's files.
      await this.host.serverDownload(this.client.fileUrl(serverId, f.path), this.client.token, this.host.join(folder, f.path.split("/").pop()!), f.sizeBytes, (done) => onProgress(before + done, total));
      before += f.sizeBytes;
    }
    if (detail.book.ebook && detail.ebookBytes !== undefined) {
      await this.host.serverDownload(this.client.fileUrl(serverId, detail.book.ebook), this.client.token, this.host.join(folder, "book.epub"), detail.ebookBytes, (done) => onProgress(before + done, total));
    }
    await this.host.writeFile(this.host.join(folder, "metadata.opf"), new TextEncoder().encode(opfFor(filedDetails(detail))));
    if (detail.cover) await this.host.writeFile(this.host.join(folder, "cover.jpg"), await this.client.cover(detail.cover.hash, 800));
    // Before the book is first scanned here, so its chapters and read-along come as the server has them.
    await this.keepRecords(detail, book.book.id);
    onProgress(total, total);
    return detail.analysis;
  }

  /**
   * The records the server keeps with a book (its chapters, what was heard
   * of the narration, its transcript, …), kept beside it here under its id
   * on this device, where Ribbon looks for them. Only the ones not here yet
   * are fetched, but the transcript: the server's is taken every time, with
   * only the minutes this device heard itself that it lacks (#152).
   */
  async keepRecords(detail: ServerBookDetail, localId: string): Promise<void> {
    for (const kind of detail.records ?? []) {
      const file = this.at(RIBBON_DIR, kind, `${localId}.csv`);
      const here = await this.host.exists(file);
      if (here && kind !== "aligned") continue;
      let bytes = await this.client.file(detail.book.id, `records/${kind}.csv`);
      if (here) {
        const read = async (b: Uint8Array) => transcriptFromRows((await bytesToRows(b)).rows);
        bytes = await rowsToBytes(transcriptRows(withMinutesOf(await read(bytes), await read(await this.host.readFile(file)))), TRANSCRIPT_FIELDS);
      }
      await this.host.mkdir(this.at(RIBBON_DIR, kind));
      await this.host.writeFile(file, bytes);
    }
  }

  /**
   * What the server says about a downloaded book, written again beside it
   * when it has changed since the download (a description the server
   * filled in since), so the next scan describes it as the server does.
   */
  async keepDetails(detail: ServerBookDetail): Promise<void> {
    const folder = this.at(detail.book.id);
    if (!SERVER_ID.test(detail.book.id) || !(await this.host.exists(folder))) return;
    const file = this.host.join(folder, "metadata.opf");
    const opf = opfFor(filedDetails(detail));
    const kept = await this.host.readFile(file).then((b) => new TextDecoder().decode(b), () => null);
    if (kept !== opf) await this.host.writeFile(file, new TextEncoder().encode(opf));
  }

  /** Take a downloaded book off this device, with the records kept beside it. The server keeps it, and the person's place in it. */
  async remove(serverId: string, localId: string): Promise<void> {
    if (!SERVER_ID.test(serverId)) throw new Error("Not a server's book.");
    await this.host.remove(this.at(serverId));
    for (const kind of KEPT) await this.host.remove(this.at(RIBBON_DIR, kind, `${localId}.csv`)).catch(() => undefined);
  }

  /** Take every downloaded book off this device, as on disconnecting. The records stay, so connecting again finds each place. */
  async removeAll(): Promise<void> {
    for (const e of await this.host.readDir(this.root)) {
      if (e.isDir && SERVER_ID.test(e.name)) await this.host.remove(this.at(e.name));
    }
  }

  private list(books: ServerBook[]): void {
    this.listed = books;
    this.byLocalId = new Map(books.map((b) => [localIdOf(b), b]));
  }

  private at(...parts: string[]): string {
    return this.host.join(this.root, ...parts);
  }
}
