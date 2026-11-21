/**
 * Who a provider says someone is. A provider proves that and nothing more:
 * what the person may do, and what is theirs, is the app's own business,
 * which it keeps against `provider` and `subject` together.
 *
 * Only `provider`, `subject`, `username` and `displayName` are always
 * there. A provider with no pictures or email addresses leaves them out.
 */
export interface Identity {
  /** Which provider said so: "accounts", "pocket-id". */
  provider: string;
  /** The provider's own id for them. It never changes and is never shown, so it is the one thing to key on. */
  subject: string;
  /** What they sign in as. They may change it, so it is never a key. */
  username: string;
  /** What to call them: the name they chose to show, or their username when there's nothing better. */
  displayName: string;
  /** Where their picture is, when the provider keeps one. */
  picture?: string;
  email?: string;
  emailVerified?: boolean;
  /** The provider's groups they are in, by name. Empty when it has none. */
  groups: string[];
  /**
   * Everything else the provider said, as it said it: a first and last
   * name, when and how they proved who they are (`auth_time`, `amr`),
   * claims an admin added. Kept for an app that wants one of them; nothing
   * here reads it.
   */
  claims: Record<string, unknown>;
}

/** A provider that takes a name and a password itself: the app shows a form. */
export interface PasswordProvider {
  kind: "password";
  id: string;
  /** Who this name and password belong to, or null when they don't match anyone. */
  check(name: string, password: string): Promise<Identity | null>;
}

/**
 * A provider people sign in to in a browser, on its own pages: the app
 * sends them there and they come back to `callbackUrl` with proof.
 *
 * `begin` hands back whatever it needs to remember until they return (a
 * secret it made, say) as `memo`, for the caller to keep beside `state` and
 * give to `finish`. The provider itself keeps nothing between the two.
 */
export interface BrowserProvider {
  kind: "browser";
  id: string;
  /** What to call it on a button: "Pocket ID". */
  name: string;
  /** Where to send the browser. `state` comes back with it, so the caller knows whose sign-in returned. */
  begin(state: string, callbackUrl: string): Promise<{ url: URL; memo: string }>;
  /** Who came back, from what the provider's redirect carried in its query. Throws `SignInRefused` when it wasn't a sign-in. */
  finish(query: Record<string, string>, callbackUrl: string, memo: string): Promise<Identity>;
}

/** One way of proving who someone is. A server runs exactly one. */
export type IdentityProvider = PasswordProvider | BrowserProvider;

/** A sign-in that didn't happen, in words to show the person: they said no, too many wrong tries, the provider is down. */
export class SignInRefused extends Error {
  constructor(
    message: string,
    /** The HTTP status that fits, for a server that answers with one. */
    readonly status = 401,
  ) {
    super(message);
    this.name = "SignInRefused";
  }
}
