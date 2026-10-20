import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync } from "node:fs";
import { devLibrary } from "./tools/vite-dev-library";

const host = process.env.TAURI_DEV_HOST;
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

// The development library comes from the environment, from a
// `.env.<mode>.local` file (so a `--mode` picks a folder), or the sample.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), devLibrary(process.env.RIBBON_DEV_LIBRARY ?? loadEnv(mode, process.cwd(), "RIBBON_").RIBBON_DEV_LIBRARY ?? (existsSync("books") ? "books" : undefined))],
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: "ws", host, port: 1421 } } : {}),
    watch: { ignored: ["**/src-tauri/**", "**/books/**", "**/test/fixtures/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // RIBBON_PROFILE=1 builds with React's profiling build, so <Profiler> reports renders (app/perf.ts) in a release build too.
  ...(process.env.RIBBON_PROFILE ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] } } : {}),
  build: {
    target: "chrome120",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
