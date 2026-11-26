import type { DatabaseSync } from "node:sqlite";
import { lookUpComic, outcomeOf, runPicture, runRequest, runsInOrder, runsRequest, type CvAnswer, type CvRequest, type CvResource, type CvVolume, type LookUpAsked, type LookedUp, type RunSearch } from "@ribbon/core/comicvine";

/**
 * The server's door to ComicVine (docs/BOOK-DETAILS.md, section 7): every
 * request to its API goes through here, with the key the server's owner
 * set (RIBBON_COMICVINE_KEY; unset, there's no door, and the server asks
 * no one). What is asked, and what an answer means, is core's
 * (packages/core/src/comicvine.ts); this sends it, politely:
 *
 * - **One request at a time**, a second and a half after the last one's
 *   answer, and a person waiting in the edit form goes before the
 *   background job (`ComicVineGate`).
 * - **No more than 180 to a resource in an hour**, of ComicVine's 200:
 *   the background job waits once it has used 160 of them, so a person's
 *   look-up always has room, and a person past 180 is told when to try
 *   again rather than kept waiting.
 * - **Blocked** (420 or 429, or ComicVine's status 107): waited out and
 *   tried twice more, waiting twice as long the second time.
 * - **Kept for a day** (`comicvine_cache`): an answer asked again within
 *   the day is the one kept, as ComicVine's terms ask. A search's runs
 *   are kept as each run's own answer too, so picking one asks nothing
 *   more about it.
 *
 * The key goes only to ComicVine, in the request, and never into a log,
 * an error or the cache.
 */

/** Who a request is for: a person waiting on the edit form, or the background job. */
export type Asker = "person" | "background";

/** Time, as the door keeps it: the real one, or a test's. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** How long after one answer the next request goes: Panels' gap. */
export const GAP_MS = 1_500;

/** The most requests to one resource in an hour, of ComicVine's 200. */
export const HOURLY = 180;

/** What the background job leaves of the hour's requests, so a person's look-up always has room. */
const KEPT_FOR_PEOPLE = 20;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long to wait the first time ComicVine says too many: twice as long the second. */
const BLOCKED_WAIT_MS = 3_000;

/** How many times a blocked request is tried again. */
const RETRIES = 2;

/** How long a request may take. */
const TIMEOUT_MS = 15_000;

/** The biggest picture of a run that is fetched. */
const PICTURE_BYTES = 2 * 1024 * 1024;

/** ComicVine's API, unless a test's stand-in. */
export const COMICVINE_API = "https://comicvine.gamespot.com/api";

/** What the server calls itself to ComicVine, which asks every client to say. */
const USER_AGENT = "Ribbon server (a home library of comics and books)";

/** ComicVine can't be asked just now: out of reach, blocked, or refusing the key. Said in a sentence a person can act on. */
export class ComicVineUnreachable extends Error {}

/** A person asked past the hour's limit: when to try again. */
export class ComicVineBusy extends ComicVineUnreachable {
  constructor(readonly until: number) {
    super(`ComicVine has been asked as much as it allows for an hour: try again after ${new Date(until).toISOString().slice(11, 16)} UTC.`);
  }
}

/** A request waiting its turn at the door. */
interface Waiting {
  resource: CvResource;
  asker: Asker;
  go(): void;
  refuse(e: Error): void;
}

/**
 * ComicVine's door, where requests wait their turn: one at a time, each a
 * gap after the last one's answer, a person before the background job,
 * and within the hour's limit for each resource (above). Waiting is
 * broken off whenever someone new arrives or an answer comes, so a person
 * never waits behind the background job's long wait for room.
 */
export class ComicVineGate {
  private readonly waiting: Waiting[] = [];
  /** When each resource was asked, in the last hour. */
  private readonly sent = new Map<CvResource, number[]>();
  private out = false;
  private lastAnswer = -Infinity;
  private running = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly gapMs = GAP_MS,
  ) {}

  /** Send a request when its turn comes, and give back what `send` does with it. */
  through<T>(resource: CvResource, asker: Asker, send: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        resource,
        asker,
        refuse: reject,
        go: () => {
          send()
            .then(resolve, reject)
            .finally(() => {
              this.out = false;
              this.lastAnswer = this.clock.now();
              this.poke();
            });
        },
      });
      this.poke();
    });
  }

  /** How many requests went to a resource in the hour before `now`. */
  sentInTheHour(resource: CvResource, now = this.clock.now()): number {
    return this.recent(resource, now).length;
  }

  private poke(): void {
    this.wake?.();
    if (!this.running) void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    while (this.waiting.length > 0) {
      if (this.out) {
        await this.rest(Infinity);
        continue;
      }
      const now = this.clock.now();
      const gap = this.lastAnswer + this.gapMs - now;
      if (gap > 0) {
        await this.rest(gap);
        continue;
      }
      const person = this.waiting.findIndex((w) => w.asker === "person");
      if (person >= 0) {
        const turn = this.waiting.splice(person, 1)[0]!;
        const recent = this.recent(turn.resource, now);
        if (recent.length >= HOURLY) turn.refuse(new ComicVineBusy(recent[recent.length - HOURLY]! + HOUR));
        else this.send(turn, now);
        continue;
      }
      // The background job, in order, each request once its resource has room for it, leaving some for people.
      let soonest = Infinity;
      const ready = this.waiting.findIndex((w) => {
        const room = this.roomFor(w.resource, now);
        soonest = Math.min(soonest, room);
        return room <= now;
      });
      if (ready < 0) {
        await this.rest(soonest - now);
        continue;
      }
      this.send(this.waiting.splice(ready, 1)[0]!, now);
    }
    this.running = false;
  }

  /** When the background job may next ask a resource: now, or when enough of the hour's requests to it have aged out. */
  private roomFor(resource: CvResource, now: number): number {
    const recent = this.recent(resource, now);
    const over = recent.length - (HOURLY - KEPT_FOR_PEOPLE);
    return over < 0 ? now : recent[over]! + HOUR;
  }

  private send(turn: Waiting, now: number): void {
    this.out = true;
    this.recent(turn.resource, now).push(now);
    turn.go();
  }

  /** The times a resource was asked in the hour before `now`, oldest first; older ones forgotten. */
  private recent(resource: CvResource, now: number): number[] {
    const times = (this.sent.get(resource) ?? []).filter((t) => t > now - HOUR);
    this.sent.set(resource, times);
    return times;
  }

  /** Wait this long, or until someone arrives or an answer comes, whichever is first. */
  private rest(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.wake === done) this.wake = null;
        resolve();
      };
      this.wake = done;
      if (Number.isFinite(ms)) void this.clock.sleep(ms).then(done);
    });
  }
}

/** The server's ComicVine: its key, its door and its cache. */
export interface ComicVineSettings {
  key: string;
  /** Its API's address: ComicVine's, or a test's stand-in. */
  api?: string;
  clock?: Clock;
  gapMs?: number;
  fetch?: typeof fetch;
}

/**
 * ComicVine, as the server asks it: through its door (above), from its
 * cache when it can be.
 */
export class ComicVine {
  readonly gate: ComicVineGate;
  private readonly key: string;
  private readonly api: string;
  private readonly clock: Clock;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly db: DatabaseSync,
    settings: ComicVineSettings,
  ) {
    this.key = settings.key;
    this.api = (settings.api ?? COMICVINE_API).replace(/\/+$/, "");
    this.clock = settings.clock ?? realClock;
    this.fetchFn = settings.fetch ?? fetch;
    this.gate = new ComicVineGate(this.clock, settings.gapMs ?? GAP_MS);
  }

  /**
   * A request's results: kept within the day, else asked. Null when
   * ComicVine has no such thing. Throws ComicVineUnreachable when it can't
   * be asked: out of reach, refusing the key, or still blocked after two
   * more tries.
   */
  async ask<T>(request: CvRequest, asker: Asker): Promise<T | null> {
    const key = cacheKey(request);
    const kept = this.kept(key);
    if (kept) return outcomeOf(200, kept) === "answered" ? (kept.results as T) : null;
    for (let tried = 0; ; tried++) {
      const { status, body } = await this.gate.through(request.resource, asker, () => this.send(request));
      switch (outcomeOf(status, body)) {
        case "answered":
          this.keep(key, body as CvAnswer);
          // A search's runs answer for each run asked for alone, as their fields are the same.
          if (request.resource === "volumes" && Array.isArray((body as CvAnswer).results)) {
            for (const run of (body as CvAnswer<CvVolume[]>).results) this.keep(cacheKey(runRequest(run.id)), { status_code: 1, error: "OK", results: run });
          }
          return (body as CvAnswer<T>).results;
        case "not found":
          this.keep(key, { status_code: 101, error: "Object Not Found", results: [] });
          return null;
        case "too many":
          if (tried < RETRIES) {
            await this.clock.sleep(BLOCKED_WAIT_MS * 2 ** tried);
            continue;
          }
          throw new ComicVineUnreachable("ComicVine is turning this server's requests away for now: too many, too fast. Try again in a while.");
        case "refused":
          throw new ComicVineUnreachable("ComicVine refused this server's key: check RIBBON_COMICVINE_KEY.");
        case "failed":
          throw new ComicVineUnreachable(status === 0 ? "ComicVine can't be reached from this server just now." : `ComicVine couldn't answer just now (${status}).`);
      }
    }
  }

  /** Look a comic up (core's `lookUpComic`), through the door. */
  lookUp(asked: LookUpAsked, asker: Asker): Promise<LookedUp | null> {
    return lookUpComic((request) => this.ask(request, asker), asked);
  }

  /** The runs ComicVine has by a name, of the year given, in the order a person is offered them. */
  async runs(search: RunSearch, asker: Asker): Promise<CvVolume[]> {
    return runsInOrder((await this.ask<CvVolume[]>(runsRequest(search), asker)) ?? [], search);
  }

  /**
   * The small picture of a run's first cover, fetched here so a device
   * never asks ComicVine: only from ComicVine's own hosts (or its API's),
   * an image, and small. Null when there's none to fetch.
   */
  async runPicture(runId: number, asker: Asker): Promise<{ bytes: Uint8Array; type: string } | null> {
    const run = await this.ask<CvVolume>(runRequest(runId), asker);
    const url = run ? runPicture(run) : null;
    if (!url || !this.mayFetchPicture(url)) return null;
    try {
      const r = await this.fetchFn(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const type = r.headers.get("content-type") ?? "";
      if (!r.ok || !/^image\//i.test(type)) return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      return bytes.length > 0 && bytes.length <= PICTURE_BYTES ? { bytes, type } : null;
    } catch {
      return null;
    }
  }

  /** A picture's address is ComicVine's: on one of its hosts over HTTPS, or where its API is. */
  private mayFetchPicture(url: string): boolean {
    let at: URL;
    try {
      at = new URL(url);
    } catch {
      return false;
    }
    if (at.origin === new URL(this.api).origin) return true;
    return at.protocol === "https:" && /(^|\.)(gamespot|comicvine)\.com$/i.test(at.hostname);
  }

  private async send(request: CvRequest): Promise<{ status: number; body: unknown }> {
    const url = new URL(request.path, `${this.api}/`);
    url.searchParams.set("api_key", this.key);
    url.searchParams.set("format", "json");
    for (const [name, value] of Object.entries(request.params)) url.searchParams.set(name, value);
    try {
      const r = await this.fetchFn(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        // Not JSON: its HTTP status says what happened.
      }
      return { status: r.status, body };
    } catch {
      return { status: 0, body: null };
    }
  }

  /** An answer kept within the day, or none. */
  private kept(key: string): CvAnswer | null {
    const row = this.db.prepare("SELECT answer FROM comicvine_cache WHERE key = ? AND asked_at > ?").get(key, this.clock.now() - DAY);
    return row ? (JSON.parse(String(row.answer)) as CvAnswer) : null;
  }

  /** Keep an answer for a day, and let go of the ones older than that. */
  private keep(key: string, answer: CvAnswer): void {
    const now = this.clock.now();
    this.db.prepare("INSERT INTO comicvine_cache (key, answer, asked_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET answer = excluded.answer, asked_at = excluded.asked_at").run(key, JSON.stringify(answer), now);
    this.db.prepare("DELETE FROM comicvine_cache WHERE asked_at <= ?").run(now - DAY);
  }
}

/** A request as the cache knows it: its path and what it asks, without the key. */
function cacheKey(request: CvRequest): string {
  const params = Object.entries(request.params).sort(([a], [b]) => a.localeCompare(b));
  return `${request.path}?${new URLSearchParams(params).toString()}`;
}
