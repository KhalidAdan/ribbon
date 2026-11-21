import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const MINUTE_MS = 60_000;

/**
 * Sign-ins under way, for apps that can't take a password themselves.
 * Both kinds are kept in memory: each lasts minutes, and one cut short by
 * the server starting again is simply begun again.
 */

/** What a browser sign-in is for: an app waiting at its own address, or a device showing a code. */
export type Purpose = { app: { returnTo: string; challenge: string } } | { device: string };

/**
 * Sign-ins that go out to a browser and come back.
 *
 * An app that wants someone signed in opens the server's page in the
 * system browser, saying where to come back to (`returnTo`) and the hash of
 * a secret only it knows (`challenge`). When the person returns from the
 * provider, the browser is sent on to the app with a one-time code, and the
 * app trades the code and its secret for a session. A code alone, read off
 * the address bar by something else, is worth nothing.
 *
 *     asked ──they come back from the provider──▶ returned ──the app trades its code──▶ signed in
 *       │                                            │
 *       └──ten minutes pass──▶ forgotten             └──a minute passes──▶ forgotten
 */
export class BrowserSignIns {
  private readonly asked = new Map<string, { purpose: Purpose; memo: string; until: number }>();
  private readonly returned = new Map<string, { personId: string; challenge: string; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Someone is about to be sent to the provider. The `state` to send with them. */
  ask(purpose: Purpose): string {
    this.forget();
    const state = randomBytes(24).toString("base64url");
    this.asked.set(state, { purpose, memo: "", until: this.now() + 10 * MINUTE_MS });
    return state;
  }

  /** What the provider needs back when they return (`BrowserProvider.begin`'s memo). */
  remember(state: string, memo: string): void {
    const waiting = this.asked.get(state);
    if (waiting) waiting.memo = memo;
  }

  /** They came back with this `state`: what it was for, once. Null when it was never asked, was used, or took too long. */
  comeBack(state: string): { purpose: Purpose; memo: string } | null {
    this.forget();
    const waiting = this.asked.get(state);
    if (!waiting) return null;
    this.asked.delete(state);
    return { purpose: waiting.purpose, memo: waiting.memo };
  }

  /** They proved who they are, for an app: the one-time code to send the app. */
  codeFor(personId: string, challenge: string): string {
    const code = randomBytes(24).toString("base64url");
    this.returned.set(code, { personId, challenge, until: this.now() + MINUTE_MS });
    return code;
  }

  /** The app trades its code and the secret it kept. Whose sign-in it was, once, or null. */
  redeem(code: string, verifier: string): string | null {
    this.forget();
    const found = this.returned.get(code);
    if (!found) return null;
    // Spent whether or not the secret matches: a code that was guessed at is no longer safe to honour.
    this.returned.delete(code);
    return sameText(challengeOf(verifier), found.challenge) ? found.personId : null;
  }

  private forget(): void {
    const now = this.now();
    for (const [state, waiting] of this.asked) if (waiting.until <= now) this.asked.delete(state);
    for (const [code, found] of this.returned) if (found.until <= now) this.returned.delete(code);
  }
}

/** The hash an app sends of the secret it keeps (PKCE's S256): SHA-256, in base64url. */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Whether an address is an app's own, where a sign-in may be sent back: a
 * port on this very computer (the desktop app listens on one for a moment)
 * or one of the app's own schemes (`ribbon://`, on a phone). Anywhere else
 * would hand a sign-in code to another website.
 */
export function isAppAddress(address: string, schemes: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol === "http:") return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return schemes.includes(url.protocol.slice(0, -1));
}

/** Where a device's sign-in stands, as the device hears it when it asks. */
export type DeviceAnswer = "waiting" | "gone" | { personId: string; device: string };

/**
 * Sign-ins for a device with no browser and a remote for a keyboard: a TV.
 *
 * The TV asks for a sign-in and shows the short code it's given. Someone
 * opens the server's page on their phone, signs in there however this
 * server signs people in, and the code they see or type says which TV they
 * meant. The TV, asking every few seconds with a secret only it holds,
 * then gets its session.
 *
 *     waiting ──someone signed in approves it──▶ approved ──the device asks──▶ taken
 *        │                                          │
 *        └────────────ten minutes pass──────────────┴──▶ gone
 */
export class DeviceSignIns {
  private readonly byCode = new Map<string, { secret: string; device: string; personId: string | null; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A device wants someone signed in. The code to show, the secret to ask with, and how long both are good for. */
  ask(device: string): { code: string; secret: string; expiresIn: number } {
    this.forget();
    let code = shortCode();
    while (this.byCode.has(code)) code = shortCode();
    const secret = randomBytes(32).toString("base64url");
    this.byCode.set(code, { secret, device, personId: null, until: this.now() + 10 * MINUTE_MS });
    return { code: shown(code), secret, expiresIn: 600 };
  }

  /** The device a code is showing on, while it still waits: what to ask the person about. */
  waiting(code: string): { device: string } | null {
    this.forget();
    const found = this.byCode.get(plain(code));
    return found && found.personId === null ? { device: found.device } : null;
  }

  /** Someone who is signed in says this code's device is theirs. False when the code isn't waiting. */
  approve(code: string, personId: string): boolean {
    this.forget();
    const found = this.byCode.get(plain(code));
    if (!found || found.personId !== null) return false;
    found.personId = personId;
    return true;
  }

  /** The device asks whether it's in yet. Once it is, it's told once. */
  answer(secret: string): DeviceAnswer {
    this.forget();
    for (const [code, found] of this.byCode) {
      if (!sameText(found.secret, secret)) continue;
      if (found.personId === null) return "waiting";
      this.byCode.delete(code);
      return { personId: found.personId, device: found.device };
    }
    return "gone";
  }

  private forget(): void {
    const now = this.now();
    for (const [code, found] of this.byCode) if (found.until <= now) this.byCode.delete(code);
  }
}

/** Letters that can't be mistaken for one another or for a digit when read off a TV, and that spell nothing. */
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

function shortCode(): string {
  return Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join("");
}

/** A code as it's shown: two groups of four. */
function shown(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A code as someone typed it, without the dash, spaces or lower case. */
function plain(code: string): string {
  return code.toUpperCase().replace(/[^A-Z]/g, "");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
