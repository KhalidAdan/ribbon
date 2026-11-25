/**
 * Whether a key pressed is the comic reader's to act on: not with a
 * modifier (those are the app's and the system's), not one already taken,
 * not typed into a field (the page slider has the arrows while it has the
 * focus), and not pressed in a dialog over the pages, such as "Go to page".
 */
export function readerKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return true;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLElement).isContentEditable) return false;
  return !target.closest("dialog");
}
