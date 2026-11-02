import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The server runs its own tests, in packages/server.
    include: ["test/**/*.test.{ts,tsx}", "packages/core/test/**/*.test.{ts,tsx}"],
    // The scan and library suites share one generated fixture folder.
    fileParallelism: false,
    globalSetup: ["test/setup/fixtures.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
