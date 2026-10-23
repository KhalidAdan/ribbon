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
  /** Signs sessions. Made once and kept in the data folder, unless RIBBON_SECRET gives one. */
  secret: string;
  /** Where Ribbon's apps sign in from, besides the server's own address. The desktop and phone apps' own origins unless given. */
  appOrigins?: string[];
  /** The `ribbon-ebook` command, which parses EPUBs as the apps do (src-tauri/ebook), or null when there's none: no read-along. */
  ebookTool?: string | null;
}

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
    appOrigins: env.RIBBON_APP_ORIGINS ? env.RIBBON_APP_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : APP_ORIGINS,
    ebookTool: env.RIBBON_EBOOK_TOOL ?? builtEbookTool(),
  };
}

/**
 * The `ribbon-ebook` command as cargo builds it in this repository
 * (`cargo build --manifest-path src-tauri/Cargo.toml -p ribbon-ebook`), a
 * release build before a debug one, or null when it isn't built.
 */
export function builtEbookTool(): string | null {
  const target = path.resolve(import.meta.dirname, "..", "..", "target");
  const exe = process.platform === "win32" ? "ribbon-ebook.exe" : "ribbon-ebook";
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
