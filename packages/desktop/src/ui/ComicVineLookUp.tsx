import { ArrowTopRightOnSquareIcon, MagnifyingGlassIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useState, type FormEvent } from "react";
import type { ComicShape } from "@ribbon/core/comic-name";
import { comicVineAddress } from "@ribbon/core/comicvine";
import type { FieldGroup } from "@ribbon/core/edit-form";
import type { ComicVineAsked, FoundOnComicVine, OfferedRun } from "../app/controller";
import { useController } from "./store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { comparedFields, type FormValues, type LookUpStart } from "./book-form";

/** A text field's box, as the edit form's (EditBook.tsx). */
const CONTROL = "w-full min-w-0 rounded-md bg-raised px-2.5 py-1.5 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6";
const LABEL = "text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5";
const MUTED = "text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5";

/**
 * "Look it up…", the edit form's second face for a comic
 * (docs/BOOK-DETAILS.md, section 7): ComicVine asked by the comic's page
 * there, or by searching for its run by the series' name; then each field
 * as the comic has it beside what ComicVine says, and "Use these" to keep
 * the match. Nothing is kept before that. Every request goes where the
 * comic is kept: to its server, or, for a comic in a folder, to ComicVine
 * with the person's own key (app/comicvine.ts).
 *
 * How ComicVine's number is read is what the form says the comic is: an
 * issue's issue number, a collection's volume.
 */
export function ComicVineLookUp({
  bookId,
  title,
  where,
  open,
  onClose,
  onClosed,
  onBack,
  onKept,
  groups,
  form,
  shape,
  start,
}: {
  bookId: string;
  title: string;
  where: "here" | "server";
  open: boolean;
  onClose: () => void;
  onClosed?: (() => void) | undefined;
  onBack: () => void;
  onKept: () => void;
  groups: readonly FieldGroup[];
  form: FormValues;
  shape: ComicShape;
  start: LookUpStart;
}) {
  const c = useController();
  const [address, setAddress] = useState(start.address);
  const [name, setName] = useState(start.name);
  const [year, setYear] = useState(start.year);
  const [number, setNumber] = useState(start.number);
  const [runs, setRuns] = useState<OfferedRun[] | null>(null);
  const [found, setFound] = useState<{ asked: ComicVineAsked; what: FoundOnComicVine } | null>(null);
  const [busy, setBusy] = useState<"looking" | "searching" | "keeping" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const numberLabel = shape === "collection" ? "Volume" : "Issue";
  const runAddress = comicVineAddress(address)?.kind === "run";

  /** Ask, saying ComicVine's or the server's words when it can't be answered. */
  const asking = async (what: "looking" | "searching" | "keeping", ask: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await ask();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const lookUp = (asked: ComicVineAsked) => asking("looking", async () => setFound({ asked, what: await c.lookUpOnComicVine(bookId, asked) }));

  const byAddress = (e: FormEvent) => {
    e.preventDefault();
    void lookUp({ address: address.trim(), as: shape, ...(runAddress && number.trim() ? { issue: number.trim() } : {}) });
  };

  const search = (e: FormEvent) => {
    e.preventDefault();
    const firstYear = Number(year.trim());
    void asking("searching", async () => setRuns(await c.comicVineRuns(bookId, { name: name.trim(), year: year.trim() && Number.isInteger(firstYear) ? firstYear : null })));
  };

  const pick = (run: OfferedRun) => {
    if (!number.trim()) {
      setError(`Give the ${numberLabel.toLowerCase()}’s number to look for in ${run.name}.`);
      return;
    }
    void lookUp({ address: run.id, issue: number.trim(), as: shape });
  };

  const keep = () => {
    if (!found) return;
    void asking("keeping", async () => {
      await c.keepComicVineMatch(bookId, found.asked);
      onKept();
    });
  };

  const asksFrom = where === "server" ? "The server asks ComicVine with its own key" : "Ribbon asks ComicVine with your key";
  const sent = "sending only what names the comic: a series’ name, a number, a year or a page’s address.";

  if (found) {
    const rows = comparedFields(groups, form, found.what.values);
    const differ = rows.filter((r) => !r.same).length;
    const run = found.what.run;
    return (
      <Dialog
        open={open}
        onClose={onClose}
        onClosed={onClosed}
        labelId="edit-book-title"
        wide
        title={`${title} on ComicVine`}
        description="Each detail as the comic has it, beside what ComicVine says. Use these keeps ComicVine’s under your own changes: a field you changed stays as you have it, and Forget the match takes ComicVine’s away again."
        hint={error ? <span className="text-red-600 dark:text-red-400">{error}</span> : differ === 0 ? "ComicVine says what the comic says" : `ComicVine says something else for ${differ} of ${rows.length}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setFound(null)}>
              Back
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={keep}>
              {busy === "keeping" ? "Keeping…" : "Use these"}
            </Button>
          </>
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto quiet-scroll px-5 pt-4 pb-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="min-w-0 text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">{run ? [run.startYear ? `${run.name} (${run.startYear})` : run.name, run.publisher].filter(Boolean).join(" · ") : "An issue on ComicVine"}</p>
            <LinkBack address={found.what.address} label="See it on ComicVine" />
          </div>
          {rows.length === 0 ? (
            <p className={clsx(MUTED, "mt-4")}>ComicVine says nothing of this comic’s details.</p>
          ) : (
            <div className="mt-3 rounded-[10px] bg-surface ring-1 ring-line">
              <div className="hidden grid-cols-[8rem_1fr_1fr] gap-x-4 border-b border-line px-3 py-2 sm:grid" aria-hidden="true">
                <span />
                <span className="text-[0.8125rem]/5 text-ink-3">This comic</span>
                <span className="text-[0.8125rem]/5 text-ink-3">ComicVine</span>
              </div>
              <dl className="divide-y divide-line">
                {rows.map((r) => (
                  <div key={r.field} className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[8rem_1fr_1fr]">
                    <dt className="col-span-2 text-sm/5 font-medium text-ink sm:col-span-1 sm:text-[0.8125rem]/5">{r.label}</dt>
                    <dd className={clsx("min-w-0 text-sm/5 break-words whitespace-pre-line sm:text-[0.8125rem]/5", r.same ? "text-ink-3" : "text-ink-2")}>
                      <span className="sr-only">This comic: </span>
                      <Value text={r.here} />
                    </dd>
                    <dd className={clsx("min-w-0 text-sm/5 break-words whitespace-pre-line sm:text-[0.8125rem]/5", r.same ? "text-ink-3" : "font-medium text-ink")}>
                      <span className="sr-only">ComicVine: </span>
                      <Value text={r.there} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      labelId="edit-book-title"
      wide
      title={`Look up ${title} on ComicVine`}
      description={`${asksFrom}, ${sent} Nothing is kept until you choose to.`}
      hint={error ? <span className="text-red-600 dark:text-red-400">{error}</span> : busy === "looking" ? "Asking ComicVine…" : busy === "searching" ? "Searching ComicVine…" : undefined}
      actions={
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto quiet-scroll px-5 pt-4 pb-5">
        <div className="flex flex-col gap-6">
          <form onSubmit={byAddress} className="min-w-0">
            <label htmlFor="comicvine-address" className={LABEL}>
              Its page on ComicVine
            </label>
            <p className={clsx(MUTED, "mt-0.5")}>An issue’s page, or its run’s with the {numberLabel.toLowerCase()} below.</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="comicvine-address"
                name="comicvine-address"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://comicvine.gamespot.com/…/4000-…/"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className={CONTROL}
              />
              <Button type="submit" size="sm" disabled={busy !== null || !address.trim()} className="shrink-0 self-start sm:self-auto">
                Look up
              </Button>
            </div>
          </form>

          <form onSubmit={search} className="min-w-0 border-t border-line pt-5">
            <p className={LABEL}>Or find its run</p>
            <p className={clsx(MUTED, "mt-0.5")}>ComicVine’s runs by the series’ name, then the {numberLabel.toLowerCase()} by its number.</p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_6rem_auto] sm:items-end">
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <label htmlFor="comicvine-series" className={clsx(MUTED, "mb-1 block")}>
                  Series
                </label>
                <input id="comicvine-series" name="comicvine-series" type="text" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} className={CONTROL} />
              </div>
              <div className="min-w-0">
                <label htmlFor="comicvine-year" className={clsx(MUTED, "mb-1 block")}>
                  First year
                </label>
                <input id="comicvine-year" name="comicvine-year" type="text" inputMode="numeric" autoComplete="off" placeholder="Any" value={year} onChange={(e) => setYear(e.target.value)} className={clsx(CONTROL, "tabular-nums")} />
              </div>
              <div className="min-w-0">
                <label htmlFor="comicvine-number" className={clsx(MUTED, "mb-1 block")}>
                  {numberLabel}
                </label>
                <input id="comicvine-number" name="comicvine-number" type="text" inputMode="decimal" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} className={clsx(CONTROL, "tabular-nums")} />
              </div>
              <Button type="submit" size="sm" leading={MagnifyingGlassIcon} disabled={busy !== null || !name.trim()} className="col-span-2 self-start sm:col-span-1 sm:mb-0.5 sm:self-auto">
                {busy === "searching" ? "Searching…" : "Search"}
              </Button>
            </div>
            {runs !== null &&
              (runs.length === 0 ? (
                <p className={clsx(MUTED, "mt-4")}>ComicVine has no run by that name{year.trim() ? ` from ${year.trim()}` : ""}.</p>
              ) : (
                <ul role="list" aria-label="Runs on ComicVine" className="mt-4 divide-y divide-line rounded-[10px] bg-surface ring-1 ring-line">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <button type="button" disabled={busy !== null} onClick={() => pick(run)} className="flex w-full min-w-0 items-center gap-3 rounded-[10px] px-3 py-2 text-left focus-ring hover:bg-raised disabled:opacity-60">
                        <RunPicture bookId={bookId} run={run} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base/6 font-medium text-ink sm:text-sm/5">
                            {run.name}
                            {run.startYear !== null && <span className="font-normal text-ink-2"> ({run.startYear})</span>}
                          </span>
                          <span className="block truncate text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">{[run.publisher, run.issues !== null ? `${run.issues} ${run.issues === 1 ? "issue" : "issues"}` : ""].filter(Boolean).join(" · ")}</span>
                        </span>
                        <span className="shrink-0 text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">{number.trim() ? `${numberLabel} ${number.trim()}` : `Choose`}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </form>
        </div>
      </div>
    </Dialog>
  );
}

/** A value of the side by side: its text, or a dash where it has none; a long description held to a few lines. */
function Value({ text }: { text: string }) {
  if (!text.trim()) return <span className="text-ink-3">None</span>;
  return <span className="line-clamp-6">{text}</span>;
}

/** The small picture of a run's first cover, fetched where the comic is looked up (never by the page from ComicVine), or a blank of its shape. */
function RunPicture({ bookId, run }: { bookId: string; run: OfferedRun }) {
  const c = useController();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    void c.comicVineRunPicture(bookId, run).then((blob) => {
      if (!live || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [c, bookId, run]);
  return (
    <span className="block h-12 w-8 shrink-0 overflow-hidden rounded-[3px] bg-raised outline-1 -outline-offset-1 outline-line">
      {url && <img src={url} alt="" onError={() => setUrl(null)} className="size-full object-cover" />}
    </span>
  );
}

/** ComicVine's page for what is shown, opened in the browser: the link back its terms ask for. */
export function LinkBack({ address, label }: { address: string; label: string }) {
  const c = useController();
  return (
    <button type="button" onClick={() => c.openComicVinePage(address)} title={address} className="inline-flex shrink-0 items-center gap-1 rounded-sm text-sm/5 text-ink-2 focus-ring hover:text-ink sm:text-[0.8125rem]/5">
      {label}
      <ArrowTopRightOnSquareIcon aria-hidden="true" className="size-3.5 shrink-0" />
    </button>
  );
}
