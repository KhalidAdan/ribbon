import { ArrowDownTrayIcon, TrashIcon } from "@heroicons/react/16/solid";
import { useState, type FormEvent } from "react";
import { useAppState, useController } from "./store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { useKept } from "./modal";
import { ProgressLine } from "./kit";

const control = "w-full rounded-md bg-raised px-2.5 py-1.5 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6";
const label = "mb-1 block text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5";

/**
 * Sign in to a Ribbon server (docs/SERVER.md, section 11). The server's
 * books join the shelf; each downloads before it plays. The password is
 * sent once, for a sign-in this device keeps.
 */
export function ConnectServer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const c = useController();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = address.trim() !== "" && name.trim() !== "" && password !== "";

  const close = () => {
    setPassword("");
    setError(null);
    onClose();
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await c.connectServer(address, name, password);
      setPassword("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      labelId="connect-server-title"
      title="Connect to a server"
      description="A Ribbon server someone runs for you. Its books join your shelf, and each one downloads before it plays, so it works away from home too."
      hint={busy ? "Signing in…" : undefined}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4 px-5 pt-4 pb-5" onSubmit={(e) => void submit(e)}>
        <div>
          <label htmlFor="server-address" className={label}>
            Address
          </label>
          <input id="server-address" name="address" type="text" inputMode="url" autoComplete="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="books.example.net" value={address} onChange={(e) => setAddress(e.target.value)} className={control} />
          <p className="mt-1 text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5">The one in your invite, without the /invite part.</p>
        </div>
        <div>
          <label htmlFor="server-name" className={label}>
            Name
          </label>
          <input id="server-name" name="username" type="text" autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} className={control} />
        </div>
        <div>
          <label htmlFor="server-password" className={label}>
            Password
          </label>
          <input id="server-password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={control} />
        </div>
        {error && (
          <p role="alert" className="text-sm/5 text-pretty text-red-600 dark:text-red-400 sm:text-[0.8125rem]/5">
            {error}
          </p>
        )}
        {/* Enter in any field signs in. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true" />
      </form>
    </Dialog>
  );
}

/** The books downloading from a server now, one line each with how far along. */
export function Downloads() {
  const { downloads, books } = useAppState((s) => ({ downloads: s.downloads, books: s.books }));
  const items = Object.entries(downloads).map(([id, d]) => ({ id, ...d, title: books.find((b) => b.book.id === id)?.book.title ?? "A book" }));
  if (items.length === 0) return null;
  return (
    <div role="status" className="flex flex-col gap-3 rounded-[10px] bg-surface p-4 ring-1 ring-line">
      {items.map((d) => (
        <div key={d.id} className="min-w-0">
          <p className="flex items-baseline justify-between gap-3 text-base/6 text-ink sm:text-sm/5">
            <span className="truncate font-medium">Downloading {d.title}</span>
            <span className="shrink-0 text-ink-3 tabular-nums">{d.total > 0 ? `${formatBytes(d.done)} of ${formatBytes(d.total)}` : formatBytes(d.done)}</span>
          </p>
          <ProgressLine fraction={d.total > 0 ? d.done / d.total : 0} className="mt-2" />
        </div>
      ))}
    </div>
  );
}

/**
 * A server's book that won't fit: how much more room it needs, and the
 * books downloaded before, biggest first, to remove from this device.
 * The server keeps them, and the place in each.
 */
export function SpaceShort() {
  const c = useController();
  const live = useAppState((s) => s.spaceShort);
  // Redrawn when the shelf changes, as a removal does.
  useAppState((s) => s.books);
  const [freed, setFreed] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  // Kept while it leaves; what was freed is forgotten once it's gone, so its title doesn't change on the way out.
  const [short, closed] = useKept(live);
  if (!short) return null;
  const downloaded = c.downloadedBooks();
  const stillNeeded = Math.max(0, short.neededBytes - short.freeBytes - freed);
  const close = () => c.dismissSpaceShort();

  return (
    <Dialog
      open={live !== null}
      onClose={close}
      onClosed={() => {
        setFreed(0);
        closed();
      }}
      labelId="space-short-title"
      title={stillNeeded > 0 ? `Not enough room for ${short.title}` : `Room for ${short.title}`}
      description={stillNeeded > 0 ? `It needs ${formatBytes(stillNeeded)} more than this device can spare. Remove books you’ve downloaded to make room: the server keeps them, and your place in each.` : "There’s room for it now."}
      hint={`${formatBytes(short.freeBytes + freed)} free`}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Not now
          </Button>
          <Button
            variant="primary"
            leading={ArrowDownTrayIcon}
            disabled={stillNeeded > 0}
            onClick={() => {
              const id = short.bookId;
              c.dismissSpaceShort();
              void c.downloadBook(id);
            }}
          >
            Download it
          </Button>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto quiet-scroll px-5 pt-4 pb-5">
        {downloaded.length === 0 ? (
          stillNeeded > 0 &&
          <p className="text-base/6 text-pretty text-ink-2 sm:text-sm/6">No books from a server are on this device yet. Free some space another way, then try again.</p>
        ) : (
          <ul role="list" className="flex flex-col divide-y divide-line rounded-[10px] ring-1 ring-line">
            {downloaded.map((b) => (
              <li key={b.book.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base/6 font-medium text-ink sm:text-sm/5">{b.book.title}</p>
                  <p className="truncate text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">
                    {formatBytes(b.book.sizeBytes)}
                    {b.book.author ? ` · ${b.book.author}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  leading={TrashIcon}
                  disabled={removing !== null}
                  onClick={() => {
                    setRemoving(b.book.id);
                    void c
                      .removeDownload(b.book.id)
                      .then(() => setFreed((f) => f + b.book.sizeBytes))
                      .finally(() => setRemoving(null));
                  }}
                >
                  {removing === b.book.id ? "Removing…" : "Remove"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** A size as people say it: 812 MB, 1.4 GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
