import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Sessions, sessionCookie, tokenFrom } from "../src/sessions.ts";

const DAY = 86_400_000;

describe("a device's session", () => {
  let db: DatabaseSync;
  let clock = 0;
  let sessions: Sessions;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    clock = Date.parse("2026-11-21T12:00:00Z");
    sessions = new Sessions(db, { now: () => clock });
  });

  it("is found by the token the device was given, and by nothing else", () => {
    const token = sessions.start("ann", "Ribbon on Ann's iPhone");
    expect(sessions.find(token)).toEqual({ personId: "ann", device: "Ribbon on Ann's iPhone" });
    expect(sessions.find("not a token")).toBeNull();
  });

  it("keeps only the token's hash", () => {
    const token = sessions.start("ann");
    const kept = JSON.stringify(db.prepare("SELECT * FROM device_session").all());
    expect(kept).not.toContain(token);
  });

  it("lasts a year, and a day it's used pushes that out again", () => {
    const token = sessions.start("ann");
    clock += 300 * DAY;
    expect(sessions.find(token)).not.toBeNull();
    // 300 days on, it was used: good for a year from then, so still good 300 days later.
    clock += 300 * DAY;
    expect(sessions.find(token)).not.toBeNull();
    // Left alone for more than a year, it's over.
    clock += 366 * DAY;
    expect(sessions.find(token)).toBeNull();
  });

  it("ends on one device, or on all of someone's", () => {
    const phone = sessions.start("ann");
    const tv = sessions.start("ann");
    const brother = sessions.start("yusuf");
    sessions.end(phone);
    expect(sessions.find(phone)).toBeNull();
    expect(sessions.find(tv)).not.toBeNull();
    sessions.endAll("ann");
    expect(sessions.find(tv)).toBeNull();
    expect(sessions.find(brother)).not.toBeNull();
  });

  it("takes in a session an older server handed out, until the day that server said", () => {
    sessions.adopt("ygxesxImUulTCeSpeQBn7g3vaeZnCNB2", "ann", clock + 30 * DAY);
    expect(sessions.find("ygxesxImUulTCeSpeQBn7g3vaeZnCNB2")).toMatchObject({ personId: "ann" });
    // Taken in twice, it is still the one session.
    sessions.adopt("ygxesxImUulTCeSpeQBn7g3vaeZnCNB2", "someone else", clock + 30 * DAY);
    expect(sessions.find("ygxesxImUulTCeSpeQBn7g3vaeZnCNB2")).toMatchObject({ personId: "ann" });
  });
});

describe("the token a request carries", () => {
  it("is its bearer", () => {
    expect(tokenFrom({ authorization: "Bearer abc_DEF-123" })).toBe("abc_DEF-123");
  });

  it("is a cookie named for a session when there's no bearer: what a player sends", () => {
    expect(tokenFrom({ cookie: "theme=dark; __Secure-ribbon.session_token=abc_DEF-123" })).toBe("abc_DEF-123");
    expect(tokenFrom({ cookie: "theme=dark" })).toBeNull();
    expect(tokenFrom({})).toBeNull();
  });

  it("is the part before the dot of a token the older server signed, in a header or percent-encoded in its cookie", () => {
    const signed = "SC6MbLu0aajSPUaDeRvq2wIdnVSgJVwY.IBq9r1bUzzy0UVLGGEZbsDVMxiVp73PX77lQbyLjlVI=";
    expect(tokenFrom({ authorization: `Bearer ${signed}` })).toBe("SC6MbLu0aajSPUaDeRvq2wIdnVSgJVwY");
    expect(tokenFrom({ cookie: `__Secure-better-auth.session_token=${encodeURIComponent(signed)}` })).toBe("SC6MbLu0aajSPUaDeRvq2wIdnVSgJVwY");
  });

  it("goes out as a cookie that's secure over HTTPS, and plain on this machine", () => {
    expect(sessionCookie("abc", { secure: true })).toMatchObject({ name: "__Secure-ribbon.session_token", value: "abc" });
    expect(sessionCookie("abc", { secure: true }).header).toContain("; Secure");
    expect(sessionCookie("abc", { secure: false }).header).not.toContain("Secure");
    expect(tokenFrom({ cookie: sessionCookie("abc", { secure: true }).header.split(";")[0] })).toBe("abc");
  });
});
