import { describe, expect, it } from "vitest";
// @ts-expect-error a plain script, with no types of its own
import { latestJson } from "../../../tools/latest-json.mjs";

/**
 * latest.json, which every installed Ribbon reads to learn of a new version
 * (tools/latest-json.mjs). A mistake here is silent too: an install that
 * finds no entry for its system stays where it is without a word.
 */
const signatures = {
  "Ribbon_0.30.0_x64-setup.exe": "c2V0dXAgc2lnbmF0dXJl\n",
  "Ribbon_0.30.0_x64_en-US.msi": "bXNpIHNpZ25hdHVyZQ==",
  "Ribbon_0.30.0_aarch64.app.tar.gz": "bWFjIHNpZ25hdHVyZQ==",
  "Ribbon_0.30.0_aarch64.dmg": "not an update",
};

describe("latest.json", () => {
  it("names each system's file and its signature, at the tag's release", () => {
    expect(latestJson("v0.30.0", signatures, new Date("2026-11-07T12:34:56.789Z"))).toEqual({
      version: "0.30.0",
      notes: "What's new in Ribbon 0.30.0: https://github.com/KhalidAdan/ribbon/releases/tag/v0.30.0",
      pub_date: "2026-11-07T12:34:56Z",
      platforms: {
        "windows-x86_64": { signature: "c2V0dXAgc2lnbmF0dXJl", url: "https://github.com/KhalidAdan/ribbon/releases/download/v0.30.0/Ribbon_0.30.0_x64-setup.exe" },
        "windows-x86_64-msi": { signature: "bXNpIHNpZ25hdHVyZQ==", url: "https://github.com/KhalidAdan/ribbon/releases/download/v0.30.0/Ribbon_0.30.0_x64_en-US.msi" },
        "darwin-aarch64": { signature: "bWFjIHNpZ25hdHVyZQ==", url: "https://github.com/KhalidAdan/ribbon/releases/download/v0.30.0/Ribbon_0.30.0_aarch64.app.tar.gz" },
      },
    });
  });

  it("refuses to leave a system out", () => {
    const { ["Ribbon_0.30.0_aarch64.app.tar.gz"]: _mac, ...noMac } = signatures;
    expect(() => latestJson("v0.30.0", noMac)).toThrow("No signature for Ribbon_0.30.0_aarch64.app.tar.gz");
  });

  it("takes only the tag's own version's files", () => {
    expect(() => latestJson("v0.30.1", signatures)).toThrow("No signature for Ribbon_0.30.1_x64-setup.exe");
  });
});
