import { describe, expect, it } from "vitest";
import { readAfter, readStatus, type Read, type ReadEvent } from "@ribbon/core/listen-through";

const AT = "2026-11-10T12:00:00.000Z";
const HEARD = "2026-11-02T08:30:00.000Z";
const going: Read = { k: "read", id: "urn:uuid:old", started: "2026-11-01T09:00:00.000Z" };
const finished: Read = { ...going, finished: "2026-11-05T21:00:00.000Z" };
const fresh = () => "urn:uuid:new";

describe("a listen-through, written", () => {
  it("is where a book stands: none, going, or finished, by its latest one", () => {
    expect([readStatus(undefined), readStatus(going), readStatus(finished)]).toEqual(["none", "going", "finished"]);
  });

  it("answers every event in every status", () => {
    const events: ReadEvent[] = [{ k: "playing" }, { k: "again" }, { k: "finished", firstHeard: HEARD }, { k: "unfinished" }];
    const answers = Object.fromEntries(
      Object.entries({ none: undefined, going, finished }).map(([status, last]) => [status, Object.fromEntries(events.map((event) => [event.k, readAfter(last, event, AT, fresh)]))]),
    );
    const started = { k: "read", id: "urn:uuid:new", started: AT };
    expect(answers).toEqual({
      none: { playing: started, again: started, finished: { k: "read", id: "urn:uuid:new", started: HEARD, finished: AT }, unfinished: started },
      going: { playing: null, again: started, finished: { ...going, finished: AT }, unfinished: going },
      finished: { playing: null, again: started, finished: null, unfinished: going },
    });
  });

  it("finishes a book never heard as begun and finished now", () => {
    expect(readAfter(undefined, { k: "finished", firstHeard: null }, AT, fresh)).toEqual({ k: "read", id: "urn:uuid:new", started: AT, finished: AT });
  });
});
