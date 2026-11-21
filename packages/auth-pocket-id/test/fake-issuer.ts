import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

/**
 * A stand-in for a Pocket ID instance, for tests: it answers at the same
 * addresses with the same shapes (discovery, keys, `/authorize`, the token
 * endpoint), and signs whoever `person` is at the moment straight in, with
 * no page and no passkey. It checks what a real one checks of its client:
 * the secret, the callback address, and the PKCE secret behind the code.
 */
export interface FakeIssuer {
  url: string;
  clientId: string;
  clientSecret: string;
  /** Who signs in next: the claims of their ID token. Change it between sign-ins. */
  person: Record<string, unknown>;
  /** Set to an OAuth error (`access_denied`) to have the next sign-in refused instead. */
  refuses: string | null;
  /** Set to sign the next token with a key the issuer never published: a forgery. */
  forges: boolean;
  close(): Promise<void>;
}

export async function fakeIssuer(): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "fake-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, { claims: Record<string, unknown>; nonce: string; challenge: string; redirect: string }>();

  const issuer: FakeIssuer = {
    url: "",
    clientId: "ribbon-client",
    clientSecret: "the client's secret",
    person: { sub: "3f0c9a2e-7d41-4a0b-9c55-1b2e8d6f4a10", preferred_username: "ann", name: "Ann Example", display_name: "Ann", email: "ann@example.com", email_verified: true, groups: ["family"] },
    refuses: null,
    forges: false,
    close: () => new Promise((done) => server.close(() => done())),
  };

  const server = createServer(async (request, response) => {
    const at = new URL(request.url ?? "/", issuer.url);
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (at.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer: issuer.url, authorization_endpoint: `${issuer.url}/authorize`, token_endpoint: `${issuer.url}/api/oidc/token`, jwks_uri: `${issuer.url}/.well-known/jwks.json` });
    }
    if (at.pathname === "/.well-known/jwks.json") return json(200, { keys: [jwk] });

    if (at.pathname === "/authorize") {
      const asked = at.searchParams;
      if (asked.get("client_id") !== issuer.clientId || asked.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_request" });
      const back = new URL(asked.get("redirect_uri") ?? "");
      back.searchParams.set("state", asked.get("state") ?? "");
      back.searchParams.set("iss", issuer.url);
      if (issuer.refuses) {
        back.searchParams.set("error", issuer.refuses);
      } else {
        const code = randomBytes(12).toString("base64url");
        codes.set(code, { claims: { ...issuer.person }, nonce: asked.get("nonce") ?? "", challenge: asked.get("code_challenge") ?? "", redirect: asked.get("redirect_uri") ?? "" });
        back.searchParams.set("code", code);
      }
      return response.writeHead(302, { location: back.toString() }).end();
    }

    if (at.pathname === "/api/oidc/token" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const sent = new URLSearchParams(body);
      const code = codes.get(sent.get("code") ?? "");
      codes.delete(sent.get("code") ?? "");
      const verified = createHash("sha256").update(sent.get("code_verifier") ?? "").digest("base64url");
      if (sent.get("client_secret") !== issuer.clientSecret) return json(401, { error: "invalid_client" });
      if (!code || code.redirect !== sent.get("redirect_uri") || code.challenge !== verified) return json(400, { error: "invalid_grant" });
      const idToken = await new SignJWT({ ...code.claims, nonce: code.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "fake-key" })
        .setIssuer(issuer.url)
        .setAudience(issuer.clientId)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(issuer.forges ? stranger.privateKey : privateKey);
      return json(200, { id_token: idToken, access_token: "an access token", token_type: "Bearer" });
    }
    return json(404, { error: "not_found" });
  });

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  issuer.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return issuer;
}

/** Go to the issuer's sign-in page as a browser would, and come back: the query its redirect carried to the callback. */
export async function signInAt(authorizeUrl: URL | string): Promise<{ callback: URL; query: Record<string, string> }> {
  const answer = await fetch(authorizeUrl, { redirect: "manual" });
  const callback = new URL(answer.headers.get("location") ?? "");
  return { callback, query: Object.fromEntries(callback.searchParams) };
}
