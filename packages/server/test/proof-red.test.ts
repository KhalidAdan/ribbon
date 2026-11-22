import { expect, it } from "vitest";

// Deliberately red: proves main refuses a pull request whose check failed. Never merged.
it("fails on purpose", () => {
  expect(1).toBe(2);
});
