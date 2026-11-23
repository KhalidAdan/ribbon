import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const tests = path.join(path.dirname(fileURLToPath(import.meta.url)), "test");

/**
 * The suites that open the generated fixture folder (tools/make-fixtures.ts).
 * They write their records into it, so they run one file at a time. Found by
 * what each file imports, not from a list, so a new suite that opens the
 * folder joins them without anyone remembering to add it.
 */
const sharingTheFixtures = fs
  .readdirSync(tests)
  .filter((file) => /\.test\.tsx?$/.test(file))
  .filter((file) => fs.readFileSync(path.join(tests, file), "utf8").includes("make-fixtures"))
  .map((file) => `test/${file}`);

export default defineConfig({
  test: {
    globalSetup: ["test/setup/fixtures.ts"],
    setupFiles: ["test/setup/quiet-after.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: {
          name: "sharing the fixtures",
          include: sharingTheFixtures,
          fileParallelism: false,
        },
      },
      {
        // Every other suite keeps its state to itself, so these run side by side.
        extends: true,
        test: {
          name: "on their own",
          include: ["test/**/*.test.{ts,tsx}"],
          exclude: sharingTheFixtures,
        },
      },
    ],
  },
});
