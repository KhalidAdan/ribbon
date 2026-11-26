import { outcomeOf, type CvOutcome, type CvResource } from "./comicvine";

/**
 * How politely ComicVine is asked (docs/BOOK-DETAILS.md, section 7, "Rate
 * limits and caching"), the same wherever it is asked from: a server, for
 * its people, and the desktop alone, for the comics in its folders. What
 * is asked and what an answer means are comicvine.ts's; this is how often,
 * and what to do when ComicVine says it has been asked too much.
 *
 * - **One request at a time**, a second and a half after the last one's
 *   answer, and a person waiting in the edit form goes before the
 *   background job (`ComicVineGate`).
 * - **No more than 180 to a resource in an hour**, of ComicVine's 200:
 *   the background job waits once it has used 160 of them, so a person's
 *   look-up always has room, and a person past 180 is told when to try
 *   again rather than kept waiting.
 * - **Blocked** (420 or 429, or ComicVine's status 107): waited out and
 *   tried twice more, waiting twice as long the second time
 *   (`sendPolitely`).
 *
 * A host keeps the answers and says what went wrong in its own words.
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

/** How long to wait the first time ComicVine says too many: twice as long the second. */
export const BLOCKED_WAIT_MS = 3_000;

/** How many times a blocked request is tried again. */
export const RETRIES = 2;

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

/** One request's answer as it came: its HTTP status (0 when ComicVine couldn't be reached) and its body, read as JSON where it was JSON. */
export interface Answered {
  status: number;
  body: unknown;
}

/**
 * Send one request through the door, and wait out ComicVine saying it has
 * been asked too much: tried twice more, three seconds later and then six.
 * What came of it last, as `outcomeOf` reads it, for the host to keep and
 * to say in its own words: still "too many" when the third try was turned
 * away too.
 */
export async function sendPolitely(gate: ComicVineGate, clock: Clock, resource: CvResource, asker: Asker, send: () => Promise<Answered>): Promise<Answered & { outcome: CvOutcome }> {
  for (let tried = 0; ; tried++) {
    const answered = await gate.through(resource, asker, send);
    const outcome = outcomeOf(answered.status, answered.body);
    if (outcome !== "too many" || tried >= RETRIES) return { ...answered, outcome };
    await clock.sleep(BLOCKED_WAIT_MS * 2 ** tried);
  }
}
