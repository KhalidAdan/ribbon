import { BookmarkIcon, FolderPlusIcon } from "@heroicons/react/16/solid";
import { useState } from "react";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { ConnectServer } from "./Servers";

/** The first screen: what Ribbon is in one sentence, and the one thing to do. */
export function PickLibrary() {
  const c = useController();
  const error = useAppState((s) => s.error);
  const [connecting, setConnecting] = useState(false);
  return (
    <main className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1.5 px-4 sm:px-5">
        <BookmarkIcon className="size-4 fill-place" aria-hidden="true" />
        <p className="text-sm/5 font-semibold text-ink">Ribbon</p>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-24">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold text-balance text-ink">A home for your books, read or heard.</h1>
          <p className="mt-2 text-base/6 text-pretty text-ink-2 sm:text-sm/6">Add a folder of your books: audiobooks, EPUBs, or both side by side. The books stay where they are; Ribbon remembers your place in every one, as a small file beside the book.</p>
          <div className="mt-6 rounded-[10px] bg-surface p-1 ring-1 ring-line">
            <div className="flex items-center gap-3 rounded-md bg-raised p-3">
              <div className="min-w-0 flex-1">
                <p className="text-base/6 font-medium text-ink sm:text-sm/5">A folder of books</p>
                <p className="text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">M4B, MP3, M4A, Opus, FLAC. A share on the network works too.</p>
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">You can add more folders later.</p>
            <Button variant="primary" leading={FolderPlusIcon} onClick={() => void c.pickLibrary()}>
              Add a folder
            </Button>
          </div>
          <p className="mt-6 border-t border-line pt-4 text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">
            Someone runs a Ribbon server for you?{" "}
            <button type="button" onClick={() => setConnecting(true)} className="rounded-sm font-medium text-ink underline decoration-line-strong underline-offset-2 focus-ring hover:decoration-ink">
              Connect to it
            </button>
          </p>
          <ConnectServer open={connecting} onClose={() => setConnecting(false)} />
          {error && <p className="mt-4 text-sm/5 text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </div>
    </main>
  );
}
