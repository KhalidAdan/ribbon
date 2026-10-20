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
  // RIBBON_PROFILE=1 is the measurement build (tools/e2e): it also puts the controller on the page for the suite.
  define: { __APP_VERSION__: JSON.stringify(version), __RIBBON_MEASURE__: JSON.stringify(!!process.env.RIBBON_PROFILE) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: "ws", host, port: 1421 } } : {}),
    watch: { ignored: ["**/src-tauri/**", "**/books/**", "**/test/fixtures/**", "**/.e2e/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // RIBBON_PROFILE=1 builds with React's profiling build, so <Profiler> reports renders (app/perf.ts) in a release build too.
  ...(process.env.RIBBON_PROFILE ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] } } : {}),
  // The layout worker (src/reader/layout.worker.ts) loads hyphenation patterns on demand: a module worker splits like the page.
  worker: { format: "es" },
  build: {
    target: "chrome120",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
