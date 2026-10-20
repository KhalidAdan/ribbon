import { PencilSquareIcon, TrashIcon } from "@heroicons/react/16/solid";
import { useMemo, useState } from "react";
import type { ScannedBook } from "../core/scan/scan";
import type { ReadRecord } from "../core/poslog";
import { bookIdOf, formatSpan, readsOf } from "../core/stats";
import { useAppState, useController } from "./store";
import { Button, IconButton } from "./Button";
import { SectionHeader } from "./kit";

/** "1 Sep 2026" */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** The local date of an ISO time, for a date input. */
function dateValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date input's value as an ISO time at local noon, so no time zone moves it to another day. */
function fromDateValue(v: string): string {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 12).toISOString();
}

/**
 * Every time you have listened to this book, from the start to the end
 * or to now, with the time spent. Dates can be corrected; a listen-through
 * can be deleted.
 */
export function ReadHistory({ book }: { book: ScannedBook }) {
  const history = useAppState((s) => s.history);
  const reads = readsOf(history.reads, book.book.id);
  const listened = useMemo(() => history.sessions.filter((s) => bookIdOf(s) === book.book.id).reduce((t, s) => t + s.listened_ms, 0), [history.sessions, book.book.id]);
  if (reads.length === 0 && listened === 0) return null;
  return (
    <section aria-labelledby="history-title" className="mt-10 flex flex-col gap-3">
      <SectionHeader
        id="history-title"
        title="Your history with it"
        description={listened > 0 ? `${formatSpan(listened)} listened${reads.length > 1 ? `, over ${reads.length} listen-throughs` : ""}.` : undefined}
      />
      <ol role="list" className="flex flex-col border-t border-line">
        {reads
          .slice()
          .reverse()
          .map((r, i) => (
            <ReadRow key={r.id} book={book} read={r} number={reads.length - i} />
          ))}
      </ol>
    </section>
  );
}

function ReadRow({ book, read, number }: { book: ScannedBook; read: ReadRecord; number: number }) {
  const c = useController();
  const [editing, setEditing] = useState(false);
  const [started, setStarted] = useState(dateValue(read.started));
  const [finished, setFinished] = useState(read.finished ? dateValue(read.finished) : "");
  const days = read.finished ? Math.max(1, Math.round((Date.parse(read.finished) - Date.parse(read.started)) / 86_400_000)) : null;
  if (editing) {
    return (
      <li className="border-b border-line py-3">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void c.editRead(book.book.id, read.id, fromDateValue(started), finished ? fromDateValue(finished) : null).then(() => setEditing(false));
          }}
        >
          <div>
            <label htmlFor={`read-start-${read.id}`} className="mb-1 block text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">
              Started
            </label>
            <input id={`read-start-${read.id}`} name="started" type="date" required value={started} onChange={(e) => setStarted(e.target.value)} className="rounded-md bg-raised px-2.5 py-1 text-base/6 text-ink ring-1 ring-line focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:text-sm/6" />
          </div>
          <div>
            <label htmlFor={`read-end-${read.id}`} className="mb-1 block text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">
              Finished
            </label>
            <input id={`read-end-${read.id}`} name="finished" type="date" min={started} value={finished} onChange={(e) => setFinished(e.target.value)} className="rounded-md bg-raised px-2.5 py-1 text-base/6 text-ink ring-1 ring-line focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:text-sm/6" />
          </div>
          <div className="flex gap-1">
            <Button type="submit" size="sm">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          <p className="basis-full text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">Leave the finish empty if you are still listening.</p>
        </form>
      </li>
    );
  }
  return (
    <li className="group/row flex items-center gap-3 border-b border-line py-2.5">
      <span className="w-6 shrink-0 text-right text-sm/5 text-ink-3 tabular-nums sm:text-[0.8125rem]/5">{number}</span>
      <p className="min-w-0 flex-1 text-base/6 text-ink tabular-nums sm:text-sm/5">
        {day(read.started)}
        <span className="text-ink-3"> to </span>
        {read.finished ? day(read.finished) : <span className="text-ink-2">now</span>}
        {days !== null && <span className="text-ink-3"> · {days === 1 ? "a day" : `${days} days`}</span>}
      </p>
      <div className="flex shrink-0 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100">
        <IconButton size="sm" label="Correct the dates" icon={PencilSquareIcon} onClick={() => setEditing(true)} />
        <IconButton size="sm" label="Delete this listen-through" icon={TrashIcon} onClick={() => void c.deleteRead(book.book.id, read.id)} />
      </div>
    </li>
  );
}
