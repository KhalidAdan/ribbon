import { describe, expect, it } from "vitest";
// @ts-expect-error a plain script, with no types of its own
import { jobsFor } from "../../../tools/what-changed.mjs";

const all = { desktop: true, server: true, image: true, apple: true };
const none = { desktop: false, server: false, image: false, apple: false };

// A mistake here is silent: a job skipped that should have run shows as a pass.
describe("which CI jobs a change needs", () => {
  it("runs everything for anything it doesn't recognise, which is the safe way to be wrong", () => {
    expect(jobsFor(["package-lock.json"])).toEqual(all);
    expect(jobsFor([".github/workflows/checks.yml"])).toEqual(all);
    expect(jobsFor(["a-folder-from-next-year/file.ts"])).toEqual(all);
    expect(jobsFor(["tools/same-app.mjs"])).toEqual(all);
    expect(jobsFor(["everything"])).toEqual(all);
  });

  it("runs nothing for words alone", () => {
    expect(jobsFor(["docs/SERVER.md", "README.md", "packages/server/README.md"])).toEqual(none);
  });

  it("keeps the Apple app's changes to the Apple job", () => {
    expect(jobsFor(["packages/apple/Ribbon/Look.swift"])).toEqual({ ...none, apple: true });
  });

  it("runs the server's tests for a desktop change, since they run the desktop's own code", () => {
    expect(jobsFor(["packages/desktop/src/app/controller.ts"])).toEqual({ ...none, desktop: true, server: true });
  });

  it("builds the image for the crates inside the desktop that it's made from", () => {
    expect(jobsFor(["packages/desktop/src-tauri/ebook/src/lib.rs"])).toEqual({ ...none, desktop: true, server: true, image: true });
    expect(jobsFor(["packages/desktop/src-tauri/src/speech.rs"]).image).toBe(false);
  });

  it("runs the desktop, the server and the image for what they share", () => {
    expect(jobsFor(["packages/core/src/sources.ts"])).toEqual({ ...none, desktop: true, server: true, image: true });
    expect(jobsFor(["packages/host-node/src/node.ts"])).toEqual({ ...none, desktop: true, server: true, image: true });
  });

  it("leaves the desktop out of a change to the server alone", () => {
    expect(jobsFor(["packages/server/src/app.ts"])).toEqual({ ...none, server: true, image: true });
  });

  it("runs the most any one file needs", () => {
    expect(jobsFor(["packages/server/src/app.ts", "packages/apple/Ribbon/Look.swift", "docs/SERVER.md"])).toEqual({ ...none, server: true, image: true, apple: true });
  });
});
