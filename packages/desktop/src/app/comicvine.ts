import type { Host } from "@ribbon/core/host";
import { lookUpComic, requestKey, runRequest, runsInOrder, runsRequest, type CvAnswer, type CvRequest, type CvVolume, type LookUpAsked, type LookedUp, type RunSearch } from "@ribbon/core/comicvine";
import { ComicVineGate, ComicVineUnreachable, GAP_MS, realClock, sendPolitely, type Asker, type Clock } from "@ribbon/core/comicvine-gate";

/** How long an answer is kept, as the server keeps its. */
const DAY = 24 * 3_600_000;

/**
 * ComicVine as the desktop alone asks it, for the comics in its folders
 * (docs/BOOK-DETAILS.md, section 7, "Where it runs"): with the key a person
 * put in Settings, through the host, which builds only ComicVine's
 * addresses (src-tauri/src/comicvine.rs), and through core's door
 * (core/comicvine-gate.ts), so it is asked exactly as politely as a server
 * asks it: one request at a time, a second and a half apart, within the
 * hour's limit, a person before the background job, a blocked request
 * waited out.
 *
 * Answers are kept for a day, here in memory, so the same thing isn't
 * asked twice, as ComicVine's terms ask; a search's runs are kept as each
 * run's own answer too, so picking one asks nothing more about it. A match
 * is kept beside its comic (core/matched.ts) and never asked again unless a
 * person asks.
 */
export class ComicVineHere {
  private readonly gate: ComicVineGate;
  private readonly kept = new Map<string, { at: number; answer: CvAnswer }>();

  constructor(
    private readonly host: Host,
    /** The person's key, as Settings has it now; null when none is set. */
    private readonly key: () => string | null,
    private readonly clock: Clock = realClock,
    gapMs = GAP_MS,
  ) {
    this.gate = new ComicVineGate(clock, gapMs);
  }

  /** Whether comics can be looked up here: a key is set, and the host can ask. */
  get on(): boolean {
    return !!this.key() && !!this.host.comicVineAsk;
  }

  /**
   * A request's results: kept within the day, else asked. Null when
   * ComicVine has no such thing. Throws ComicVineUnreachable, in a sentence
   * a person can act on, when it can't be asked.
   */
  async ask<T>(request: CvRequest, asker: Asker): Promise<T | null> {
    const at = requestKey(request);
    const kept = this.kept.get(at);
    if (kept && kept.at > this.clock.now() - DAY) return kept.answer.status_code === 1 ? (kept.answer.results as T) : null;
    const key = this.key();
    const send = this.host.comicVineAsk;
    if (!key || !send) throw new ComicVineUnreachable("Put your ComicVine key in Settings, under Online, to look comics up.");
    const { outcome, status, body } = await sendPolitely(this.gate, this.clock, request.resource, asker, async () => {
      try {
        const answered = await send(key, request);
        return { status: answered.status, body: parsed(answered.body) };
      } catch (e) {
        // The host refused to send it at all: a key that isn't one, say. Its words, which never carry the key.
        throw new ComicVineUnreachable(e instanceof Error ? e.message : String(e));
      }
    });
    switch (outcome) {
      case "answered": {
        const answer = body as CvAnswer;
        this.keep(at, answer);
        if (request.resource === "volumes" && Array.isArray(answer.results)) {
          for (const run of answer.results as CvVolume[]) this.keep(requestKey(runRequest(run.id)), { status_code: 1, error: "OK", results: run });
        }
        return answer.results as T;
      }
      case "not found":
        this.keep(at, { status_code: 101, error: "Object Not Found", results: [] });
        return null;
      case "too many":
        throw new ComicVineUnreachable("ComicVine is turning Ribbon’s requests away for now: too many, too fast. Try again in a while.");
      case "refused":
        throw new ComicVineUnreachable("ComicVine refused your key: check it in Settings, under Online.");
      case "failed":
        throw new ComicVineUnreachable(status === 0 ? "ComicVine can’t be reached from this computer just now." : `ComicVine couldn’t answer just now (${status}).`);
    }
  }

  /** Look a comic up (core's `lookUpComic`), through the door. */
  lookUp(asked: LookUpAsked, asker: Asker): Promise<LookedUp | null> {
    return lookUpComic((request) => this.ask(request, asker), asked);
  }

  /** The runs ComicVine has by a name, of the year given, in the order a person is offered them. */
  async runs(search: RunSearch): Promise<CvVolume[]> {
    return runsInOrder((await this.ask<CvVolume[]>(runsRequest(search), "person")) ?? [], search);
  }

  /**
   * The small picture of a run's first cover, at the address its answer
   * gave (core's `runPicture`), or null. Pictures are on ComicVine's site,
   * not its API, so they don't wait at the door; the host fetches them only
   * from ComicVine's own hosts.
   */
  async picture(address: string): Promise<Uint8Array | null> {
    if (!this.host.comicVinePicture) return null;
    return this.host.comicVinePicture(address).catch(() => null);
  }

  private keep(at: string, answer: CvAnswer): void {
    const now = this.clock.now();
    this.kept.set(at, { at: now, answer });
    for (const [k, v] of this.kept) if (v.at <= now - DAY) this.kept.delete(k);
  }
}

/** An answer's text read as JSON, or null when it isn't: its HTTP status says what happened then. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
