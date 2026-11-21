import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignInRefused } from "@ribbon/auth/identity";
import { identityFrom, pocketId } from "../src/pocket-id.ts";
import { fakeIssuer, signInAt, type FakeIssuer } from "./fake-issuer.ts";

const CALLBACK = "https://ribbon.example/sign-in/callback";

describe("signing in with Pocket ID", () => {
  let issuer: FakeIssuer;
  const provider = () => pocketId({ url: issuer.url, clientId: issuer.clientId, clientSecret: issuer.clientSecret });

  beforeAll(async () => {
    issuer = await fakeIssuer();
  });
  afterAll(() => issuer.close());
  beforeEach(() => {
    issuer.refuses = null;
    issuer.forges = false;
  });

  it("sends the browser to the instance, and knows who came back", async () => {
    const pocket = provider();
    const { url, memo } = await pocket.begin("the state", CALLBACK);
    expect(url.origin).toBe(issuer.url);
    expect(url.searchParams.get("scope")).toBe("openid profile email groups");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const { query } = await signInAt(url);
    expect(query.state).toBe("the state");
    const who = await pocket.finish(query, CALLBACK, memo);
    expect(who).toMatchObject({ provider: "pocket-id", subject: "3f0c9a2e-7d41-4a0b-9c55-1b2e8d6f4a10", username: "ann", displayName: "Ann", email: "ann@example.com", emailVerified: true, groups: ["family"] });
  });

  it("says so in plain words when they cancel or aren't allowed in", async () => {
    const pocket = provider();
    const { url, memo } = await pocket.begin("the state", CALLBACK);
    issuer.refuses = "access_denied";
    const { query } = await signInAt(url);
    await expect(pocket.finish(query, CALLBACK, memo)).rejects.toThrow("cancelled, or this account isn't allowed");
  });

  it("believes nothing signed by a key the instance didn't publish", async () => {
    const pocket = provider();
    const { url, memo } = await pocket.begin("the state", CALLBACK);
    issuer.forges = true;
    const { query } = await signInAt(url);
    await expect(pocket.finish(query, CALLBACK, memo)).rejects.toThrow("didn't check out");
  });

  it("won't finish a sign-in it didn't start: another one's memo doesn't fit", async () => {
    const pocket = provider();
    const mine = await pocket.begin("mine", CALLBACK);
    const theirs = await pocket.begin("theirs", CALLBACK);
    const { query } = await signInAt(theirs.url);
    await expect(pocket.finish(query, CALLBACK, mine.memo)).rejects.toThrow(SignInRefused);
  });

  it("refuses, rather than falls over, when what it asked to be kept didn't come back", async () => {
    const pocket = provider();
    const { url } = await pocket.begin("the state", CALLBACK);
    const { query } = await signInAt(url);
    await expect(pocket.finish(query, CALLBACK, "")).rejects.toThrow(SignInRefused);
  });

  it("won't take an answer that says it's from another issuer", async () => {
    const pocket = provider();
    const { url, memo } = await pocket.begin("the state", CALLBACK);
    const { query } = await signInAt(url);
    await expect(pocket.finish({ ...query, iss: "https://elsewhere.example" }, CALLBACK, memo)).rejects.toThrow("somewhere other than");
  });

  it("says there's no Pocket ID at an address that isn't one, and tries again the next time", async () => {
    const nowhere = pocketId({ url: "http://127.0.0.1:9", clientId: "x", clientSecret: "y" });
    await expect(nowhere.begin("the state", CALLBACK)).rejects.toThrow("couldn't be reached");
    await expect(nowhere.begin("the state", CALLBACK)).rejects.toThrow("couldn't be reached");
  });
});

describe("who Pocket ID's claims say someone is", () => {
  it("shows the display name, then the full name, then the username", () => {
    expect(identityFrom({ sub: "1", preferred_username: "ann", display_name: "Annie", name: "Ann Example" }).displayName).toBe("Annie");
    expect(identityFrom({ sub: "1", preferred_username: "ann", display_name: "", name: "Ann Example" }).displayName).toBe("Ann Example");
    expect(identityFrom({ sub: "1", preferred_username: "ann" }).displayName).toBe("ann");
  });

  it("leaves out what the instance didn't say, and has no groups rather than missing ones", () => {
    const who = identityFrom({ sub: "1", preferred_username: "ann" });
    expect(who).toEqual({ provider: "pocket-id", subject: "1", username: "ann", displayName: "ann", groups: [], claims: {} });
  });

  it("carries the picture's address, and an email only as verified as the instance says", () => {
    const who = identityFrom({ sub: "1", preferred_username: "ann", picture: "https://id.example/api/users/1/profile-picture.png", email: "ann@example.com" });
    expect(who.picture).toBe("https://id.example/api/users/1/profile-picture.png");
    expect(who).toMatchObject({ email: "ann@example.com", emailVerified: false });
  });

  it("keeps everything else as it came: how they signed in, their names, an admin's own claims", () => {
    const who = identityFrom({ sub: "1", preferred_username: "ann", iss: "https://id.example", aud: "ribbon", exp: 1, nonce: "n", amr: ["phr"], auth_time: 1795000000, given_name: "Ann", family_name: "Example", shelf: "sci-fi" });
    expect(who.claims).toEqual({ amr: ["phr"], auth_time: 1795000000, given_name: "Ann", family_name: "Example", shelf: "sci-fi" });
  });

  it("refuses an answer that names nobody", () => {
    expect(() => identityFrom({ preferred_username: "ann" })).toThrow(SignInRefused);
  });
});
