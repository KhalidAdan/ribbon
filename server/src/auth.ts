import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, bearer, username } from "better-auth/plugins";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config.ts";

/** A device stays signed in for a year, and every day it's used pushes that out again: a phone that's opened shouldn't ask for a password. */
const SESSION_DAYS = 365;

/**
 * Accounts, with Better Auth (docs/SERVER.md, section 6), in the server's
 * own database:
 *
 * - username: people sign in with a name and a password;
 * - admin: roles, and the admin's list of people and their sessions;
 * - bearer: the desktop and phone apps send their session as a token in a
 *   header rather than a cookie.
 *
 * Better Auth's own sign-up route is closed to the outside: the server
 * signs people up itself, from an invite (invites.ts, app.ts).
 *
 * The options are made apart from the instance so the database can be
 * brought up to date with them before Better Auth looks at it.
 */
export function authOptions(db: DatabaseSync, config: ServerConfig) {
  return {
    database: db,
    baseURL: config.url,
    basePath: "/api/auth",
    secret: config.secret,
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    session: { expiresIn: SESSION_DAYS * 86_400, updateAge: 86_400 },
    plugins: [username(), admin(), bearer()],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // A request from outside has a request; the server's own sign-up, from an invite, does not.
        if (ctx.path === "/sign-up/email" && ctx.request) {
          throw new APIError("FORBIDDEN", { message: "Ribbon accounts are by invite. Ask the server's admin for a link." });
        }
      }),
    },
  } satisfies BetterAuthOptions;
}

export function makeAuth(options: ReturnType<typeof authOptions>) {
  return betterAuth(options);
}

export type Auth = ReturnType<typeof makeAuth>;

/**
 * Better Auth keeps an email for every account; Ribbon's people have only
 * a name. This one is never sent anything: `.invalid` is reserved for
 * addresses that can't exist.
 */
export function placeholderEmail(name: string): string {
  return `${name.toLowerCase()}@people.ribbon.invalid`;
}
