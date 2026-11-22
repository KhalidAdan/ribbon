import { afterAll } from "vitest";

/**
 * Once a file's tests have ended, nothing it left running may log.
 *
 * Many suites make an `AppController` and end while its background work (a
 * rescan, chapter probes) is still going. Vitest sends each console line to
 * its main process, and fails the whole run if it closes a file's worker
 * with a line still on its way: "Closing rpc while onUserConsoleLog was
 * pending", with every test passed (#224). A line written after the last
 * test is nobody's to read, so the console goes quiet here. Each file has a
 * console of its own, so there's nothing to put back.
 */
afterAll(() => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = () => undefined;
});
