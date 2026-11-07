import { log } from "./log";

/**
 * Ribbon updating itself, on Windows and the Mac, from its own GitHub
 * releases, with no server of ours (docs/RELEASING.md, section 6).
 *
 * Every release carries `latest.json`: its version and, for each system, the
 * file to fetch and its signature. GitHub serves the newest published
 * release's at one address, which tauri.conf.json names; a draft isn't seen
 * there, so publishing the draft is what ships an update. Ribbon asks a little
 * after it starts and every few hours after that (`Updater`). A newer version
 * is downloaded behind whatever you're doing, and Tauri's updater checks that
 * the release's key signed it (tauri.conf.json holds the public half) before
 * anything installs it.
 *
 * Then it waits for you. A note offers to restart into the new version when
 * restarting would cut nothing short: no book playing, nothing being
 * transcribed (`offersRestart`). Closing Ribbon installs it too, for the next
 * time it opens. It never restarts on its own. A check or a download that
 * fails (offline, GitHub down) says nothing: the next check tries again.
 */

/** Where new versions come from: Tauri's updater on a computer (host/tauri.ts), a stand-in in the tests. */
export interface UpdateSource {
  /** A version newer than this one, or null when this is the newest. Rejects when it can't tell: offline, GitHub down. */
  check(): Promise<NewVersion | null>;
}

/** A newer version than the one running, found by a check. */
export interface NewVersion {
  version: string;
  /** Fetch it whole, its signature checked. Rejects when it can't. */
  download(): Promise<void>;
  /**
   * Put what was downloaded in place of this version, then start it
   * (`restart`) or leave it for the next start (closing). On Windows the
   * installer takes over and Ribbon ends here, either way.
   */
  install(restart: boolean): Promise<void>;
  /** Let go of it unused: the downloaded bytes are held until then. */
  forget(): Promise<void>;
}

/** What the app shows of updating. */
export interface UpdateStatus {
  /** When GitHub last answered a check (ms since 1970), whether or not there was anything new; null before the first answer. */
  checkedAt: number | null;
  /** A newer version, downloaded and ready to install, or null. */
  ready: string | null;
}

/** The first check waits this long after Ribbon starts: the shelf paints and the folders are checked first. */
export const FIRST_CHECK_MS = 30_000;
/** And then one this often, for a Ribbon left open for days. */
export const CHECK_EVERY_MS = 4 * 60 * 60_000;

/**
 * Asking for new versions, and keeping the one downloaded until it's
 * installed. One check at a time; each one that finds a version newer than
 * the one ready downloads it in its place.
 */
export class Updater {
  private status: UpdateStatus;
  private downloaded: NewVersion | null = null;
  private checking: Promise<void> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private every: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly source: UpdateSource,
    private readonly onChange: (status: UpdateStatus) => void,
    checkedAt: number | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.status = { checkedAt, ready: null };
  }

  /** Check a little after now, then every few hours, until `stop`. */
  start(): void {
    if (this.first || this.every) return;
    this.first = unref(
      setTimeout(() => {
        this.first = null;
        this.every = unref(setInterval(() => void this.check(), CHECK_EVERY_MS));
        void this.check();
      }, FIRST_CHECK_MS),
    );
  }

  /** No more checks. A version already downloaded stays ready. */
  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
    this.first = this.every = null;
  }

  /** Ask now, unless an ask is under way, and download what's new. Never rejects. */
  check(): Promise<void> {
    this.checking ??= this.checkOnce().finally(() => (this.checking = null));
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    let found: NewVersion | null;
    try {
      found = await this.source.check();
    } catch (e) {
      log.info("could not check for a new version of Ribbon:", describe(e));
      return;
    }
    this.change({ checkedAt: this.now() });
    if (!found) return;
    if (found.version === this.status.ready) {
      void found.forget().catch(() => undefined);
      return;
    }
    try {
      log.info(`downloading Ribbon ${found.version}`);
      await found.download();
    } catch (e) {
      log.info(`could not download Ribbon ${found.version}:`, describe(e));
      void found.forget().catch(() => undefined);
      return;
    }
    log.info(`Ribbon ${found.version} is downloaded and ready to install`);
    void this.downloaded?.forget().catch(() => undefined);
    this.downloaded = found;
    this.change({ ready: found.version });
  }

  /**
   * Install the version that's ready, and start it (`restart`) or leave it
   * for the next start. False when there's none, or it couldn't be put in
   * place: then it's let go, and the next check downloads it again.
   */
  async install(restart: boolean): Promise<boolean> {
    const ready = this.downloaded;
    if (!ready) return false;
    try {
      log.info(`installing Ribbon ${ready.version}${restart ? ", then restarting" : " for the next start"}`);
      await ready.install(restart);
      return true;
    } catch (e) {
      log.warn(`could not install Ribbon ${ready.version}:`, describe(e));
      this.downloaded = null;
      void ready.forget().catch(() => undefined);
      this.change({ ready: null });
      return false;
    }
  }

  private change(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange(this.status);
  }
}

/**
 * Whether to offer restarting into a new version now: one is ready, its
 * offer wasn't put off, and restarting would cut nothing short, no book
 * playing and nothing being transcribed. The offer comes back when they stop.
 */
export function offersRestart(now: { ready: string | null; putOff: boolean; playing: boolean; transcribing: boolean }): boolean {
  return now.ready !== null && !now.putOff && !now.playing && !now.transcribing;
}

/** What Settings says of updating: the version that's ready, or the one `running` and when Ribbon last looked for a newer one. */
export function settingsLine(update: { on: boolean; checkedAt: number | null; ready: string | null }, running: string, now: number): string {
  if (update.ready) return `Ribbon ${update.ready} is downloaded and ready. It installs when you restart Ribbon or close it.`;
  if (update.checkedAt !== null) return `Ribbon ${running}. Last looked for a new version ${checkedWhen(update.checkedAt, now)}.`;
  return update.on ? `Ribbon ${running}. Looks for a new version shortly.` : `Ribbon ${running}.`;
}

/** When the last check was, said for Settings: "just now", "5 minutes ago", "3 hours ago", "yesterday". */
export function checkedWhen(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  const ago = (n: number, unit: string) => `${n === 1 ? (unit === "hour" ? "an" : "a") : n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (minutes < 60) return ago(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago(hours, "hour");
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : ago(days, "day");
}

/** Under Node (the tests) a timer never holds the process open. */
function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Tauri rejects with plain strings; everything else with Errors. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
