/**
 * Runs a command (the Tauri CLI, cargo) with what this machine's compiler
 * needs to build whisper.cpp, the speech side (src-tauri, through
 * whisper-rs). `npm run tauri`, `npm run tauri:dev` and `npm run test:rust`
 * go through it; a bare `cargo build` does not, and on Windows builds a
 * whisper.cpp too slow to use.
 *
 *   node tools/with-build-env.mjs tauri build
 *
 * On Windows, whisper-rs-sys passes GGML_* and CMAKE_* variables to cmake.
 * Without these, MSVC builds whisper.cpp with no optimisation and no vector
 * instructions, and a few seconds of speech take over a minute. AVX2 and
 * FMA need a 2013-or-newer x86-64 CPU. bindgen needs libclang, from LLVM.
 *
 * On macOS nothing is needed: Xcode's clang optimises as it should, its
 * libclang serves bindgen, and whisper.cpp runs on Metal (Cargo.toml).
 *
 * Anything already set in the environment wins over these.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function buildEnv() {
  if (process.platform !== "win32") return {};
  const llvm = "C:/Program Files/LLVM/bin";
  return {
    GGML_NATIVE: "OFF",
    GGML_AVX: "ON",
    GGML_AVX2: "ON",
    GGML_FMA: "ON",
    GGML_F16C: "ON",
    CMAKE_C_FLAGS_RELEASE: "/O2 /Ob2 /DNDEBUG /MD",
    CMAKE_CXX_FLAGS_RELEASE: "/O2 /Ob2 /DNDEBUG /MD",
    ...(existsSync(llvm) ? { LIBCLANG_PATH: llvm } : {}),
  };
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node tools/with-build-env.mjs <command> [args…]");
  process.exit(2);
}
const quoted = [command, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
const run = spawnSync(quoted, { stdio: "inherit", shell: true, env: { ...buildEnv(), ...process.env } });
process.exit(run.status ?? 1);
