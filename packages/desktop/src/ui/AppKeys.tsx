import { useEffect, useState } from "react";
import { appKeyGroups } from "@ribbon/core/keys";
import { KeyList } from "./KeyList";
import { Kbd } from "./kit";
import { useController } from "./store";

/** The event that asks for the list of keys, from anywhere on the page (Settings has a row that does). */
const ASKED = "ribbon:keys";

/** Show the list of keys. */
export function showKeys(): void {
  window.dispatchEvent(new Event(ASKED));
}

/**
 * Ribbon's keys, listed: `?` anywhere but in a comic, whose reader answers
 * `?` with its own list, and "Keys…" under Settings. What the list says is in
 * core/keys.ts.
 */
export function AppKeys() {
  const c = useController();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (c.getState().comic || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setOpen(true);
    };
    const onAsked = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(ASKED, onAsked);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(ASKED, onAsked);
    };
  }, [c]);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <KeyList
      open={open}
      onClose={() => setOpen(false)}
      id="app-keys"
      description="Everything Ribbon does from the keyboard."
      hint={
        <span className="inline-flex items-center gap-1.5">
          Press <Kbd>?</Kbd> to see them again.
        </span>
      }
      groups={appKeyGroups(mac)}
    />
  );
}
