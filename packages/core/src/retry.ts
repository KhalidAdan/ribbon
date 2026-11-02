/**
 * Windows refuses to rename over a file that someone has open, even for
 * a moment (a reader, an antivirus scan, a sync client): EPERM, EBUSY or
 * EACCES. It clears within milliseconds, so an atomic write tries the
 * rename again a few times before it gives up.
 */
export async function renameWithRetry(rename: () => Promise<void>, tries = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename();
      return;
    } catch (e) {
      const text = String((e as { code?: string })?.code ?? e);
      if (i >= tries - 1 || !/EPERM|EBUSY|EACCES|denied|being used|os error (5|32)/i.test(text)) throw e;
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
}
