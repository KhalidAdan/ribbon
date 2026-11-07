import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeHost } from "@ribbon/host-node/node";
import { AppController, type AppState, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { CHECK_EVERY_MS, checkedWhen, FIRST_CHECK_MS, offersRestart, settingsLine, Updater, type UpdateSource, type UpdateStatus } from "../src/app/updates";

/**
 * Ribbon updating itself (app/updates.ts): when it asks GitHub, what it
 * downloads, when it offers to restart, and what restarting and closing do.
 * GitHub is a stand-in here, which says what it was asked to do.
 */
function github() {
  const did: string[] = [];
  let newest: string | null = null;
  let offline = false;
  let downloads = true;
  let installs = true;
  const source: UpdateSource = {
    async check() {
      did.push("check");
      if (offline) throw new Error("error sending request for url (https://github.com/…/latest.json)");
      const version = newest;
      if (!version) return null;
      return {
        version,
        async download() {
          did.push(`download ${version}`);
          if (!downloads) throw new Error("connection reset");
        },
        async install(restart) {
          did.push(`install ${version}${restart ? ", restart" : ""}`);
          if (!installs) throw new Error("Permission denied");
        },
        async forget() {
          did.push(`forget ${version}`);
        },
      };
    },
  };
  return {
    source,
    did,
    publish: (version: string | null) => void (newest = version),
    offline: (yes: boolean) => void (offline = yes),
    downloadsFail: () => void (downloads = false),
    installsFail: () => void (installs = false),
  };
}

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-07T09:00:00Z") }));
afterEach(() => vi.useRealTimers());

function updater(gh = github(), checkedAt: number | null = null) {
  const seen: UpdateStatus[] = [];
  const u = new Updater(gh.source, (s) => seen.push(s), checkedAt);
  return { u, gh, seen, last: () => seen[seen.length - 1]! };
}

describe("when Ribbon asks for a new version", () => {
  it("asks a little after it starts, not before, then every few hours", async () => {
    const { u, gh } = updater();
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(gh.did).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.did).toEqual(["check"]);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1);
    expect(gh.did).toEqual(["check"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.did).toEqual(["check", "check"]);
    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS);
    expect(gh.did).toHaveLength(4);
    u.stop();
  });

  it("asks no more once stopped, and starting twice doesn't ask twice as often", async () => {
    const { u, gh } = updater();
    u.start();
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + CHECK_EVERY_MS);
    expect(gh.did).toEqual(["check", "check"]);
    u.stop();
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS);
    expect(gh.did).toEqual(["check", "check"]);
  });

  it("asks once at a time", async () => {
    const { u, gh } = updater();
    await Promise.all([u.check(), u.check()]);
    expect(gh.did).toEqual(["check"]);
  });

  it("keeps when GitHub last answered, whether or not there was anything new", async () => {
    const { u, last } = updater();
    await u.check();
    expect(last()).toEqual({ checkedAt: Date.parse("2026-11-07T09:00:00Z"), ready: null });
  });

  it("says nothing when it can't ask, and asks again at the next check", async () => {
    const { u, gh, seen } = updater(github(), 1_000);
    gh.offline(true);
    u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(seen).toEqual([]);
    gh.offline(false);
    gh.publish("0.30.0");
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(gh.did).toEqual(["check", "check", "download 0.30.0"]);
    expect(seen[seen.length - 1]!.ready).toBe("0.30.0");
    u.stop();
  });
});

describe("what Ribbon downloads", () => {
  it("downloads a newer version, then calls it ready", async () => {
    const { u, gh, seen } = updater();
    gh.publish("0.30.0");
    await u.check();
    expect(gh.did).toEqual(["check", "download 0.30.0"]);
    expect(seen.map((s) => s.ready)).toEqual([null, "0.30.0"]);
  });

  it("doesn't download the version that's ready again, and lets the check's copy go", async () => {
    const { u, gh } = updater();
    gh.publish("0.30.0");
    await u.check();
    await u.check();
    expect(gh.did).toEqual(["check", "download 0.30.0", "check", "forget 0.30.0"]);
  });

  it("puts a version newer than the one ready in its place", async () => {
    const { u, gh, last } = updater();
    gh.publish("0.30.0");
    await u.check();
    gh.publish("0.30.1");
    await u.check();
    expect(gh.did).toEqual(["check", "download 0.30.0", "check", "download 0.30.1", "forget 0.30.0"]);
    expect(last().ready).toBe("0.30.1");
  });

  it("says nothing of a download that fails, and tries it again at the next check", async () => {
    const { u, gh, last } = updater();
    gh.publish("0.30.0");
    gh.downloadsFail();
    await u.check();
    expect(gh.did).toEqual(["check", "download 0.30.0", "forget 0.30.0"]);
    expect(last().ready).toBeNull();
    await u.check();
    expect(gh.did.slice(3)).toEqual(["check", "download 0.30.0", "forget 0.30.0"]);
  });
});

describe("installing", () => {
  it("installs nothing when nothing is ready", async () => {
    const { u, gh } = updater();
    expect(await u.install(true)).toBe(false);
    expect(gh.did).toEqual([]);
  });

  it("installs the version that's ready, restarting into it or not", async () => {
    const { u, gh } = updater();
    gh.publish("0.30.0");
    await u.check();
    expect(await u.install(false)).toBe(true);
    expect(await u.install(true)).toBe(true);
    expect(gh.did.slice(2)).toEqual(["install 0.30.0", "install 0.30.0, restart"]);
  });

  it("lets go of a version that couldn't be installed, to download it again at the next check", async () => {
    const { u, gh, last } = updater();
    gh.publish("0.30.0");
    await u.check();
    gh.installsFail();
    expect(await u.install(true)).toBe(false);
    expect(last().ready).toBeNull();
    expect(gh.did.slice(2)).toEqual(["install 0.30.0, restart", "forget 0.30.0"]);
    await u.check();
    expect(gh.did.slice(4)).toEqual(["check", "download 0.30.0"]);
  });
});

describe("when Ribbon offers to restart into a new version", () => {
  const idle = { ready: "0.30.0", putOff: false, playing: false, transcribing: false };

  it("offers when a version is ready and restarting would cut nothing short", () => {
    expect(offersRestart(idle)).toBe(true);
  });

  it("doesn't while a book plays, while anything is transcribed, once put off, or with nothing ready", () => {
    expect(offersRestart({ ...idle, playing: true })).toBe(false);
    expect(offersRestart({ ...idle, transcribing: true })).toBe(false);
    expect(offersRestart({ ...idle, putOff: true })).toBe(false);
    expect(offersRestart({ ...idle, ready: null })).toBe(false);
  });
});

describe("when Settings says Ribbon last looked", () => {
  const now = Date.parse("2026-11-07T09:00:00Z");
  it("says it as a person would", () => {
    expect(checkedWhen(now - 20_000, now)).toBe("just now");
    expect(checkedWhen(now + 60_000, now)).toBe("just now");
    expect(checkedWhen(now - 60_000, now)).toBe("a minute ago");
    expect(checkedWhen(now - 25 * 60_000, now)).toBe("25 minutes ago");
    expect(checkedWhen(now - 61 * 60_000, now)).toBe("an hour ago");
    expect(checkedWhen(now - 4 * 3_600_000, now)).toBe("4 hours ago");
    expect(checkedWhen(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(checkedWhen(now - 3 * 86_400_000, now)).toBe("3 days ago");
  });
});

describe("what Settings says of updating", () => {
  const now = Date.parse("2026-11-07T09:00:00Z");
  it("names the version that's ready, and when it installs", () => {
    expect(settingsLine({ on: true, checkedAt: now, ready: "0.30.0" }, "0.29.1", now)).toBe("Ribbon 0.30.0 is downloaded and ready. It installs when you restart Ribbon or close it.");
  });

  it("names this version and when Ribbon last looked, even with looking turned off", () => {
    expect(settingsLine({ on: true, checkedAt: now - 3 * 3_600_000, ready: null }, "0.29.1", now)).toBe("Ribbon 0.29.1. Last looked for a new version 3 hours ago.");
    expect(settingsLine({ on: false, checkedAt: now - 30 * 3_600_000, ready: null }, "0.29.1", now)).toBe("Ribbon 0.29.1. Last looked for a new version yesterday.");
  });

  it("says it will look, before it first has", () => {
    expect(settingsLine({ on: true, checkedAt: null, ready: null }, "0.29.1", now)).toBe("Ribbon 0.29.1. Looks for a new version shortly.");
    expect(settingsLine({ on: false, checkedAt: null, ready: null }, "0.29.1", now)).toBe("Ribbon 0.29.1.");
  });
});

describe("updating in the controller", () => {
  /** A controller on a computer that updates itself, with a window that can be closed and a question it answers `answer`. */
  function app(gh = github()) {
    const asked: string[] = [];
    let answer = false;
    let close: { flush: () => Promise<void>; mayClose: () => Promise<boolean> } | null = null;
    const settings = memorySettings();
    const platform: Platform = {
      host: nodeHost(),
      pickFolder: async () => null,
      allowFolder: async () => undefined,
      fileUrl: (p) => `file:///${p}`,
      sources: memorySources(),
      appSettings: settings,
      updates: gh.source,
      onWindowClose: (flush, mayClose) => {
        close = { flush, mayClose };
        return () => undefined;
      },
      askToClose: async (why) => {
        asked.push(why);
        return answer;
      },
    };
    const c = new AppController(platform);
    c.installLifecycle();
    const set = (patch: Partial<AppState>) => (c as unknown as { set(p: Partial<AppState>): void }).set(patch);
    /** As the window closing does: ask, then write and install. */
    const closeWindow = async () => (await close!.mayClose()) && (await close!.flush(), true);
    return { c, gh, set, settings, asked, closeWindow, answer: (yes: boolean) => void (answer = yes) };
  }
  const ready = async (a: ReturnType<typeof app>) => {
    a.gh.publish("0.30.0");
    await a.c.boot();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
  };

  it("has nothing to say of updates where the platform doesn't update itself", async () => {
    const c = new AppController({ host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => p, sources: memorySources() });
    await c.boot();
    expect(c.getState().update).toBeNull();
    c.destroy();
  });

  it("checks after starting, says the version that's ready, and keeps when it checked for the next start", async () => {
    const a = app();
    await ready(a);
    expect(a.c.getState().update).toEqual({ on: true, checkedAt: Date.parse("2026-11-07T09:00:30Z"), ready: "0.30.0", putOff: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await a.settings.read()).updateCheckedAt).toBe(Date.parse("2026-11-07T09:00:30Z"));
    a.c.destroy();
  });

  it("asks nothing once updates are turned off, and keeps that for the next start", async () => {
    const a = app();
    await a.c.boot();
    await a.c.setUpdateChecks(false);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + CHECK_EVERY_MS);
    expect(a.gh.did).toEqual([]);
    expect((await a.settings.read()).checkForUpdates).toBe(false);

    const next = app();
    await next.settings.write(await a.settings.read());
    await next.c.boot();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(next.c.getState().update?.on).toBe(false);
    expect(next.gh.did).toEqual([]);
    a.c.destroy();
    next.c.destroy();
  });

  it("puts the offer off on Later, and offers a newer version afresh", async () => {
    const a = app();
    await ready(a);
    a.c.putOffUpdate();
    expect(a.c.getState().update?.putOff).toBe(true);
    a.gh.publish("0.30.1");
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(a.c.getState().update).toMatchObject({ ready: "0.30.1", putOff: false });
    a.c.destroy();
  });

  it("restarts into the new version when asked, after writing every place", async () => {
    const a = app();
    await ready(a);
    const flushed = vi.spyOn(a.c, "flushPositions");
    await a.c.restartToUpdate();
    expect(flushed).toHaveBeenCalled();
    expect(a.gh.did).toEqual(["check", "download 0.30.0", "install 0.30.0, restart"]);
    expect(a.asked).toEqual([]);
    a.c.destroy();
  });

  it("asks first while transcribing, as closing does, and installs nothing on a no", async () => {
    const a = app();
    await ready(a);
    a.set({ transcribingForServer: { title: "Voidscarred", done: 302, total: 612 } });
    await a.c.restartToUpdate();
    expect(a.asked).toHaveLength(1);
    expect(a.gh.did).toEqual(["check", "download 0.30.0"]);
    a.answer(true);
    await a.c.restartToUpdate();
    expect(a.gh.did).toEqual(["check", "download 0.30.0", "install 0.30.0, restart"]);
    a.c.destroy();
  });

  it("says so when the new version couldn't be installed", async () => {
    const a = app();
    await ready(a);
    a.gh.installsFail();
    await a.c.restartToUpdate();
    expect(a.c.getState().error).toBe("Ribbon couldn't update itself to 0.30.0. It tries again later; the log says why.");
    expect(a.c.getState().update?.ready).toBeNull();
    a.c.destroy();
  });

  it("installs the version that's ready when Ribbon closes, without restarting it", async () => {
    const a = app();
    await ready(a);
    expect(await a.closeWindow()).toBe(true);
    expect(a.gh.did).toEqual(["check", "download 0.30.0", "install 0.30.0"]);
    a.c.destroy();
  });

  it("closes as before when nothing is ready", async () => {
    const a = app();
    await a.c.boot();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(await a.closeWindow()).toBe(true);
    expect(a.gh.did).toEqual(["check"]);
    a.c.destroy();
  });
});
