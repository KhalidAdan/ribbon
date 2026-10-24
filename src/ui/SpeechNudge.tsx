import { useAppState, useController } from "./store";
import { Button } from "./Button";

/**
 * Said once per computer, the first time a book with both its text and its
 * audio opens there without a speech model: what one does, and the
 * download, the same one Settings offers. It rises in as the error notice
 * in its place does.
 */
export function SpeechNudge() {
  const c = useController();
  const { show, error } = useAppState((s) => ({ show: s.speechNudge, error: s.error !== null }));
  // An error says its piece in the same place first.
  if (!show || error) return null;
  return (
    <div role="status" className="fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-lg flex-col gap-3 rounded-[10px] bg-surface p-3 pl-4 shadow-lg ring-1 ring-line transition-[translate,opacity] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-y-4 sm:flex-row sm:items-center dark:shadow-none dark:ring-line-strong">
      <div className="min-w-0 flex-1">
        <p className="text-base/6 font-medium text-ink sm:text-sm/5">Read along sentence by sentence</p>
        <p className="mt-0.5 text-base/6 text-pretty text-ink-2 sm:text-sm/5">With a speech model, Ribbon matches the narration to the text on {c.here}, sentence by sentence; without one, only chapter by chapter. About 57 MB, downloaded once. Nothing is sent anywhere.</p>
      </div>
      <div className="flex shrink-0 gap-1 self-end sm:self-center">
        <Button size="sm" variant="ghost" onClick={() => c.dismissSpeechNudge()}>
          Not now
        </Button>
        <Button size="sm" variant="primary" onClick={() => void c.downloadSpeechModelFromNudge()}>
          Download
        </Button>
      </div>
    </div>
  );
}
