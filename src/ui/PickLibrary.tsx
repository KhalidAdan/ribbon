import { useAppState, useController } from "./store";
import { Button } from "./Button";

export function PickLibrary() {
  const c = useController();
  const state = useAppState();
  return (
    <main className="flex h-full items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-6 text-center">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-balance text-neutral-950 dark:text-white">The listener for books you own.</h1>
          <p className="mt-3 max-w-[45ch] text-base/7 text-pretty text-neutral-600 sm:text-sm/6 dark:text-neutral-400">Add a folder of audiobooks. Add more later; the books stay where they are, and Ribbon remembers where you are in every one, as a file beside the book.</p>
        </div>
        <Button variant="primary" onClick={() => void c.pickLibrary()}>
          Add a folder
        </Button>
        {state.error && <p className="text-sm/6 text-red-600 dark:text-red-400">{state.error}</p>}
      </div>
    </main>
  );
}
