import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { SignInRefused, type BrowserProvider, type Identity } from "@ribbon/auth/identity";

/** This provider's name, as identities carry it. */
export const POCKET_ID = "pocket-id";

/** A Pocket ID instance, and this app as a client registered on it (Administration → OIDC Clients). */
export interface PocketIdSettings {
  /** The instance's address: `https://id.example.com`. */
  url: string;
  clientId: string;
  /** The client's secret. This app runs on a server, which can keep one. */
  clientSecret: string;
}

/**
 * Signing in with [Pocket ID](https://pocket-id.org): people prove who they
 * are with a passkey on the instance's own pages, and come back with a
 * signed statement of who they are.
 *
 * It is OpenID Connect's authorization code flow, as a client with a
 * secret, with PKCE besides: the browser is sent to the instance, returns
 * with a code, the code is traded for an ID token over a request of our
 * own, and the token's signature, issuer, audience, age and nonce are
 * checked before a word of it is believed.
 *
 * The instance must list `callbackUrl` among the client's callback URLs.
 */
export function pocketId(settings: PocketIdSettings): BrowserProvider {
  const issuer = settings.url.replace(/\/+$/, "");
  let found: Promise<Discovered> | null = null;
  // Asked for once and kept; asked again after a failure, so an instance that was down at start isn't down for good.
  const discovered = (): Promise<Discovered> => (found ??= discover(issuer).catch((e) => ((found = null), Promise.reject(e))));

  return {
    kind: "browser",
    id: POCKET_ID,
    name: "Pocket ID",

    async begin(state, callbackUrl) {
      const { authorization_endpoint } = await discovered();
      const verifier = randomBytes(32).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      const url = new URL(authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: settings.clientId,
        redirect_uri: callbackUrl,
        scope: "openid profile email groups",
        state,
        nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return { url, memo: JSON.stringify({ verifier, nonce }) };
    },

    async finish(query, callbackUrl, memo) {
      if (query.error) throw new SignInRefused(query.error === "access_denied" ? "The sign-in was cancelled, or this account isn't allowed in here." : `Pocket ID said: ${query.error_description ?? query.error}`, 403);
      if (!query.code) throw new SignInRefused("Pocket ID sent no sign-in back. Try again.", 400);
      // Pocket ID says who is answering; an answer that names another issuer was meant for someone else.
      if (query.iss && query.iss !== issuer) throw new SignInRefused("That sign-in came from somewhere other than this server's Pocket ID.", 400);
      const { verifier, nonce } = JSON.parse(memo) as { verifier: string; nonce: string };
      const { token_endpoint, keys } = await discovered();

      const answer = await fetch(token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: callbackUrl, client_id: settings.clientId, client_secret: settings.clientSecret, code_verifier: verifier }),
      }).catch(() => null);
      if (!answer) throw new SignInRefused("Pocket ID couldn't be reached. Try again in a moment.", 502);
      const tokens = (await answer.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
      if (!answer.ok || !tokens.id_token) throw new SignInRefused(`Pocket ID wouldn't finish the sign-in${tokens.error ? `: ${tokens.error_description ?? tokens.error}` : "."}`, 502);

      let claims: JWTPayload;
      try {
        claims = (await jwtVerify(tokens.id_token, keys, { issuer, audience: settings.clientId })).payload;
      } catch {
        throw new SignInRefused("Pocket ID's answer didn't check out. Try again.", 502);
      }
      if (claims.nonce !== nonce) throw new SignInRefused("That sign-in wasn't the one this server started. Try again.", 400);
      return identityFrom(claims);
    },
  };
}

/**
 * Who Pocket ID's claims say someone is.
 *
 * `sub` is their id on the instance, which never changes. The name to show
 * is the display name they set, else their first and last name (`name`,
 * which Pocket ID itself falls back from), else their username. Their
 * picture is an address on the instance that anyone may load; there is
 * always one, the instance's default when they've uploaded none.
 *
 * `auth_time` and `amr` (how they proved it: `phr` for a passkey, `otp` for
 * a one-time code) stay in `claims` with everything else not named here.
 */
export function identityFrom(claims: Record<string, unknown>): Identity {
  const text = (name: string): string | undefined => (typeof claims[name] === "string" && claims[name] ? (claims[name] as string) : undefined);
  const subject = text("sub");
  if (!subject) throw new SignInRefused("Pocket ID's answer didn't say who signed in.", 502);
  const username = text("preferred_username") ?? subject;
  const email = text("email");
  const picture = text("picture");
  const groups = Array.isArray(claims.groups) ? claims.groups.filter((group): group is string => typeof group === "string") : [];
  const rest = Object.fromEntries(Object.entries(claims).filter(([name]) => !NAMED.has(name)));
  return {
    provider: POCKET_ID,
    subject,
    username,
    displayName: text("display_name") ?? text("name") ?? username,
    ...(picture ? { picture } : {}),
    ...(email ? { email, emailVerified: claims.email_verified === true } : {}),
    groups,
    claims: rest,
  };
}

/** The claims an `Identity` has fields for, and the ones that are about the token rather than the person. */
const NAMED = new Set(["sub", "preferred_username", "display_name", "name", "picture", "email", "email_verified", "groups", "iss", "aud", "exp", "iat", "nbf", "jti", "nonce", "at_hash", "c_hash", "azp", "sid"]);

/** What an instance says about itself at its well-known address, and its signing keys, fetched as they're needed. */
interface Discovered {
  authorization_endpoint: string;
  token_endpoint: string;
  keys: ReturnType<typeof createRemoteJWKSet>;
}

async function discover(issuer: string): Promise<Discovered> {
  const answer = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { accept: "application/json" } }).catch(() => null);
  if (!answer?.ok) throw new SignInRefused("Pocket ID couldn't be reached. Try again in a moment.", 502);
  const said = (await answer.json()) as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string };
  if (said.issuer !== issuer || !said.authorization_endpoint || !said.token_endpoint || !said.jwks_uri) {
    throw new SignInRefused(`There's no Pocket ID at ${issuer}: check the address this server was given.`, 502);
  }
  return { authorization_endpoint: said.authorization_endpoint, token_endpoint: said.token_endpoint, keys: createRemoteJWKSet(new URL(said.jwks_uri)) };
}
