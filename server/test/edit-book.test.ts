import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import type { SharedEdits } from "../../src/core/edits.ts";
import { importAs, makeLibraries, serverWithAdmin } from "./fixture.ts";

// Editing a book's details as the admin: every device lists it and serves
// it as edited, with what its files say, so the desktop can take an edit
// back; the last edit sent stands; and taken back, it's listed as its files
// have it again.
describe("editing a book on the server", () => {
  let dir: string;
  let server: RibbonServer;
  let admin = "";
  let member = "";
  let red: ListedBook;
  const heard: unknown[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-edit-"));
    const { shelf } = makeLibraries(dir);
    const made = await serverWithAdmin(dir);
    server = made.server;
    admin = made.admin;
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    member = ((await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: "a long password" } })).json() as { token: string }).token;
    await importAs(server, admin, shelf);
    server.events.listen("anyone", (e) => heard.push(e));
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (token: string | null, method: "GET" | "PUT", url: string, payload?: unknown) =>
    server.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const listedRed = async () => ((await as(member, "GET", "/api/books")).json() as { books: ListedBook[] }).books.find((b) => b.id === red.id)!;
  const servedRed = async () => (await as(member, "GET", `/api/books/${red.id}`)).json() as StoredBook & { edited?: SharedEdits };

  it("is the admin's to do, with fields the edit form has, each as text", async () => {
    red = ((await as(admin, "GET", "/api/books")).json() as { books: ListedBook[] }).books.find((b) => b.title === "Red Book")!;
    const edits = { values: { title: "The Red One" } };
    expect((await as(null, "PUT", `/api/books/${red.id}/edits`, edits)).statusCode).toBe(401);
    expect((await as(member, "PUT", `/api/books/${red.id}/edits`, edits)).statusCode).toBe(403);
    expect((await as(admin, "PUT", "/api/books/0123456789abcdef/edits", edits)).statusCode).toBe(404);
    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: { colour: "red" } })).statusCode).toBe(400);
    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: { seriesIndex: 2 } })).statusCode).toBe(400);
    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: ["The Red One"] })).statusCode).toBe(400);
    expect((await listedRed()).title).toBe("Red Book");
  });

  it("lists and serves the book as edited, for every device, with what its files say", async () => {
    const before = await as(member, "GET", "/api/books");
    // A cover chosen by hand is a picture on the device that chose it: never kept here.
    const saved = await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: { title: "The Red One", series: "Colours", seriesIndex: "2", description: "Ruby.", cover: "covers/edited.jpg" } });
    expect(saved.statusCode).toBe(200);
    expect(heard).toContainEqual({ type: "books", data: { edited: red.id } });
    expect((await as(member, "GET", "/api/books")).headers.etag).not.toBe(before.headers.etag);

    expect(await listedRed()).toMatchObject({
      title: "The Red One",
      series: "Colours",
      seriesIndex: 2,
      author: red.author,
      edited: { values: { title: "The Red One", series: "Colours", seriesIndex: "2", description: "Ruby." }, original: { title: "Red Book", series: "", seriesIndex: "" }, updatedAt: expect.any(String) },
    });
    const served = await servedRed();
    expect(served.book).toMatchObject({ title: "The Red One", series: "Colours", seriesIndex: 2, description: "Ruby." });
    expect(served.edited).toMatchObject({ values: { description: "Ruby." }, original: { title: "Red Book", description: expect.any(String) } });
    expect(served.edited!.values.cover).toBeUndefined();
  });

  it("keeps the last edits sent, in place of the ones it had", async () => {
    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: { title: "Red, Again" } })).statusCode).toBe(200);
    expect(await listedRed()).toMatchObject({ title: "Red, Again", series: "", seriesIndex: null, edited: { values: { title: "Red, Again" } } });
  });

  it("takes edits back: listed as its files have it, with no edits", async () => {
    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: {} })).statusCode).toBe(200);
    const back = await listedRed();
    expect(back).toMatchObject({ title: "Red Book", series: "", seriesIndex: null });
    expect(back.edited).toBeUndefined();
    expect((await servedRed()).book.title).toBe("Red Book");
  });

  it("keeps a picture sent with the edits as the book's cover, for every device, until it's taken back", async () => {
    const own = red.cover!;
    // A green picture, as a person might choose: wider than tall.
    const picture = path.join(dir, "green.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=300x200:d=1", "-frames:v", "1", picture]);
    const image = readFileSync(picture).toString("base64");

    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: { title: "Green Now" }, cover: { image } })).statusCode).toBe(200);
    const chosen = await listedRed();
    expect(chosen).toMatchObject({ title: "Green Now", edited: { chosenCover: true } });
    expect(chosen.cover!.hash).not.toBe(own.hash);
    expect(chosen.cover!.aspect).toBeCloseTo(1.5, 2);
    expect((await servedRed()).cover?.hash).toBe(chosen.cover!.hash);
    // Its sizes are served as a book's own are.
    expect((await as(member, "GET", `/covers/${chosen.cover!.hash}-200.jpg`)).statusCode).toBe(200);

    // A change that says nothing of the cover leaves it; one that can't be read changes nothing.
    await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: { title: "Green Still" } });
    expect((await listedRed()).cover!.hash).toBe(chosen.cover!.hash);
    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: {}, cover: { image: Buffer.from("not a picture").toString("base64") } })).statusCode).toBe(400);
    expect(await listedRed()).toMatchObject({ title: "Green Still", cover: { hash: chosen.cover!.hash } });

    // Taken back: its own cover again, and no edits.
    expect((await as(admin, "PUT", `/api/books/${red.id}/edits`, { values: {}, cover: null })).statusCode).toBe(200);
    const back = await listedRed();
    expect(back.cover).toEqual(own);
    expect(back.edited).toBeUndefined();
  });
});
