import { beforeEach, describe, expect, it } from "vitest";
import { BrowserSignIns, DeviceSignIns, challengeOf, isAppAddress } from "../src/sign-ins.ts";

const MINUTE = 60_000;

describe("a sign-in that goes out to a browser", () => {
  let clock = 0;
  let signIns: BrowserSignIns;
  const app = { app: { returnTo: "http://127.0.0.1:53111/signed-in", challenge: challengeOf("the app's secret") } };

  beforeEach(() => {
    clock = Date.parse("2026-11-21T12:00:00Z");
    signIns = new BrowserSignIns(() => clock);
  });

  it("comes back once, with what it was for and what the provider asked to be kept", () => {
    const state = signIns.ask(app);
    signIns.remember(state, "the provider's memo");
    expect(signIns.comeBack(state)).toEqual({ purpose: app, memo: "the provider's memo" });
    expect(signIns.comeBack(state)).toBeNull();
    expect(signIns.comeBack("never asked")).toBeNull();
  });

  it("is forgotten after ten minutes at the provider", () => {
    const state = signIns.ask(app);
    clock += 11 * MINUTE;
    expect(signIns.comeBack(state)).toBeNull();
  });

  it("gives the app a code that only the app's own secret can trade, once", () => {
    const code = signIns.codeFor("ann", app.app.challenge);
    expect(signIns.redeem(code, "the app's secret")).toBe("ann");
    expect(signIns.redeem(code, "the app's secret")).toBeNull();
  });

  it("spends a code that was tried with the wrong secret", () => {
    const code = signIns.codeFor("ann", app.app.challenge);
    expect(signIns.redeem(code, "someone else's guess")).toBeNull();
    expect(signIns.redeem(code, "the app's secret")).toBeNull();
  });

  it("lets a code go after a minute", () => {
    const code = signIns.codeFor("ann", app.app.challenge);
    clock += 2 * MINUTE;
    expect(signIns.redeem(code, "the app's secret")).toBeNull();
  });
});

describe("where a sign-in may be sent back", () => {
  it("is a port on this computer, or the app's own scheme", () => {
    expect(isAppAddress("http://127.0.0.1:53111/signed-in", ["ribbon"])).toBe(true);
    expect(isAppAddress("http://localhost:1420/", ["ribbon"])).toBe(true);
    expect(isAppAddress("ribbon://signed-in", ["ribbon"])).toBe(true);
  });

  it("is never another website, or another app's scheme", () => {
    expect(isAppAddress("https://elsewhere.example/steal", ["ribbon"])).toBe(false);
    expect(isAppAddress("http://127.0.0.1.elsewhere.example/", ["ribbon"])).toBe(false);
    expect(isAppAddress("javascript:alert(1)", ["ribbon"])).toBe(false);
    expect(isAppAddress("not an address", ["ribbon"])).toBe(false);
  });
});

describe("a sign-in for a TV", () => {
  let clock = 0;
  let signIns: DeviceSignIns;

  beforeEach(() => {
    clock = Date.parse("2026-11-21T12:00:00Z");
    signIns = new DeviceSignIns(() => clock);
  });

  it("waits until someone signed in says the code's device is theirs, then tells the device once", () => {
    const asked = signIns.ask("Ribbon on Living Room");
    expect(asked.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(signIns.answer(asked.secret)).toBe("waiting");
    expect(signIns.waiting(asked.code)).toEqual({ device: "Ribbon on Living Room" });

    expect(signIns.approve(asked.code, "ann")).toBe(true);
    expect(signIns.answer(asked.secret)).toEqual({ personId: "ann", device: "Ribbon on Living Room" });
    expect(signIns.answer(asked.secret)).toBe("gone");
  });

  it("isn't approved by someone merely arriving signed in: they're asked, and only their yes lets the device in", () => {
    const asked = signIns.ask("Ribbon on Living Room");
    const ticket = signIns.propose(asked.code, "ann")!;
    // Sent here by a link, signed in without a click: the device still waits.
    expect(signIns.answer(asked.secret)).toBe("waiting");
    expect(signIns.confirm("a guess at the ticket")).toBeNull();
    expect(signIns.confirm(ticket)).toEqual({ device: "Ribbon on Living Room" });
    expect(signIns.confirm(ticket)).toBeNull();
    expect(signIns.answer(asked.secret)).toMatchObject({ personId: "ann" });
  });

  it("has nothing to ask about a code that isn't waiting, and forgets the question after five minutes", () => {
    expect(signIns.propose("BBBB-BBBC", "ann")).toBeNull();
    const asked = signIns.ask("Ribbon on Living Room");
    const ticket = signIns.propose(asked.code, "ann")!;
    clock += 6 * MINUTE;
    expect(signIns.confirm(ticket)).toBeNull();
    expect(signIns.answer(asked.secret)).toBe("waiting");
  });

  it("keeps only so many at once, so asking can't fill the server", () => {
    for (let i = 0; i < 5000; i++) signIns.ask("a TV");
    expect(() => signIns.ask("one more")).toThrow("Too many sign-ins");
    clock += 11 * MINUTE;
    expect(signIns.ask("a TV later").code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  });

  it("reads a code however it was typed", () => {
    const asked = signIns.ask("Ribbon on Living Room");
    const typed = asked.code.toLowerCase().replace("-", " ");
    expect(signIns.approve(typed, "ann")).toBe(true);
  });

  it("is approved once, and never by a code that isn't showing anywhere", () => {
    const asked = signIns.ask("Ribbon on Living Room");
    expect(signIns.approve("BBBB-BBBC", "mallory")).toBe(false);
    expect(signIns.approve(asked.code, "ann")).toBe(true);
    expect(signIns.approve(asked.code, "mallory")).toBe(false);
    expect(signIns.waiting(asked.code)).toBeNull();
    expect(signIns.answer(asked.secret)).toMatchObject({ personId: "ann" });
  });

  it("is gone after ten minutes, approved or not", () => {
    const asked = signIns.ask("Ribbon on Living Room");
    clock += 11 * MINUTE;
    expect(signIns.approve(asked.code, "ann")).toBe(false);
    expect(signIns.answer(asked.secret)).toBe("gone");
  });

  it("tells a device nothing for a secret that isn't its own", () => {
    signIns.ask("Ribbon on Living Room");
    expect(signIns.answer("a guess")).toBe("gone");
  });
});
