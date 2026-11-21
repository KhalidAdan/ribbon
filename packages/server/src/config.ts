import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** How the server runs: where it keeps everything, where it listens, and the address people reach it by. */
export interface ServerConfig {
  /** The server's data folder: its database, the books, each person's places (docs/SERVER.md, section 5). */
  dataDir: string;
  /** Where it listens. This machine only by default: whatever the host puts in front (a proxy, Tailscale Serve, a tunnel) reaches it here. */
  host: string;
  port: number;
  /** The address people and apps use to reach it, as the host has set it up. Invite links are made from it. */
  url: string;
  /** A secret of the server's own, for the accounts it keeps. Made once and kept in the data folder, unless RIBBON_SECRET gives one. */
  secret: string;
  /**
   * How people prove who they are (auth.ts). Accounts the server keeps itself, a name and a password each, unless
   * RIBBON_SIGN_IN is `pocket-id`: then a Pocket ID instance beside it does (RIBBON_POCKET_ID_URL, and the client
   * registered there for this server: RIBBON_POCKET_ID_CLIENT_ID and RIBBON_POCKET_ID_CLIENT_SECRET).
   */
  signIn?: SignInSettings;
  /**
   * The usernames of this server's admins, when something outside it signs people in (RIBBON_ADMINS, separated by
   * commas). With its own accounts the first invite makes the admin, and this isn't read.
   */
  admins?: string[];
  /** Where Ribbon's apps sign in from, besides the server's own address. The desktop and phone apps' own origins unless given. */
  appOrigins?: string[];
  /** The `ribbon-ebook` command, which parses EPUBs as the apps do (packages/desktop/src-tauri/ebook), or null when there's none: no read-along. */
  ebookTool?: string | null;
  /** The `ribbon-frames` command, which finds a moment's frame in an MP3 as the app does (packages/desktop/src-tauri/frames), or null: MP3s go whole. */
  framesTool?: string | null;
  /**
   * Where descriptions come from for books with none of their own (library/describe.ts): Audible's catalog, in one of
   * its stores, when RIBBON_DESCRIPTIONS is `audible` (RIBBON_AUDIBLE_STORE: `us` unless given, or `uk`, `ca`, `au`,
   * `de`, …); null, the default, asks no one.
   */
  descriptions?: { store: string } | null;
  /**
   * The folders a folder picked on another computer is looked for under (library/folders.ts): the server's own
   * mount of the share the apps add folders from. RIBBON_FOLDERS, separated as this system separates paths (`:`,
   * or `;` on Windows). None by default: a folder is found only at the path it was picked at.
   */
  folders?: string[];
}

/** How people prove who they are: to the server itself, or to a Pocket ID instance it's a client of. */
export type SignInSettings = { with: "accounts" } | { with: "pocket-id"; url: string; clientId: string; clientSecret: string };

/** The origins Ribbon's apps run at: Tauri's on each system, and the browser harness in development. */
export const APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"];

/** The server's settings, from the environment, with the defaults a first run needs. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = path.resolve(env.RIBBON_DATA ?? "ribbon-data");
  mkdirSync(dataDir, { recursive: true });
  const port = Number(env.RIBBON_PORT ?? 7766);
  return {
    dataDir,
    host: env.RIBBON_HOST ?? "127.0.0.1",
    port,
    url: (env.RIBBON_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    secret: env.RIBBON_SECRET ?? keptSecret(dataDir),
    signIn: signInFrom(env),
    admins: (env.RIBBON_ADMINS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    appOrigins: env.RIBBON_APP_ORIGINS ? env.RIBBON_APP_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : APP_ORIGINS,
    ebookTool: env.RIBBON_EBOOK_TOOL ?? builtTool("ribbon-ebook"),
    framesTool: env.RIBBON_FRAMES_TOOL ?? builtTool("ribbon-frames"),
    descriptions: env.RIBBON_DESCRIPTIONS === "audible" ? { store: env.RIBBON_AUDIBLE_STORE || "us" } : null,
    folders: (env.RIBBON_FOLDERS ?? "").split(path.delimiter).filter(Boolean).map((folder) => path.resolve(folder)),
  };
}

/** How this server signs people in, as the environment says. A Pocket ID half set up stops the start, rather than leaving nobody able to sign in. */
function signInFrom(env: NodeJS.ProcessEnv): SignInSettings {
  const chosen = env.RIBBON_SIGN_IN ?? "accounts";
  if (chosen === "accounts") return { with: "accounts" };
  if (chosen !== "pocket-id") throw new Error(`RIBBON_SIGN_IN is "${chosen}": it can be "accounts" or "pocket-id".`);
  const url = env.RIBBON_POCKET_ID_URL;
  const clientId = env.RIBBON_POCKET_ID_CLIENT_ID;
  const clientSecret = env.RIBBON_POCKET_ID_CLIENT_SECRET;
  if (!url || !clientId || !clientSecret) throw new Error("Signing in with Pocket ID needs RIBBON_POCKET_ID_URL, RIBBON_POCKET_ID_CLIENT_ID and RIBBON_POCKET_ID_CLIENT_SECRET.");
  return { with: "pocket-id", url, clientId, clientSecret };
}

/**
 * One of Ribbon's commands (`ribbon-ebook`, `ribbon-frames`) as cargo builds
 * it in this repository (`cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml -p
 * <name>`), a release build before a debug one, or null when it isn't built.
 */
export function builtTool(name: string): string | null {
  const target = path.resolve(import.meta.dirname, "..", "..", "..", "target");
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return ["release", "debug"].map((profile) => path.join(target, profile, exe)).find((p) => existsSync(p)) ?? null;
}

/** A secret made on the first run and read back on every run after, readable only by the server's own user. */
function keptSecret(dataDir: string): string {
  const file = path.join(dataDir, "secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}
