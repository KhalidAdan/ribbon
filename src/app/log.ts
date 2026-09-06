/**
 * One logger for the web side. Always writes to the console; inside
 * Tauri it also forwards to the Rust logger, which writes the terminal
 * and the log file, so one file tells the whole story.
 */

type Level = "info" | "warn" | "error";

let forward: ((level: Level, message: string) => void) | null = null;

function render(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export const log = {
  info(...args: unknown[]): void {
    console.info("odio:", ...args);
    forward?.("info", render(args));
  },
  warn(...args: unknown[]): void {
    console.warn("odio:", ...args);
    forward?.("warn", render(args));
  },
  error(...args: unknown[]): void {
    console.error("odio:", ...args);
    forward?.("error", render(args));
  },
};

/** Call once inside Tauri. Safe to skip elsewhere. */
export async function attachTauriLog(): Promise<void> {
  try {
    const m = await import("@tauri-apps/plugin-log");
    forward = (level, message) => {
      const fn = level === "info" ? m.info : level === "warn" ? m.warn : m.error;
      void fn(message).catch(() => undefined);
    };
    window.addEventListener("error", (e) => log.error("uncaught", e.message, e.filename, e.lineno));
    window.addEventListener("unhandledrejection", (e) => log.error("unhandled rejection", e.reason));
  } catch {
    /* not in Tauri, or the plugin is missing */
  }
}
