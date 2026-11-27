import { describe, expect, it } from "vitest";
import { appKeyGroups } from "@ribbon/core/keys";
import { newerThan, newsSince, type ReleaseNotes } from "@ribbon/core/whats-new";

const notes: ReleaseNotes[] = [
  { version: "0.10.0", points: ["Ten"] },
  { version: "0.9.1", points: ["Nine one"] },
  { version: "0.9.0", points: ["Nine"] },
];

describe("what's new after an update", () => {
  it("compares versions by their numbers, not their letters", () => {
    expect(newerThan("0.10.0", "0.9.1")).toBe(true);
    expect(newerThan("0.9.1", "0.10.0")).toBe(false);
    expect(newerThan("1.0", "1.0.0")).toBe(false);
  });

  it("says nothing on a first run, or when nothing changed", () => {
    expect(newsSince(notes, null, "0.10.0")).toEqual([]);
    expect(newsSince(notes, "0.10.0", "0.10.0")).toEqual([]);
  });

  it("gives every version since the one last seen, the newest first", () => {
    expect(newsSince(notes, "0.9.0", "0.10.0").map((n) => n.version)).toEqual(["0.10.0", "0.9.1"]);
    expect(newsSince(notes, "0.8.0", "0.9.1").map((n) => n.version)).toEqual(["0.9.1", "0.9.0"]);
  });

  it("says nothing after going back to an older version", () => {
    expect(newsSince(notes, "0.10.0", "0.9.0")).toEqual([]);
  });
});

describe("the list of keys", () => {
  it("names the search's chord as the keyboard prints it", () => {
    const search = (mac: boolean) => appKeyGroups(mac)[0]!.lines[0]!.keys;
    expect(search(true)).toContain("⌘+F");
    expect(search(false)).toContain("Ctrl+F");
  });

  it("says what every key does, once", () => {
    const lines = appKeyGroups(false).flatMap((g) => g.lines);
    for (const line of lines) expect(line.keys.length).toBeGreaterThan(0);
    for (const group of appKeyGroups(false)) expect(new Set(group.lines.map((l) => l.does)).size).toBe(group.lines.length);
  });
});
