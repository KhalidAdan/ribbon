import { describe, expect, it } from "vitest";
import { ComicVineBusy, ComicVineGate, GAP_MS, HOURLY, sendPolitely, type Clock } from "../src/comicvine-gate";
import { issueRequest, requestKey, runsRequest } from "../src/comicvine";

/** A clock the test moves: sleeping waits until the test has moved it far enough. */
function testClock() {
  let now = 0;
  const sleepers: { until: number; wake: () => void }[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: (ms) => new Promise((wake) => sleepers.push({ until: now + ms, wake })),
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    clock,
    /** Move time on, waking each sleeper whose time came, and let what they started run. */
    async pass(ms: number) {
      const end = now + ms;
      for (;;) {
        await settle();
        const next = sleepers.filter((s) => s.until <= end).sort((a, b) => a.until - b.until)[0];
        if (!next) break;
        now = Math.max(now, next.until);
        sleepers.splice(sleepers.indexOf(next), 1);
        next.wake();
      }
      now = end;
      await settle();
    },
  };
}

/**
 * ComicVine's door, shared by a server and the desktop alone
 * (docs/BOOK-DETAILS.md, section 7, "Rate limits and caching"). The
 * server's tests drive it against a stand-in ComicVine; these are its rules
 * on their own.
 */
describe("ComicVine's door", () => {
  it("lets one request through at a time, a second and a half after the last answer, a person before the background job", async () => {
    const { clock, pass } = testClock();
    const gate = new ComicVineGate(clock);
    const sent: string[] = [];
    const ask = (name: string, asker: "person" | "background") => gate.through("issue", asker, async () => void sent.push(`${name}@${clock.now()}`));
    const all = [ask("job 1", "background"), ask("job 2", "background")];
    await pass(0);
    all.push(ask("person", "person"));
    await pass(GAP_MS * 3);
    await Promise.all(all);
    expect(sent).toEqual(["job 1@0", "person@1500", "job 2@3000"]);
  });

  it("tells a person past the hour's limit when to try again, rather than keeping them waiting", async () => {
    const { clock } = testClock();
    // No gap: each request goes as the one before it is answered, and nothing waits on the clock.
    const gate = new ComicVineGate(clock, 0);
    await Promise.all(Array.from({ length: HOURLY }, (_, i) => gate.through("volumes", "person", async () => i)));
    expect(gate.sentInTheHour("volumes")).toBe(HOURLY);
    await expect(gate.through("volumes", "person", async () => "too many")).rejects.toBeInstanceOf(ComicVineBusy);
    // Another resource has an hour of its own.
    await expect(gate.through("issue", "person", async () => "answered")).resolves.toBe("answered");
  });

  it("waits out ComicVine saying it was asked too much, three seconds and then six, and says so after the third", async () => {
    const { clock, pass } = testClock();
    const gate = new ComicVineGate(clock, 0);
    const answers = [{ status: 429, body: null }, { status: 200, body: { status_code: 107 } }, { status: 200, body: { status_code: 1, error: "OK", results: [] } }];
    const at: number[] = [];
    const sent = sendPolitely(gate, clock, "issue", "person", async () => {
      at.push(clock.now());
      return answers.shift()!;
    });
    await pass(20_000);
    expect(await sent).toMatchObject({ outcome: "answered", status: 200 });
    expect(at).toEqual([0, 3_000, 9_000]);

    const blocked = sendPolitely(gate, clock, "issue", "person", async () => ({ status: 420, body: null }));
    await pass(20_000);
    expect(await blocked).toMatchObject({ outcome: "too many", status: 420 });
  });

  it("keeps a request's answer by what it asks, never by the key, in one order", () => {
    expect(requestKey(issueRequest(123456))).toBe("issue/4000-123456/?field_list=id%2Cname%2Cissue_number%2Ccover_date%2Cstore_date%2Cvolume%2Cperson_credits%2Cstory_arc_credits%2Csite_detail_url%2Cdeck%2Cdescription");
    const search = runsRequest({ name: "Made Up Saga", year: 2018 });
    expect(requestKey(search)).toBe(requestKey({ ...search, params: Object.fromEntries(Object.entries(search.params).reverse()) }));
  });
});
