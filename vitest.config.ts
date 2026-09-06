import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The scan and library suites share one generated fixture folder.
    fileParallelism: false,
    globalSetup: ["test/setup/fixtures.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
