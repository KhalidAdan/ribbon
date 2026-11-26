import { ArrowUturnLeftIcon, PhotoIcon, RectangleStackIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComicShape } from "@ribbon/core/comic-name";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { editForm, editFormAbout, type FieldSpec, type ShapeQuestion } from "@ribbon/core/edit-form";
import { EDIT_FIELDS, fieldText, readAlongOff, READ_ALONG_OFF, SWITCH_ON, switchText, type EditField } from "@ribbon/core/edits";
import { bookKind } from "@ribbon/core/kind";
import { useController } from "./store";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { CoverPages, coverFromPage, type PagePictures } from "./CoverPages";
import { Dialog } from "./Dialog";
import { Radio, Toggle } from "./kit";
import { asksOf, formAsShape, formToSave, shapeOf, showsField, type FormAsks } from "./book-form";

type Form = Record<Exclude<EditField, "cover">, string>;

const IMAGE_TYPES = "image/jpeg,image/png,image/webp";

/**
 * Fix what the files got wrong: a book's details and its cover. Each
 * field shows what the files say when it differs, with a way back to it.
 * Saved beside the book; its files are never touched.
 *
 * The form is the one its kind of book wants (core/edit-form.ts). A comic
 * (and a PDF, as "The book") is asked first what it is: an issue, a
 * collection or a comic on its own, which decides the numbers it is asked
 * for (book-form.ts). Then the people who made it by role, its cover date
 * and the rest; never a narrator. Its title is the story's own name: the
 * shelf names it from that, its series and its number. Its cover can be
 * any of its own pages (CoverPages.tsx), chosen from the form's second
 * face. And whether it reads right to left, a switch, which every device
 * then reads it by, whatever its file says.
 *
 * And, for a book with both its text and its narration, whether it reads
 * along: a switch to turn off for a book where it never will (a different
 * edition, a recording that strays from the text). It's saved with the
 * rest, and nothing is deleted, so it can be turned back on.
 */
export function EditBook({ book, open, onClose, onClosed }: { book: ScannedBook; open: boolean; onClose: () => void; onClosed?: () => void }) {
  const c = useController();
  const original = book.original ?? book.book;
  const kind = bookKind(book.book);
  const groups = editForm(kind, book.book.comic);
  const initial = (): Form => Object.fromEntries(EDIT_FIELDS.filter((f) => f !== "cover").map((f) => [f, fieldText(book.book, f)])) as Form;
  // What the files say for each field: what "Use the files’" goes back to, and what a field is compared with.
  const files = useMemo(() => Object.fromEntries(EDIT_FIELDS.filter((f) => f !== "cover").map((f) => [f, fieldText(original, f)])) as Form, [original]);
  const [form, setForm] = useState<Form>(initial);
  const [asks, setAsks] = useState<FormAsks>(() => asksOf(kind, initial(), book.edits));
  const [saving, setSaving] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // A comic's cover chosen from its pages: the form's second face, and the page picked there.
  const [choosingPage, setChoosingPage] = useState(false);
  const [page, setPage] = useState<number | null>(null);
  const [settingCover, setSettingCover] = useState(false);
  const pictures = useRef<PagePictures | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initial());
      setAsks(asksOf(kind, initial(), book.edits));
      setCoverError(null);
      setChoosingPage(false);
      setPage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, book.book.id]);

  const set = (f: keyof Form, v: string) => setForm((prev) => ({ ...prev, [f]: v }));
  const changed = (f: keyof Form) => normalise(form[f]) !== normalise(files[f]);
  // A comic said to be something else: the numbers that no longer fit are emptied, and the ones that do come back as the book had them.
  const chooseShape = (shape: ComicShape) => {
    setAsks((prev) => ({ ...prev, shape }));
    setForm((prev) => formAsShape(prev, shape, groups, initial()));
  };
  // Only a book with text and narration has a read-along to turn off.
  const canReadAlong = !!book.book.ebook && book.book.durationMs > 0;
  // What a save sends: only what this form shows, and a comic's numbers its shape leaves out. A field it leaves out is never changed by it.
  const toSave = (): Partial<Record<EditField, string>> => ({ ...formToSave(form, groups, asks, files), ...(canReadAlong ? { readAlong: form.readAlong } : {}) });
  const changes = Object.entries(toSave()).filter(([f, v]) => normalise(v) !== normalise(files[f as keyof Form])).length;
  const coverEdited = book.edits?.cover !== undefined;

  const chooseCover = async (file: File) => {
    setCoverError(null);
    const ext = file.name.split(".").pop() ?? "jpg";
    if (!/^(jpe?g|png|webp)$/i.test(ext)) {
      setCoverError("Choose a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setCoverError("That image is over 20 MB. Choose a smaller one.");
      return;
    }
    await c.setCover(book.book.id, new Uint8Array(await file.arrayBuffer()), ext);
  };

  const setPageAsCover = async () => {
    if (page === null || !pictures.current) return;
    setSettingCover(true);
    setCoverError(null);
    try {
      await c.setCover(book.book.id, await coverFromPage(pictures.current, page), "jpg");
      setChoosingPage(false);
    } catch {
      setCoverError(`Page ${page + 1} couldn’t be made into a cover.`);
    } finally {
      setSettingCover(false);
    }
  };

  if (choosingPage) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        onClosed={onClosed}
        labelId="edit-book-title"
        wide
        title={`A cover for ${book.book.title}`}
        description="Choose the page to show as its cover, on the shelf and on every device. The comic’s file is never touched."
        hint={coverError ?? (page === null ? "No page chosen" : `Page ${page + 1} chosen`)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setChoosingPage(false)}>
              Back
            </Button>
            <Button variant="primary" disabled={page === null || settingCover} onClick={() => void setPageAsCover()}>
              {settingCover ? "Setting…" : page === null ? "Use this page" : `Use page ${page + 1}`}
            </Button>
          </>
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto quiet-scroll px-5 pt-4 pb-5">
          <CoverPages bookId={book.book.id} chosen={page} onChoose={setPage} onPictures={(p) => (pictures.current = p)} />
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
      title={`Edit ${book.book.title}`}
      description={editFormAbout(kind)}
      hint={changes === 0 ? "Everything as the files say" : `${changes} ${changes === 1 ? "field differs" : "fields differ"} from the files`}
      actions={
        <>
          {(book.edits && Object.keys(book.edits).length > 0) && (
            <Button
              variant="ghost"
              onClick={() => {
                void c.resetEdits(book.book.id).then(onClose);
              }}
            >
              Undo every change
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void c.saveEdits(book.book.id, toSave()).finally(() => {
                setSaving(false);
                onClose();
              });
            }}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto quiet-scroll px-5 pt-4 pb-5">
        <div className="flex flex-col gap-6 sm:flex-row">
          <div className="flex shrink-0 flex-col gap-2 sm:w-36">
            <Cover url={c.coverUrl(book)} title={book.book.title} className="w-28 sm:w-36" />
            <input
              ref={fileRef}
              type="file"
              name="cover"
              accept={IMAGE_TYPES}
              className="sr-only"
              aria-label="Choose a cover image"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void chooseCover(f);
                e.target.value = "";
              }}
            />
            {kind === "comic" && (
              <Button size="sm" leading={RectangleStackIcon} onClick={() => setChoosingPage(true)} className="self-start">
                Choose a page…
              </Button>
            )}
            <Button size="sm" leading={PhotoIcon} onClick={() => fileRef.current?.click()} className="self-start">
              Choose an image…
            </Button>
            {coverEdited && (
              <Button size="sm" variant="ghost" leading={ArrowUturnLeftIcon} onClick={() => void c.resetEdits(book.book.id, "cover")} className="self-start">
                {kind === "comic" ? "Use the first page" : "Use the files’ cover"}
              </Button>
            )}
            {coverError && <p className="text-sm/5 text-red-600 dark:text-red-400 sm:text-[0.8125rem]/5">{coverError}</p>}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {groups.map((g) => (
              <fieldset key={g.label} className="min-w-0">
                <legend className="mb-2 px-1 text-sm/5 font-medium text-ink-3 sm:text-[0.8125rem]/5">{g.label}</legend>
                <div className="grid grid-cols-1 gap-x-3 gap-y-4 rounded-[10px] bg-surface p-3 ring-1 ring-line sm:grid-cols-2">
                  {g.hint && <p className="text-sm/5 text-pretty text-ink-3 sm:col-span-2 sm:text-[0.8125rem]/5">{g.hint}</p>}
                  {g.shape && asks.shape && <WhatItIs question={g.shape} shape={asks.shape} said={shapeOf(form) === asks.shape} onChoose={chooseShape} />}
                  {g.fields
                    .filter((spec) => showsField(spec, asks))
                    .map((spec) =>
                      spec.switch ? (
                        <Switch key={spec.field} spec={spec} about={spec.switch} value={form[spec.field]} files={files[spec.field]} changed={changed(spec.field)} onChange={(v) => set(spec.field, v)} />
                      ) : spec.whileEdited ? (
                        <KeptField key={spec.field} spec={spec} value={form[spec.field]} onChange={(v) => set(spec.field, v)} />
                      ) : (
                        <Field key={spec.field} spec={spec} value={form[spec.field]} files={files[spec.field]} changed={changed(spec.field)} onChange={(v) => set(spec.field, v)} />
                      ),
                    )}
                </div>
              </fieldset>
            ))}
            {canReadAlong && (
              <fieldset className="min-w-0">
                <legend className="mb-2 px-1 text-sm/5 font-medium text-ink-3 sm:text-[0.8125rem]/5">Read-along</legend>
                <div className="flex items-start justify-between gap-4 rounded-[10px] bg-surface p-3 ring-1 ring-line">
                  <div className="min-w-0">
                    <label htmlFor="edit-readAlong" className="text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">
                      Read along with the narration
                    </label>
                    <p className="mt-1 text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5">
                      {readAlongOff(form)
                        ? "Off: this book is read or listened to on every device, with no sentence marked as the narrator’s, and its narration isn’t transcribed. What was transcribed is kept, so this can be turned back on."
                        : "Turn this off for a book where it will never work: a different edition, or a recording that strays from the text."}
                    </p>
                  </div>
                  <Toggle id="edit-readAlong" label="Read along with the narration" checked={!readAlongOff(form)} onChange={(on) => set("readAlong", on ? "" : READ_ALONG_OFF)} />
                </div>
              </fieldset>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** A text field's box. */
const CONTROL = "w-full rounded-md bg-raised px-2.5 py-1.5 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6";

function Field({ spec, value, files, changed, onChange }: { spec: FieldSpec; value: string; files: string; changed: boolean; onChange: (v: string) => void }) {
  const id = `edit-${spec.field}`;
  return (
    <div className={clsx("min-w-0", spec.wide && "sm:col-span-2")}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">
          {spec.label}
        </label>
        {changed && (
          <button type="button" onClick={() => onChange(files)} className="rounded-sm text-sm/5 text-ink-3 focus-ring hover:text-ink sm:text-[0.8125rem]/5" title={files ? `The files say: ${files}` : "The files say nothing here"}>
            Use the files’
          </button>
        )}
      </div>
      {spec.multiline ? (
        <textarea id={id} name={spec.field} rows={6} value={value} onChange={(e) => onChange(e.target.value)} className={clsx(CONTROL, "resize-y")} />
      ) : (
        <input id={id} name={spec.field} type="text" inputMode={spec.inputMode} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} className={CONTROL} />
      )}
      {(changed || spec.hint) && (
        <p className={clsx("mt-1 text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5", changed && "truncate")}>
          {changed ? (files ? `The files say “${files.length > 80 ? `${files.slice(0, 80)}…` : files}”.` : "The files say nothing here.") : spec.hint}
        </p>
      )}
    </div>
  );
}

/**
 * What a comic is (core/edit-form.ts, `ShapeQuestion`): an issue, a
 * collection or a comic on its own, a radio each. The answer decides which
 * numbers are asked for. It isn't kept, the numbers say it, so an issue
 * left with no issue number, or a collection with no volume and no issues,
 * is said to be kept as a comic on its own.
 */
function WhatItIs({ question, shape, said, onChoose }: { question: ShapeQuestion; shape: ComicShape; said: boolean; onChoose: (shape: ComicShape) => void }) {
  return (
    <fieldset className="min-w-0 sm:col-span-2">
      <legend className="text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">{question.label}</legend>
      <div className="mt-2 flex flex-col gap-x-6 gap-y-2 sm:flex-row sm:flex-wrap">
        {question.answers.map((a) => (
          <label key={a.shape} className="flex gap-2.5 text-base/6 text-ink sm:text-sm/6">
            <span className="flex h-lh items-center">
              <Radio id={`edit-shape-${a.shape}`} name="edit-shape" value={a.shape} checked={shape === a.shape} onChange={() => onChoose(a.shape)} />
            </span>
            {a.label}
          </label>
        ))}
      </div>
      {!said && (
        <p className="mt-1.5 text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5">
          {shape === "issue" ? "With no issue number, it is kept as a comic on its own." : "With no volume and no issues, it is kept as a comic on its own."}
        </p>
      )}
    </fieldset>
  );
}

/**
 * A byline kept from before a comic's people had fields of their own
 * (core/comic-edits.ts, core/edit-form.ts's By): shown as it is, with a
 * way to take it back. Taken back, it is emptied here, and once the form
 * is saved the writers and the art make the byline (book-form.ts,
 * `formToSave`).
 */
function KeptField({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (v: string) => void }) {
  const id = `edit-${spec.field}`;
  const kept = value.trim() !== "";
  return (
    <div className={clsx("min-w-0", spec.wide && "sm:col-span-2")}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">
          {spec.label}
        </label>
        {kept && (
          <button type="button" onClick={() => onChange("")} className="rounded-sm text-sm/5 text-ink-3 focus-ring hover:text-ink sm:text-[0.8125rem]/5">
            Take it back
          </button>
        )}
      </div>
      <input id={id} name={spec.field} type="text" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} className={CONTROL} />
      <p className="mt-1 text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5">{kept ? spec.hint : "Taken back: once this is saved, the writers and the art make the byline."}</p>
    </div>
  );
}

/** A detail that is on or off (core/edit-form.ts, `switch`): what it means as it is set, and what the file says when that differs. */
function Switch({ spec, about, value, files, changed, onChange }: { spec: FieldSpec; about: { on: string; off: string }; value: string; files: string; changed: boolean; onChange: (v: string) => void }) {
  const id = `edit-${spec.field}`;
  const on = value === SWITCH_ON;
  return (
    <div className={clsx("flex min-w-0 items-start justify-between gap-4", spec.wide && "sm:col-span-2")}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">
          {spec.label}
        </label>
        <p className="mt-1 text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5">
          {on ? about.on : about.off}
          {changed && (files === SWITCH_ON ? " Its file says it does." : " Its file says it doesn’t.")}
        </p>
      </div>
      <Toggle id={id} label={spec.label} checked={on} onChange={(checked) => onChange(switchText(checked))} />
    </div>
  );
}

function normalise(v: string): string {
  return v.trim().replace(/\r\n/g, "\n");
}
