import { ArrowLeftIcon, BackwardIcon, BookmarkIcon, ForwardIcon, ListBulletIcon, PlayIcon, SpeakerWaveIcon, TrashIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { memo, Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { Ebook } from "../core/ebook";
import type { Highlight } from "../core/types";
import { bookPage, itemsIn, pageOf, placeAtY, yOfPlace, type LaidBlock, type Placed } from "../core/reading/pages";
import { comparePlaces, type BookText, type TextPlace, type TextRange } from "../core/reading/booktext";
import { inRange, rangeOf } from "../core/reading/highlights";
import { justifies, LEADINGS, MEASURES, metricsFor, SIZES, type Metrics, type ReadingSettings } from "../core/reading/typography";
import type { AppController } from "../app/controller";
import { useAppState, useController } from "../ui/store";
import { Button, IconButton } from "../ui/Button";
import { Drawer } from "../ui/Drawer";
import { EmptyState, ProgressLine, Toggle, type MenuItem } from "../ui/kit";
import { useCompact } from "../ui/useCompact";
import { Dock, type Folio } from "./Dock";
import { useListening, type Visible } from "./listening";
import { facesLoaded, FAMILY, loadFaces } from "./typeset";
import { fitsKey, loadSnapshot, savePage, savePlace, type PageSnapshot } from "./snapshot";
import { usePageSwipe } from "./swipe";
import { LayoutEngine } from "./layout-engine";
import type { SectionLayout } from "./layout";
import { PlayButton } from "../ui/PlayerBar";
import { formatDuration } from "../core/speed";
import { msToText, precise, type Alignment } from "../core/reading/align";
import type { Sentence } from "../core/reading/sentences";
import { cut, spansIn, type Marked, type Span, type Tone } from "./marks";
import * as perf from "../app/perf";

/** A sentence marked in the text: the one a tap would listen from, or the one being read aloud. */
interface Mark extends Sentence {
  section: number;
  block: number;
}

/** A chapter not laid out yet: nothing to show for a moment. */
const NOT_YET: SectionLayout = { blocks: [], pages: [], flow: { section: -1, items: [], height: 0 } };

/**
 * The reader (docs/READING.md): the book's EPUB, typeset by Ribbon with
 * pretext, in pages or one long column. Over everything; the place is kept
 * as the reader moves.
 */
export function ReadingView() {
  // Not the player's place, which moves five times a second: the parts that follow it (the mark, the listening bar) select it themselves.
  const { r, book, loadedHere, anyLoaded, settings } = useAppState((s) => ({
    r: s.reading,
    book: s.reading ? s.books.find((b) => b.book.id === s.reading!.bookId) : undefined,
    loadedHere: !!s.reading && s.current?.book.book.id === s.reading.bookId,
    anyLoaded: !!s.current,
    settings: s.readingSettings,
  }));
  const c = useController();
  // A phone: the header and the bars below give way to the dock (Dock.tsx).
  const compact = useCompact();
  const [contents, setContents] = useState(false);
  const [bookmarks, setBookmarks] = useState(false);
  const [type, setType] = useState(false);
  // Whether the lines are justified now, for the switch in the text settings: as set, or as the column decided.
  const [justified, setJustified] = useState(true);
  // The listening bar shows itself while this book's audio is loaded; the header button shows or hides it either way.
  const [barPref, setBarPref] = useState<"auto" | "shown" | "hidden">("auto");
  if (!r) return null;
  const text = r.text;
  const ebook = text?.ebook;
  const place = r.place;
  const entry = text && place ? text.tocEntryAt(place) : -1;
  const chapter = ebook && entry >= 0 ? ebook.toc[entry]!.label : "";
  const barOpen = barPref === "shown" || (barPref === "auto" && loadedHere);
  // Listening from the page needs to know when its sentences are read: only once the book reads along (#152).
  const listen = !!r.alignment && !!r.readsAlong && !!book && book.book.durationMs > 0;
  const title = book?.book.title ?? "";
  // The dock's menu: listening from the page, the full player, and what the header holds on a wider window.
  const menu: MenuItem[] = [
    ...(listen ? [{ label: "Listen from here", onSelect: () => void c.listenFromHere() }] : []),
    ...(anyLoaded ? [{ label: "Player…", onSelect: () => c.expandPlayer() }] : []),
    { label: "Contents…", onSelect: () => setContents(true), disabled: !ebook },
    { label: "Bookmarks…", onSelect: () => setBookmarks(true), disabled: !ebook },
    { label: "Text…", onSelect: () => setType(true), disabled: !ebook },
    { label: "Close book", onSelect: () => void c.closeReading() },
  ];
  // While there is no page to follow (opening, failed, getting read-along ready), the dock still plays and still closes the book.
  const idleDock = compact ? <Dock bookId={r.bookId} text={null} visible={null} place={null} folioAt={null} inset={28} title={title} menu={menu} onContents={null} c={c} /> : null;
  const openContents = () => setContents(true);

  return (
    <div role="dialog" aria-modal="true" aria-label={`Reading ${book?.book.title ?? "a book"}`} className="safe-area fixed inset-0 z-30 flex flex-col bg-canvas text-ink">
      {compact ? (
        // On a phone the page is the book's: its title, quietly, and every control in the dock at the bottom.
        <header className="flex h-12 shrink-0 items-end justify-center px-12 pb-1.5">
          <p className="truncate text-[0.8125rem]/5 font-medium text-ink-2">{title}</p>
        </header>
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 sm:px-3">
          <Button variant="ghost" leading={ArrowLeftIcon} onClick={() => void c.closeReading()}>
            Back
          </Button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">{book?.book.title}</p>
            {chapter && <p className="truncate text-xs/4 text-ink-3">{chapter}</p>}
          </div>
          <IconButton label={barOpen ? "Hide the listening controls" : "Show the listening controls"} icon={SpeakerWaveIcon} aria-pressed={barOpen} disabled={!ebook} onClick={() => setBarPref(barOpen ? "hidden" : "shown")} />
          <IconButton label="Contents" icon={ListBulletIcon} disabled={!ebook} onClick={() => setContents(true)} />
          <IconButton label="Bookmarks" icon={BookmarkIcon} disabled={!ebook} onClick={() => setBookmarks(true)} />
          <div className="relative">
            <Button variant={type ? "secondary" : "ghost"} aria-expanded={type} aria-haspopup="dialog" disabled={!ebook} onClick={() => setType((v) => !v)}>
              <span aria-hidden="true" className="font-serif text-base/5">
                Aa
              </span>
              <span className="sr-only">Text settings</span>
            </Button>
            {type && !compact && <TypeSettings settings={settings} justified={justified} onChange={(p) => c.setReadingSettings(p)} onClose={() => setType(false)} />}
          </div>
        </header>
      )}

      {r.status === "opening" && <Opening bookId={r.bookId} settings={settings} bar={barOpen} dock={idleDock} />}
      {r.status === "failed" && (
        <Middle>
          <p className="text-base/6 font-medium text-ink sm:text-sm/5">This book’s text could not be opened</p>
          <p className="mt-1 max-w-md text-base/6 text-ink-2 sm:text-sm/5">{r.message}</p>
        </Middle>
      )}
      {r.status === "failed" && idleDock}
      {r.status === "ready" && text && ebook && place && (
        <Text
          key={ebook.meta.title + r.bookId}
          bookId={r.bookId}
          text={text}
          place={place}
          settings={settings}
          bar={barOpen}
          listen={listen}
          alignment={loadedHere && r.readsAlong ? r.alignment : undefined}
          highlights={r.highlights ?? NO_HIGHLIGHTS}
          compact={compact}
          title={title}
          menu={menu}
          onContents={openContents}
          onJustified={setJustified}
          c={c}
        />
      )}

      {ebook && compact && (
        <Drawer open={type} onClose={() => setType(false)} title="Text">
          <TypeFields settings={settings} justified={justified} onChange={(p) => c.setReadingSettings(p)} />
        </Drawer>
      )}

      {ebook && (
        <Drawer open={contents} onClose={() => setContents(false)} title="Contents">
          <Contents ebook={ebook} alignment={r.alignment} readsAlong={!!r.readsAlong} listening={r.listening} entry={entry} c={c} onGo={() => setContents(false)} />
          {r.alignment && r.alignment.how !== "overlay" && <ExportReadAlong exporting={r.exporting} exported={r.exported} c={c} />}
        </Drawer>
      )}
      {ebook && (
        <Drawer open={bookmarks} onClose={() => setBookmarks(false)} title="Bookmarks">
          <HighlightList text={text!} highlights={r.highlights ?? NO_HIGHLIGHTS} listen={listen} c={c} onGo={() => setBookmarks(false)} />
        </Drawer>
      )}
    </div>
  );
}

/**
 * The read-along export, under the contents: a copy of the EPUB with the
 * narration inside, timed sentence by sentence, for any reader that plays
 * Media Overlays. Offered once the whole narration is transcribed.
 */
function ExportReadAlong({ exporting, exported, c }: { exporting: { done: number; total: number } | undefined; exported: { path: string } | { error: string } | undefined; c: AppController }) {
  const transcribed = c.narrationTranscribed();
  const ready = !!transcribed && transcribed.total > 0 && transcribed.done >= transcribed.total;
  const name = exported && "path" in exported ? exported.path.split(/[\\/]/).pop() : null;
  return (
    <section aria-label="Read-along EPUB" className="mt-6 flex flex-col gap-2 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm/5 font-medium text-ink sm:text-[0.8125rem]/5">Read-along EPUB</h3>
        <Button size="sm" variant="secondary" disabled={!ready || !!exporting} onClick={() => void c.exportReadAlong()}>
          {exporting ? "Exporting…" : "Export"}
        </Button>
      </div>
      <p className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5" aria-live="polite">
        {exporting
          ? `Putting the narration in, chapter by chapter… ${exporting.done} of ${exporting.total}`
          : name
            ? `Saved beside the book as “${name}”.`
            : exported && "error" in exported
              ? `Could not export: ${exported.error}`
              : ready
                ? "A copy of this book with the narration inside, timed sentence by sentence, for any reader that plays read-along. Your EPUB is not changed."
                : `Ready once the narration is all matched to the text (${transcribed && transcribed.total > 0 ? Math.floor((100 * transcribed.done) / transcribed.total) : 0}% so far).`}
      </p>
      {exporting && exporting.total > 0 && <ProgressLine fraction={exporting.done / exporting.total} />}
    </section>
  );
}

/** Below this, a pair is shown as a guess. */
const UNSURE = 0.4;

/**
 * The contents, each entry with the audio chapter it is paired with.
 * Fixing the pairing puts a choice on each entry: automatic, not in the
 * audio, or a chapter of the recording; it is kept beside the book.
 */
function Contents({ ebook, alignment, readsAlong, listening, entry, c, onGo }: { ebook: Ebook; alignment: Alignment | undefined; readsAlong: boolean; listening: { done: number; total: number; what: "openings" | "checkpoints" | "aligning" } | undefined; entry: number; c: AppController; onGo: () => void }) {
  const [fixing, setFixing] = useState(false);
  const units = new Map((alignment?.text ?? []).map((u) => [u.ref, u]));
  const paired = alignment?.how === "chapter";
  const fixedRefs = new Set(c.pairingFixes().map((f) => f.text));
  const fixOf = (ref: string) => c.pairingFixes().find((f) => f.text === ref);
  const clock = (ms: number) => {
    const t = Math.round(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m} min`;
  };
  return (
    <div className="flex flex-col gap-3">
      {alignment && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5" aria-live="polite">
            {listening
              ? `Transcribing the narration for read-along… ${Math.floor((100 * listening.done) / Math.max(1, listening.total))}%`
              : alignment.how === "overlay"
                ? "Read-along from the book’s own narration timing"
                : !readsAlong
                  ? "Read only until the narration is transcribed, on a computer with a graphics card"
                  : paired
                    ? "Paired with the audiobook’s chapters, and read along to the sentence"
                    : "Matched to the audiobook by length"}
          </p>
          {alignment.how !== "overlay" && (
            <Button size="sm" variant={fixing ? "secondary" : "ghost"} aria-pressed={fixing} onClick={() => setFixing((v) => !v)}>
              {fixing ? "Done" : "Fix pairing"}
            </Button>
          )}
        </div>
      )}
      <ol className="flex flex-col">
        {ebook.toc.map((t, i) => {
          const ref = `${ebook.sections[t.section]?.href}#${t.block}`;
          const unit = units.get(ref);
          const pair = unit && unit.pair >= 0 ? alignment!.pairs[unit.pair] : undefined;
          const unsure = !!pair && !pair.fixed && pair.confidence < UNSURE;
          const fix = fixOf(ref);
          return (
            <li key={i} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  c.moveReading({ section: t.section, block: t.block, offset: 0 }, "seek");
                  onGo();
                }}
                aria-current={i === entry ? "true" : undefined}
                className={clsx("flex min-w-0 flex-1 items-baseline gap-2 rounded-md py-1.5 pr-2 text-left text-base/6 focus-ring hover:bg-raised sm:text-sm/5", i === entry ? "font-medium text-ink" : "text-ink-2")}
                style={{ paddingLeft: `${0.5 + t.depth * 1}rem` }}
              >
                {i === entry && <span className="mr-0 -ml-3 size-1.5 shrink-0 self-center rounded-full bg-place" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {paired && unit && !fixing && (
                  <span className={clsx("shrink-0 text-xs/4 font-normal", unsure ? "text-place" : "text-ink-3")} title={unsure ? "A guess: fix it if it is wrong" : undefined}>
                    {pair ? pair.audioTitle.split(" + ")[0] : "Not in the audio"}
                    {unsure ? " ?" : ""}
                  </span>
                )}
              </button>
              {fixing && unit && alignment && (
                <select
                  aria-label={`Audio chapter for ${t.label}`}
                  value={fix ? (fix.audioMs === null ? "none" : String(fix.audioMs)) : "auto"}
                  onChange={(e) => void c.fixPairing(ref, e.target.value === "auto" ? "auto" : e.target.value === "none" ? null : Number(e.target.value))}
                  className={clsx("w-40 shrink-0 rounded-md bg-raised px-2 py-1 text-sm/5 ring-1 ring-line focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:text-[0.8125rem]/5", fixedRefs.has(ref) ? "text-ink" : "text-ink-2")}
                >
                  <option value="auto">Auto · {pair ? pair.audioTitle.split(" + ")[0] : "not in the audio"}</option>
                  <option value="none">Not in the audio</option>
                  {alignment.audio.map((a) => (
                    <option key={a.startMs} value={String(a.startMs)}>
                      {a.title} · {clock(a.startMs)}
                    </option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const NO_HIGHLIGHTS: Highlight[] = [];

/** The bookmarks made from highlights, in the order of the book: their words, where they are, listen, delete. */
function HighlightList({ text, highlights, listen, c, onGo }: { text: BookText; highlights: Highlight[]; listen: boolean; c: AppController; onGo: () => void }) {
  if (highlights.length === 0) {
    return (
      <EmptyState icon={BookmarkIcon} title="No bookmarks in the text yet">
        Select words in the text and choose Bookmark to keep them here{listen ? ", and in the audiobook’s bookmarks" : ""}.
      </EmptyState>
    );
  }
  return (
    <ul role="list" className="flex flex-col">
      {highlights.map((h) => {
        const at = text.fromLocator(h.text.start);
        const entry = text.tocEntryAt(at);
        const where = [entry >= 0 ? text.ebook.toc[entry]!.label : "", h.offsetMs !== null ? formatDuration(h.offsetMs) : ""].filter(Boolean).join(" · ");
        return (
          <li key={h.id} className="flex items-start gap-1 rounded-md">
            <button
              type="button"
              onClick={() => {
                c.moveReading(at, "seek");
                onGo();
              }}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-2 pr-2 pl-3 text-left focus-ring hover:bg-raised"
            >
              <span className="line-clamp-3 text-base/6 text-pretty text-ink sm:text-sm/5">{h.text.quote.replace(/\s+/g, " ")}</span>
              {h.note && <span className="text-base/6 text-ink-2 sm:text-sm/5">{h.note}</span>}
              {where && <span className="text-xs/4 text-ink-3 tabular-nums">{where}</span>}
            </button>
            <div className="flex shrink-0 py-1">
              {listen && (
                <IconButton
                  size="sm"
                  label="Listen from here"
                  icon={PlayIcon}
                  onClick={() => {
                    onGo();
                    void c.listenFromHere(at);
                  }}
                />
              )}
              <IconButton size="sm" label="Delete the bookmark" icon={TrashIcon} onClick={() => void c.removeBookmark(h.bookId, h.id)} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Middle({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-base/6 text-ink-2 sm:text-sm/5">{children}</div>;
}

/** The type settings, under the Aa button. */
function TypeSettings({ settings, justified, onChange, onClose }: { settings: ReadingSettings; justified: boolean; onChange: (p: Partial<ReadingSettings>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" aria-label="Text settings" className="absolute top-full right-0 z-10 mt-2 w-72 rounded-[10px] bg-surface p-4 shadow-lg ring-1 ring-line dark:shadow-none dark:ring-line-strong">
      <TypeFields settings={settings} justified={justified} onChange={onChange} />
    </div>
  );
}

/** The type settings themselves: under the Aa button on a wide window, in a drawer from the dock's menu on a phone. */
function TypeFields({ settings, justified, onChange }: { settings: ReadingSettings; justified: boolean; onChange: (p: Partial<ReadingSettings>) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-base/6 text-ink-2 sm:text-sm/5">Size</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" disabled={settings.size <= 0} onClick={() => onChange({ size: settings.size - 1 })} aria-label="Smaller text">
            <span className="font-serif text-xs">A</span>
          </Button>
          <span className="w-10 text-center text-sm/5 text-ink tabular-nums">{SIZES[settings.size]}</span>
          <Button size="sm" variant="secondary" disabled={settings.size >= SIZES.length - 1} onClick={() => onChange({ size: settings.size + 1 })} aria-label="Larger text">
            <span className="font-serif text-base/4">A</span>
          </Button>
        </div>
      </div>
      <Choice label="Spacing" value={settings.spacing} options={LEADINGS.map((_, i) => ["Tight", "Normal", "Loose"][i]!)} onChange={(spacing) => onChange({ spacing })} />
      <Choice label="Width" value={settings.width} options={MEASURES.map((_, i) => ["Narrow", "Normal", "Wide"][i]!)} onChange={(width) => onChange({ width })} />
      <Choice label="Layout" value={settings.layout === "pages" ? 0 : 1} options={["Pages", "Scroll"]} onChange={(i) => onChange({ layout: i === 0 ? "pages" : "scroll" })} />
      <div className="flex items-center justify-between gap-3">
        <span className="text-base/6 text-ink-2 sm:text-sm/5">Justify</span>
        <Toggle label="Justify the text" checked={justified} onChange={(justify) => onChange({ justify })} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-base/6 text-ink-2 sm:text-sm/5">Mark the sentence read aloud</span>
        <Toggle label="Mark the sentence read aloud" checked={settings.highlight} onChange={(highlight) => onChange({ highlight })} />
      </div>
    </div>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: number; options: string[]; onChange: (i: number) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-base/6 text-ink-2 sm:text-sm/5">{label}</span>
      <div role="group" aria-label={label} className="grid gap-1 rounded-md bg-raised p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o, i) => (
          <button key={o} type="button" aria-pressed={i === value} onClick={() => onChange(i)} className={clsx("rounded-[5px] py-1 text-sm/5 font-medium focus-ring sm:text-[0.8125rem]/5", i === value ? "bg-surface text-ink shadow-xs ring-1 ring-line" : "text-ink-2 hover:text-ink")}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The book's chapters laid out for this window and these settings, by the
 * layout engine (layout-engine.ts): in a worker where one runs, so the page
 * never waits on a long chapter. `layout(s)` is a chapter if it is ready,
 * else nothing to show yet; `want` asks for chapters, most needed first.
 */
function useLayout(bookId: string, ebook: Ebook, settings: ReadingSettings, viewport: { width: number; height: number } | null) {
  const engine = useMemo(() => new LayoutEngine(ebook), [ebook]);
  useEffect(() => {
    engine.start();
    return () => engine.destroy();
  }, [engine]);
  const version = useSyncExternalStore(engine.subscribe, engine.getVersion);
  const metrics = useMemo(() => (viewport ? metricsFor(settings, viewport) : null), [settings, viewport]);
  // The faces are loaded at start; only a book opened before they arrive waits for them.
  const [ready, setReady] = useState(facesLoaded);
  useEffect(() => {
    if (ready || !metrics) return;
    let live = true;
    void loadFaces(metrics.size).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [ready, metrics]);
  // Justified lines in a narrow column open rivers: as set, and left unset only where the lines are long enough (typography.ts).
  const justify = !!metrics && justifies(settings, metrics, engine.hyphenates);
  if (metrics) engine.setSpec({ metrics, justify });
  // The page you left, laid out last time for this same spec: the first page needs no layout.
  const seeded = useRef(false);
  if (metrics && !seeded.current) {
    seeded.current = true;
    const snap = loadSnapshot(bookId);
    if (snap && snap.chars === ebook.sections[snap.section]?.chars) engine.seed(snap.section, snap.layout, snap.key);
  }
  // A new function when a chapter the page watches arrives, so what uses it draws again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useCallback((section: number): SectionLayout | undefined => engine.get(section), [engine, version]);
  return { metrics, ready: ready && !!metrics, layout, engine, justify };
}

/** Ask for a chapter, the ones either side of it, then the rest of the book outward from it. */
function wantAround(engine: LayoutEngine, text: BookText, section: number): void {
  const around = [section, neighbour(text.ebook, section, 1), neighbour(text.ebook, section, -1)].filter((s): s is number => s !== null);
  engine.want(around);
  const rest = text.ebook.sections.map((s, i) => (s.linear ? i : -1)).filter((i) => i >= 0 && !around.includes(i));
  engine.later(rest.sort((a, b) => Math.abs(a - section) - Math.abs(b - section) || a - b));
}

/** The next and previous sections in the reading order. */
function neighbour(ebook: Ebook, section: number, step: 1 | -1): number | null {
  for (let s = section + step; s >= 0 && s < ebook.sections.length; s += step) if (ebook.sections[s]!.linear) return s;
  return null;
}

function Text({ bookId, text, place, settings, bar, listen, alignment, highlights, compact, title, menu, onContents, onJustified, c }: { bookId: string; text: BookText; place: TextPlace; settings: ReadingSettings; bar: boolean; listen: boolean; alignment: Alignment | undefined; highlights: Highlight[]; compact: boolean; title: string; menu: MenuItem[]; onContents: () => void; onJustified: (on: boolean) => void; c: AppController }) {
  const [visible, setVisible] = useState<Visible | null>(null);
  const onVisible = useCallback((v: Visible) => setVisible((old) => (old && same(old.from, v.from) && same(old.to, v.to) ? old : v)), []);
  const box = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setViewport((v) => (v && v.width === el.clientWidth && v.height === el.clientHeight ? v : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ebook = text.ebook;
  const { metrics, ready, layout, engine, justify } = useLayout(bookId, ebook, settings, viewport);
  useEffect(() => onJustified(justify), [justify, onJustified]);
  const fits = viewport ? fitsKey(viewport, settings) : "";
  const progress = text.progress(place);
  // On a phone, the page number under the text, for the reader's place or the narrator's: the page in the whole book once
  // every chapter is laid out, how far through until then.
  const linear = useMemo(() => ebook.sections.flatMap((s, i) => (s.linear ? [i] : [])), [ebook]);
  const counts = compact && settings.layout === "pages" ? linear.map((s) => (engine.isFresh(s) ? layout(s)?.pages.length : undefined)) : null;
  const folioAt = (p: TextPlace): Folio => (counts && bookPage(counts, linear.indexOf(p.section), pageOf(layout(p.section)?.pages ?? [], p))) ?? { percent: Math.round(text.progress(p) * 100) };
  // The dock lines up with the text's own edges.
  const inset = viewport && metrics ? Math.max(16, Math.round((viewport.width - (metrics.columns * metrics.column + (metrics.columns - 1) * metrics.gap)) / 2)) : 28;

  // Bookmarks made from highlights, found in this book's text as ranges of places, so they survive any layout.
  const saved = useMemo(() => highlights.map((h) => ({ id: h.id, ...rangeOf(text, h.text) })), [text, highlights]);

  // A tap on the text offers to listen from the sentence tapped, marked until the offer goes; on a highlight, to take its bookmark back.
  const [tap, setTap] = useState<{ mark: Mark | null; saved: string | null; x: number; y: number } | null>(null);
  // Words selected offer to be bookmarked.
  const [chosen, setChosen] = useState<(TextRange & { x: number; y: number }) | null>(null);
  useEffect(() => {
    setTap(null);
    setChosen(null);
  }, [place, settings]);
  useEffect(() => {
    if (!tap && !chosen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setTap(null);
      if (chosen) window.getSelection()?.removeAllRanges();
      setChosen(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tap, chosen]);
  // The selection is read once the pointer is up (a drag), or as it changes otherwise (keys, a double click).
  const dragging = useRef(false);
  const readSelection = useCallback(() => {
    const sel = window.getSelection();
    const el = box.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !el) return setChosen((v) => (v ? null : v));
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return setChosen((v) => (v ? null : v));
    const a = placeAt(sel.anchorNode, sel.anchorOffset);
    const b = placeAt(sel.focusNode, sel.focusOffset);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    if (!a || !b || !last) return setChosen((v) => (v ? null : v));
    const rect = el.getBoundingClientRect();
    const [from, to] = comparePlaces(a, b) <= 0 ? [a, b] : [b, a];
    setTap(null);
    setChosen({ from, to, x: last.right - rect.left, y: last.bottom - rect.top });
  }, []);
  useEffect(() => {
    const onChange = () => !dragging.current && readSelection();
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      readSelection();
    };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("pointerup", onUp);
    };
  }, [readSelection]);
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    // The offer's own buttons answer for themselves.
    if (t.closest("[data-tap]")) return;
    const next = tapped(e, t);
    // Another sentence moves the offer to it; the same one again, or anywhere that is not a sentence, puts the offer away.
    const same = !!next && !!tap && next.saved === tap.saved && next.mark?.section === tap.mark?.section && next.mark?.block === tap.mark?.block && next.mark?.start === tap.mark?.start;
    setTap(same ? null : next);
  };
  // What a tap on the text offers: to listen from the sentence tapped, and to take back the bookmark it is in.
  const tapped = (e: React.MouseEvent, t: HTMLElement) => {
    if (t.closest("button, [data-link]") || !t.closest("[data-block]")) return null;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return null;
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const p = range ? placeAt(range.startContainer, range.startOffset) : null;
    const rect = box.current?.getBoundingClientRect();
    if (!p || !rect) return null;
    const sentence = listen ? text.sentenceAt(p) : null;
    const on = saved.find((r) => inRange(r, p));
    if (!sentence && !on) return null;
    const line = t.closest("[data-block]")!.getBoundingClientRect();
    return { mark: sentence, saved: on?.id ?? null, x: e.clientX - rect.left, y: line.bottom - rect.top };
  };
  // The narrator, as far as the page cares, while this book's audio is loaded: the sentence it is in (when the
  // mapping is close enough to say which), whether it is on the page shown, and whether it plays and is followed.
  // The player moves five times a second; these change every few seconds, and only then does the reader draw again.
  const narrator = useAppState((s) => {
    if (!alignment) return null;
    const ms = c.narratorMs(s.player.positionMs);
    const p = text.place(msToText(alignment, ms));
    const chars = text.chars(p);
    const sentence = settings.highlight && precise(alignment, ms) ? text.sentenceAt(p) : null;
    return {
      sentence: sentence ? `${sentence.section}:${sentence.block}:${sentence.start}` : "",
      inView: visible ? chars >= text.chars(visible.from) && chars <= text.chars(visible.to) : null,
      playing: s.player.playing,
      following: !!s.reading?.following,
    };
  });
  // The same sentence keeps the same mark, so the pages draw again only when the narrator moves on.
  const readKey = narrator?.sentence ?? "";
  const readMark = useMemo(() => {
    if (!readKey) return null;
    const [section, block, start] = readKey.split(":").map(Number) as [number, number, number];
    const found = text.sentences(section, block).find((x) => x.start === start);
    return found ? { ...found, section, block } : null;
  }, [text, readKey]);
  // The narrator read past the page: turn it, to the word being read (a sentence across two pages turns with the narrator, not before).
  const following = !!narrator?.following;
  const outOfView = narrator?.inView === false;
  useEffect(() => {
    if (!following || !outOfView) return;
    const p = c.narratorInText();
    if (p) c.moveReading(p, "periodic", "follow");
  }, [following, outOfView, visible, c]);
  // Turned back to where the narrator is while it plays, or play pressed on the narrator's page: follow it. Only as it
  // comes into view or starts, so "Follow along" turned off stays off, and only once the page shown is the one turned to.
  const playing = !!narrator?.playing;
  const narratorShown = (() => {
    if (narrator?.inView !== true || !visible) return false;
    const at = text.chars(place);
    return at >= text.chars(visible.from) && at < text.chars(visible.to);
  })();
  const was = useRef({ shown: narratorShown, playing });
  useEffect(() => {
    if (narratorShown && playing && !following && (!was.current.shown || !was.current.playing)) c.setFollowing(true);
    was.current = { shown: narratorShown, playing };
  }, [narratorShown, playing, following, c]);
  const mark = tap?.mark ?? readMark;
  const marks = useMemo<Marked[]>(
    () => [...saved.map((r) => ({ from: r.from, to: r.to, tone: "saved" as const })), ...(mark ? [{ from: { section: mark.section, block: mark.block, offset: mark.start }, to: { section: mark.section, block: mark.block, offset: mark.end }, tone: "sentence" as const }] : [])],
    [saved, mark],
  );
  const dropTap = useCallback(() => setTap((t) => (t ? null : t)), []);

  // Copying gives back the book's text, paragraphs whole, not the drawn lines.
  const onCopy = (e: React.ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const a = placeAt(sel.anchorNode, sel.anchorOffset);
    const b = placeAt(sel.focusNode, sel.focusOffset);
    if (!a || !b) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text.text({ from: a, to: b }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={box} className="relative min-h-0 flex-1" onCopy={onCopy} onClick={onClick} onPointerDown={(e) => e.button === 0 && !(e.target as HTMLElement).closest("[data-tap]") && (dragging.current = true)}>
        {ready && metrics && viewport && (
          <Profiler id={settings.layout === "pages" ? "pages" : "scroll"} onRender={perf.onRender}>
            {settings.layout === "pages" ? <Pages bookId={bookId} fits={fits} text={text} place={place} metrics={metrics} viewport={viewport} layout={layout} engine={engine} marks={marks} c={c} onVisible={onVisible} /> : <Scroll text={text} place={place} metrics={metrics} layout={layout} engine={engine} marks={marks} c={c} onVisible={onVisible} onScrolled={dropTap} />}
          </Profiler>
        )}
        {tap && viewport && (
          <div data-tap className="absolute z-10 flex gap-1" style={{ left: Math.max(8, Math.min(viewport.width - (tap.mark && tap.saved ? 300 : 168), tap.x - 80)), top: tap.y + 6 }}>
            {tap.mark && (
              <Button
                size="sm"
                leading={PlayIcon}
                className="shadow-lg"
                onClick={() => {
                  const { section, block, start } = tap.mark!;
                  setTap(null);
                  void c.listenFromHere({ section, block, offset: start });
                }}
              >
                Listen from here
              </Button>
            )}
            {tap.saved && (
              <Button
                size="sm"
                variant="secondary"
                leading={TrashIcon}
                className="shadow-lg"
                onClick={() => {
                  const id = tap.saved!;
                  setTap(null);
                  void c.removeBookmark(bookId, id);
                }}
              >
                Delete bookmark
              </Button>
            )}
          </div>
        )}
        {chosen && viewport && (
          // Pressing it keeps the selection; the click bookmarks it.
          <div data-tap className="absolute z-10" style={{ left: Math.max(8, Math.min(viewport.width - 128, chosen.x - 56)), top: Math.min(viewport.height - 40, chosen.y + 6) }} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
            <Button
              size="sm"
              leading={BookmarkIcon}
              className="shadow-lg"
              onClick={() => {
                const { from, to } = chosen;
                setChosen(null);
                window.getSelection()?.removeAllRanges();
                void c.addHighlight(from, to);
              }}
            >
              Bookmark
            </Button>
          </div>
        )}
      </div>
      {compact ? (
        <Dock bookId={bookId} text={text} visible={visible} place={place} folioAt={folioAt} inset={inset} title={title} menu={menu} onContents={onContents} c={c} />
      ) : (
        <>
          {bar && <ListeningBar bookId={bookId} text={text} visible={visible} c={c} />}
          <footer className="flex h-9 shrink-0 items-center gap-3 px-4">
            <ProgressLine fraction={progress} className="flex-1" />
            <span className="text-xs/4 text-ink-3 tabular-nums">{Math.round(progress * 100)}%</span>
          </footer>
        </>
      )}
    </div>
  );
}

/** A place from a point in the drawn text: the line's block, the fragment's offset. */
function placeAt(node: Node | null, offset: number): TextPlace | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const frag = el?.closest<HTMLElement>("[data-start]");
  const line = el?.closest<HTMLElement>("[data-block]");
  if (!line) return null;
  const section = Number(line.dataset.section);
  const block = Number(line.dataset.block);
  if (!frag) return { section, block, offset: Number(line.dataset.start ?? 0) };
  const gap = frag.dataset.gap === "1" ? 1 : 0;
  return { section, block, offset: Number(frag.dataset.start) + Math.max(0, (node === frag ? 0 : offset) - gap) };
}

const Pages = memo(function Pages({ bookId, fits, text, place, metrics, viewport, layout, engine, marks, c, onVisible }: { bookId: string; fits: string; text: BookText; place: TextPlace; metrics: Metrics; viewport: { width: number; height: number }; layout: (s: number) => SectionLayout | undefined; engine: LayoutEngine; marks: readonly Marked[]; c: AppController; onVisible: (v: Visible) => void }) {
  const l = layout(place.section) ?? NOT_YET;
  const at = pageOf(l.pages, place);
  const per = metrics.columns;
  const first = at - (at % per);
  const shown = l.pages.slice(first, first + per);
  const lastShown = shown[shown.length - 1];
  useEffect(() => {
    if (shown[0] && lastShown) onVisible({ from: { section: place.section, ...shown[0].start }, to: { section: place.section, ...lastShown.end } });
  });

  const go = useCallback(
    async (step: 1 | -1, at?: number) => {
      perf.begin("page turn", at);
      const cur = layout(place.section);
      if (!cur) return;
      const here = pageOf(cur.pages, place);
      const start = here - (here % per);
      const target = start + step * per;
      if (target >= 0 && target < cur.pages.length) {
        c.moveReading({ section: place.section, ...cur.pages[target]!.start });
        return;
      }
      const next = neighbour(text.ebook, place.section, step);
      if (next === null) return;
      if (step === 1) c.moveReading({ section: next, block: 0, offset: 0 });
      else {
        const prev = await engine.request(next);
        const last = prev.pages.length - 1;
        c.moveReading({ section: next, ...prev.pages[last - (last % per)]!.start });
      }
    },
    [c, text, layout, engine, per, place],
  );

  /** The spread a step away: in this chapter, or the next chapter's first or the previous one's last (empty until it is laid out). Null at the ends of the book. */
  const spreadAt = (step: 1 | -1): { l: SectionLayout; first: number } | null => {
    const target = first + step * per;
    if (target >= 0 && target < l.pages.length) return { l, first: target };
    const s = neighbour(text.ebook, place.section, step);
    if (s === null) return null;
    const other = layout(s);
    if (!other) return { l: NOT_YET, first: 0 };
    const last = other.pages.length - 1;
    return { l: other, first: step === 1 ? 0 : last - (last % per) };
  };
  const next = spreadAt(1);
  const prev = spreadAt(-1);
  // A turn shows its page first; a neighbour not drawn yet is drawn just after, so the turn never waits on it.
  const here = `${place.section}:${first}`;
  const [neighboursFor, setNeighboursFor] = useState(here);
  const drawn = useRef(new Set<string>());
  const keyOf = (s: { l: SectionLayout; first: number }, side: number) => (s.l === NOT_YET ? `waiting ${side}` : `${s.l.flow.section}:${s.first}`);
  const showNow = (s: { l: SectionLayout; first: number } | null, side: number) => (s && (neighboursFor === here || drawn.current.has(keyOf(s, side))) ? s : null);
  useEffect(() => {
    if (neighboursFor === here) return;
    let task: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => (task = setTimeout(() => setNeighboursFor(here), 0)));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(task);
    };
  }, [here, neighboursFor]);
  const spreads = [
    { spread: { l, first }, side: 0 },
    { spread: showNow(next, 1), side: 1 },
    { spread: showNow(prev, -1), side: -1 },
  ];
  useLayoutEffect(() => {
    drawn.current = new Set(spreads.flatMap(({ spread, side }) => (spread ? [keyOf(spread, side)] : [])));
  });

  const track = useRef<HTMLDivElement>(null);
  const swipe = usePageSwipe({ track, width: viewport.width, has: (step) => (step === 1 ? next : prev) !== null, turn: (step) => void go(step) });
  // A mouse turns on the press, not the click: a tenth of a second sooner. Its click then does nothing.
  const pressed = useRef(false);
  const onEdge = (step: 1 | -1) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      pressed.current = true;
      void go(step, e.timeStamp);
    },
    onClick: (e: React.MouseEvent) => {
      if (pressed.current || swipe.justSwiped()) return void (pressed.current = false);
      void go(step, e.timeStamp);
    },
  });

  // The page a turn asked for is committed: measured to the frame that shows it. The first is the reader opening.
  const shownSection = useRef<number | null>(null);
  useLayoutEffect(() => {
    swipe.settled();
    if (shownSection.current === null) perf.end("open the reader");
    else perf.end("page turn", shownSection.current === place.section ? "page turn" : "page turn into a chapter");
    shownSection.current = place.section;
  }, [place.section, first]);

  // This chapter first, then the ones on either side, then the rest of the book outward from here.
  useEffect(() => wantAround(engine, text, place.section), [engine, text, place.section]);

  // The snapshot the book opens to next time (snapshot.ts): the chapter once it is laid out, the place on every turn.
  // The chapter is kept a moment after it arrives, off the turn into it, or as the reader closes if that comes first:
  // a book closed just after its chapter arrived opens to it all the same.
  const laidOut = l === NOT_YET || !engine.isFresh(place.section) ? null : l;
  const unkept = useRef<PageSnapshot | null>(null);
  const keepPage = useCallback(() => {
    if (unkept.current) savePage(bookId, unkept.current);
    unkept.current = null;
  }, [bookId]);
  useEffect(() => {
    unkept.current = laidOut ? { fits, key: engine.specKey, section: place.section, chars: text.ebook.sections[place.section]?.chars ?? 0, layout: laidOut } : null;
    if (!laidOut) return;
    const id = setTimeout(keepPage, 400);
    return () => clearTimeout(id);
    // The place within the chapter is saved below, on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fits, engine, laidOut, keepPage]);
  useEffect(() => () => keepPage(), [keepPage]);
  useEffect(() => {
    if (laidOut) savePlace(bookId, { place, progress: text.progress(place) });
  }, [bookId, text, place, laidOut]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        go(1, e.timeStamp);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        go(-1, e.timeStamp);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void c.closeReading();
      } else if (e.key === "k" && c.getState().current) {
        e.preventDefault();
        c.togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, c]);

  return (
    <div
      className="absolute inset-0 overflow-hidden select-text"
      // The page is the browser's to scroll or zoom no more: a finger turns it.
      style={{ fontFamily: FAMILY, touchAction: "none" }}
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
      onWheel={swipe.onWheel}
    >
      <div ref={track} className="absolute inset-0 will-change-transform">
        {/* Keyed by the pages they show, so after a turn the neighbour already drawn moves to the middle as it is. */}
        {spreads.map(({ spread, side }) =>
          spread ? (
            <div key={keyOf(spread, side)} aria-hidden={side !== 0 || undefined} inert={side !== 0} className="absolute inset-y-0" style={{ left: side * viewport.width, width: viewport.width }}>
              <Spread l={spread.l} first={spread.first} metrics={metrics} viewport={viewport} marks={marks} text={text} c={c} />
            </div>
          ) : null,
        )}
      </div>
      {/* The edges turn the page for a mouse. A finger swipes, and its taps belong to the text. */}
      <button type="button" aria-label="Previous page" data-perf="previous page" tabIndex={-1} className="absolute inset-y-0 left-0 w-[12%] cursor-w-resize focus:outline-none pointer-coarse:hidden" {...onEdge(-1)} />
      <button type="button" aria-label="Next page" data-perf="next page" tabIndex={-1} className="absolute inset-y-0 right-0 w-[12%] cursor-e-resize focus:outline-none pointer-coarse:hidden" {...onEdge(1)} />
    </div>
  );
});

/** The pages showing, one or two side by side, centred in the reading area: the same for the real page and its snapshot. */
function Spread({ l, first, metrics, viewport, marks, text, c }: { l: SectionLayout; first: number; metrics: Metrics; viewport: { width: number; height: number }; marks: readonly Marked[]; text: BookText | null; c: AppController }) {
  const per = metrics.columns;
  const width = per * metrics.column + (per - 1) * metrics.gap;
  const left = Math.max(0, Math.round((viewport.width - width) / 2));
  return l.pages.slice(first, first + per).map((page, i) => (
    <div key={`${page.section}:${first + i}`} className="absolute" style={{ top: metrics.margin, left: left + i * (metrics.column + metrics.gap), width: metrics.column, height: metrics.pageHeight }}>
      {page.items.map((it) => (
        <Item key={`${it.at}:${it.line}`} b={l.blocks[it.at]!} it={it} column={metrics.column} marks={markOf(marks, l.blocks[it.at]!)} text={text} c={c} />
      ))}
    </div>
  ));
}

/**
 * While a book opens: the page you left, drawn from its snapshot
 * (snapshot.ts) the moment you open it, in the same place the real page
 * will draw it. Without a snapshot, or one made for another window or
 * other settings, a word that it is opening.
 */
function Opening({ bookId, settings, bar, dock }: { bookId: string; settings: ReadingSettings; bar: boolean; dock: ReactNode }) {
  const c = useController();
  const box = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setViewport({ width: el.clientWidth, height: el.clientHeight });
  }, []);
  const snap = useMemo(() => (settings.layout === "pages" && facesLoaded() ? loadSnapshot(bookId) : null), [bookId, settings.layout]);
  const fits = !!snap && !!viewport && snap.fits === fitsKey(viewport, settings);
  const metrics = fits ? metricsFor(settings, viewport!) : null;
  useLayoutEffect(() => {
    if (fits) perf.reached("open the reader", "open the reader: the page you left");
  }, [fits]);
  let page: ReactNode = <Middle>Opening the book…</Middle>;
  if (snap && metrics && viewport) {
    const at = pageOf(snap.layout.pages, snap.place);
    page = (
      <div className="absolute inset-0" style={{ fontFamily: FAMILY }}>
        <Spread l={snap.layout} first={at - (at % metrics.columns)} metrics={metrics} viewport={viewport} marks={NO_MARKS} text={null} c={c} />
      </div>
    );
  }
  // Laid out as the reading area will be, so the page is where it will stay.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={box} className="relative flex min-h-0 flex-1 flex-col">
        {page}
      </div>
      {dock ?? (
        <>
          {bar && <div className="h-14 shrink-0 border-t border-line" />}
          <footer className="flex h-9 shrink-0 items-center gap-3 px-4">
            <ProgressLine fraction={snap?.progress ?? 0} className="flex-1" />
            <span className="text-xs/4 text-ink-3 tabular-nums">{snap ? `${Math.round(snap.progress * 100)}%` : ""}</span>
          </footer>
        </>
      )}
    </div>
  );
}

const NO_MARKS: Marked[] = [];

/**
 * The whole book as one long column, chapter under chapter. Chapters not
 * laid out yet hold an estimated height (from their length) until the
 * layout engine sends them, which it does for the whole book in the
 * background.
 *
 * Only the lines near the screen are drawn: the column is cut into bands
 * half a screen tall, and a scroll draws again only when it crosses into
 * another band. Where you are is told to the app a few times a second, not on every
 * scroll event. When the column above you changes (a chapter arrives, the
 * window is resized), the view is put back on the line you were reading.
 */
const Scroll = memo(function Scroll({ text, place, metrics, layout: laid, engine, marks, c, onVisible, onScrolled }: { text: BookText; place: TextPlace; metrics: Metrics; layout: (s: number) => SectionLayout | undefined; engine: LayoutEngine; marks: readonly Marked[]; c: AppController; onVisible: (v: Visible) => void; onScrolled?: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => engine.watchAll(), [engine]);
  useEffect(() => wantAround(engine, text, place.section), [engine, text, place.section]);
  // The reading order, and the section you are in when a link took you outside it.
  const aside = text.ebook.sections[place.section]?.linear ? -1 : place.section;
  const sections = useMemo(() => text.ebook.sections.flatMap((s, i) => (s.linear || i === aside ? [i] : [])), [text, aside]);
  const column = useMemo(() => stack(text, sections, laid, metrics), [text, sections, laid, metrics]);

  /** The place at a height in the column, and the height of its line. */
  const placeAt = (y: number): { place: TextPlace; lineY: number } => {
    const i = Math.max(0, upperBound(column.tops, y) - 1);
    const s = sections[i]!;
    const l = laid(s);
    const within = y - column.tops[i]!;
    const place = l ? { section: s, ...placeAtY(l.blocks, l.flow, within) } : text.placeAtProgress(s, within / Math.max(1, column.heights[i]!));
    return { place, lineY: yAt(place) };
  };
  /** The height of a place's line in the column; a chapter not laid out yet is guessed at by how far through it the place is. */
  const yAt = (p: TextPlace): number => {
    const i = sections.indexOf(p.section);
    if (i < 0) return 0;
    const l = laid(p.section);
    return column.tops[i]! + (l ? yOfPlace(l.blocks, l.flow, p) : text.sectionProgress(p) * column.heights[i]!);
  };

  // Which band the view starts in: what is drawn is the view and a band either side.
  const band = Math.max(100, Math.round(metrics.pageHeight / 2));
  const [at, setAt] = useState(-1);
  const [, again] = useReducer((n: number) => n + 1, 0);
  // The line being read and how far the view's top is below it: kept when the column above changes.
  const anchor = useRef({ place, dy: 0 });
  const putBack = useRef(true);
  const shape = useRef(column);
  const told = useRef(place);
  const quiet = useRef(false);

  const show = () => {
    const el = scroller.current;
    if (el) onVisible({ from: anchor.current.place, to: placeAt(el.scrollTop + el.clientHeight - metrics.lineHeight).place });
  };

  // After a paint: back onto the line being read if the column moved under it, or the place was moved from elsewhere.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (shape.current !== column) {
      shape.current = column;
      putBack.current = true;
    }
    if (putBack.current) {
      putBack.current = false;
      const top = Math.max(0, Math.round(yAt(anchor.current.place) + anchor.current.dy - metrics.margin));
      if (Math.abs(el.scrollTop - top) >= 1) {
        const before = el.scrollTop;
        el.scrollTop = top;
        // The scroll this makes is not yours: it is not told to the app as a move.
        quiet.current = el.scrollTop !== before;
      }
      show();
    }
    const now = Math.floor(el.scrollTop / band);
    if (now !== at) setAt(now);
  });

  // A jump from elsewhere (the contents, a link, the narrator moving on): unless it is already at the top of the view.
  useEffect(() => {
    if (place === told.current) return;
    told.current = place;
    const el = scroller.current;
    if (!el || Math.abs(yAt(place) - (el.scrollTop + metrics.margin)) < metrics.lineHeight * 2) return;
    anchor.current = { place, dy: 0 };
    putBack.current = true;
    again();
  });

  // Where you are goes to the app a few times a second while you scroll, and once when you stop.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (pending.current && clearTimeout(pending.current)), []);
  const tell = () => {
    pending.current = null;
    show();
    const p = anchor.current.place;
    if (same(p, told.current)) return;
    told.current = p;
    c.moveReading(p, "periodic", "scroll");
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (quiet.current) {
      quiet.current = false;
      return;
    }
    perf.sampleFrames("scrolling: time between frames");
    onScrolled?.();
    const top = el.scrollTop + metrics.margin;
    const { place: p, lineY } = placeAt(top);
    anchor.current = { place: p, dy: top - lineY };
    const now = Math.floor(el.scrollTop / band);
    if (now !== at) setAt(now);
    pending.current ??= setTimeout(tell, 200);
  };

  const byHand = () => c.setFollowing(false);

  useLayoutEffect(() => perf.end("open the reader"), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        void c.closeReading();
      } else if (e.key === "k" && c.getState().current && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        c.togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    scroller.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);

  // The lines to draw: the view (three bands at most) and a band either side.
  const from = (at - 1) * band;
  const to = (at + 4) * band;
  const drawn: ReactNode[] = [];
  if (at >= 0) {
    for (let i = Math.max(0, upperBound(column.tops, from) - 1); i < sections.length && column.tops[i]! < to; i++) {
      const s = sections[i]!;
      const l = laid(s);
      if (!l) continue;
      const top = column.tops[i]!;
      drawn.push(
        <div key={s} className="absolute inset-x-0" style={{ top, contain: "layout style" }}>
          {itemsIn(l.blocks, l.flow, from - top, to - top).map((it) => (
            <Item key={`${it.at}:${it.line}`} b={l.blocks[it.at]!} it={it} column={metrics.column} marks={markOf(marks, l.blocks[it.at]!)} text={text} c={c} />
          ))}
        </div>,
      );
    }
  }

  return (
    <div
      ref={scroller}
      tabIndex={-1}
      className="absolute inset-0 overflow-y-auto quiet-scroll outline-none"
      onScroll={onScroll}
      // Scrolling by hand, by wheel, touch, keys or the scrollbar, stops following the narrator.
      onWheel={byHand}
      onTouchMove={byHand}
      onKeyDown={(e) => ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key) && byHand()}
      onPointerDown={(e) => e.target === scroller.current && byHand()}
      style={{ fontFamily: FAMILY }}
    >
      <div className="relative mx-auto" style={{ width: metrics.column, height: column.total }}>
        {drawn}
      </div>
    </div>
  );
});

/** The whole book in one column: where each section starts, how tall it is, and how tall it all is. */
interface Column {
  tops: number[];
  heights: number[];
  total: number;
}

function stack(text: BookText, sections: readonly number[], laid: (s: number) => SectionLayout | undefined, metrics: Metrics): Column {
  const between = metrics.lineHeight * 4;
  const chars = (s: number) => text.ebook.sections[s]?.chars ?? 0;
  // Height per character from the chapters laid out so far guesses at the rest.
  let height = 0;
  let counted = 0;
  for (const s of sections) {
    const l = laid(s);
    if (l) {
      height += l.flow.height;
      counted += chars(s);
    }
  }
  const perChar = counted > 0 ? height / counted : (metrics.lineHeight * metrics.size * 0.5) / metrics.column;
  const tops: number[] = [];
  const heights: number[] = [];
  let y = metrics.margin;
  for (const s of sections) {
    const h = laid(s)?.flow.height ?? Math.round(chars(s) * perChar);
    tops.push(y);
    heights.push(h);
    y += h + between;
  }
  return { tops, heights, total: y };
}

/** The first index whose value is above `y`, in values that only grow. */
function upperBound(values: readonly number[], y: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function same(a: TextPlace, b: TextPlace): boolean {
  return a.section === b.section && a.block === b.block && a.offset === b.offset;
}

/**
 * The audiobook, under the text (docs/READING.md, section 6). For this
 * book: back, play, forward, where the narrator is, and the two switches
 * of level 1 when the narrator is not on the page. For another book
 * playing: its controls, under its own title. For none: a way to start.
 */
function ListeningBar({ bookId, text, visible, c }: { bookId: string; text: BookText; visible: Visible | null; c: AppController }) {
  const { loaded, title, here, where, onPage, playing, finding, following } = useListening(bookId, text, visible, c);
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t border-line px-3 sm:px-4" role="group" aria-label="Listening">
      {loaded ? (
        <div className="flex items-center gap-1">
          <IconButton size="sm" label="Back 30 seconds" icon={BackwardIcon} onClick={() => c.skip(-30_000)} />
          <PlayButton size="sm" />
          <IconButton size="sm" label="Forward 30 seconds" icon={ForwardIcon} onClick={() => c.skip(30_000)} />
        </div>
      ) : null}
      <p className="min-w-0 flex-1 truncate text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
        {here ? where : loaded ? <>Playing <span className="text-ink">{title}</span></> : "The audiobook is not playing."}
      </p>
      {finding ? (
        <p className="shrink-0 text-sm/5 text-ink-3 sm:text-[0.8125rem]/5" aria-live="polite">
          Finding the place…
        </p>
      ) : (
        <>
          {here && onPage && (
            <Button size="sm" variant={following ? "secondary" : "ghost"} aria-pressed={following} onClick={() => (following ? c.setFollowing(false) : void c.goToNarrator())}>
              Follow along
            </Button>
          )}
          {here && !onPage && (
            <Button size="sm" variant="ghost" onClick={() => void c.goToNarrator()}>
              Go to the narrator
            </Button>
          )}
          {(!here || !onPage) && (
            <Button size="sm" variant={here && playing ? "secondary" : "primary"} onClick={() => void c.listenFromHere()}>
              Listen from here
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** The mark, when it is in this block. */
function markOf(marks: readonly Marked[], b: LaidBlock): Span[] {
  return marks.length === 0 ? NO_SPANS : spansIn(marks, b.section, b.block);
}

const NO_SPANS: Span[] = [];

/**
 * The sentence a tap would listen from, or being read, is washed in amber,
 * strongly enough to follow at a glance while the words keep a contrast of
 * 10:1 or more. Amber on a light page needs more of it to read as strongly
 * as on a dark one. Words bookmarked are underlined in amber, and washed
 * faintly.
 */
function marked(on: Tone[]): string | undefined {
  if (on.length === 0) return undefined;
  const sentence = on.includes("sentence");
  return clsx("rounded-[2px] box-decoration-clone", sentence ? "bg-place/32 dark:bg-place/24" : "bg-place/8", on.includes("saved") && "underline decoration-place/70 decoration-2 underline-offset-[0.2em]");
}

/** One line of a block (or an image, or a break), drawn where the layout put it. Drawn again only when its marks change. */
const Item = memo(function Item({ b, it, column, marks, text, c }: { b: LaidBlock; it: Placed; column: number; marks: Span[]; text: BookText | null; c: AppController }) {
  if (b.kind === "img" && b.image) {
    // In the dark, line art turns light with its hues kept, and pictures dim so they do not glare.
    const dark = b.image.tone === "ink" ? "dark:invert dark:hue-rotate-180" : "dark:brightness-85";
    return <img src={c.readingImageUrl(b.image.src)} alt={b.image.alt} draggable={false} className={`absolute select-none ${dark}`} style={{ top: it.y, left: Math.round((column - b.image.width) / 2), width: b.image.width, height: b.image.height }} />;
  }
  if (b.kind === "hr") {
    return (
      <div aria-hidden="true" className="absolute inset-x-0 flex items-center justify-center text-ink-3" style={{ top: it.y, height: b.lineHeight, fontSize: b.size }}>
        ⁂
      </div>
    );
  }
  const line = b.lines[it.line]!;
  const first = it.line === 0;
  const last = it.line === b.lines.length - 1;
  const indent = first ? b.indent : 0;
  const align = b.align === "justify" ? (last ? "left" : "justify") : b.align === "center" ? "center" : b.align === "end" ? "right" : "left";
  const style: CSSProperties = {
    top: it.y,
    left: b.inset + indent,
    width: column - 2 * b.inset - indent,
    height: b.lineHeight,
    lineHeight: `${b.lineHeight}px`,
    fontSize: b.size,
    fontWeight: b.kind === "h" ? 500 : 400,
    textAlign: align,
    textAlignLast: align,
    whiteSpace: b.kind === "pre" ? "pre" : "nowrap",
    // Each line is laid out on its own: one drawn or dropped leaves the others alone.
    contain: "layout style",
  };
  return (
    <div className="absolute" style={style} data-section={b.section} data-block={b.block} data-start={line.start}>
      {line.frags.map((f, k) => {
        const s: CSSProperties = {};
        if (f.i) s.fontStyle = "italic";
        if (f.b) s.fontWeight = 650;
        if (f.sc) s.fontVariantCaps = "small-caps";
        if (f.sup || f.sub) Object.assign(s, { fontSize: "0.7em", lineHeight: 0, verticalAlign: f.sup ? "super" : "sub" });
        const pieces = cut(f.start, f.text, !!f.gap, marks);
        const inner =
          pieces.length === 1 && pieces[0]!.on.length === 0
            ? (f.gap ? " " : "") + f.text
            : pieces.map((p, j) => (
                <span key={j} data-start={p.start} data-gap={p.gap ? "1" : undefined} data-mark={p.on.includes("sentence") ? "sentence" : undefined} className={marked(p.on)}>
                  {(p.gap ? " " : "") + p.text}
                </span>
              ));
        if (f.href) {
          const target = f.href.startsWith("http") || !text ? null : text.fromHref(f.href);
          return (
            <span key={k} data-link data-start={f.start} data-gap={f.gap ? "1" : undefined} style={s} className={clsx(target && "cursor-pointer underline decoration-line-strong underline-offset-2 hover:decoration-ink-2")} onClick={target ? () => c.moveReading(target, "seek") : undefined}>
              {inner}
            </span>
          );
        }
        return (
          <span key={k} data-start={f.start} data-gap={f.gap ? "1" : undefined} style={s}>
            {inner}
          </span>
        );
      })}
    </div>
  );
});
