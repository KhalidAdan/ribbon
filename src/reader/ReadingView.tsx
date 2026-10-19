import { ArrowLeftIcon, BackwardIcon, ForwardIcon, ListBulletIcon, PlayIcon, SpeakerWaveIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Ebook } from "../core/ebook";
import { flow, pageOf, paginate, placeAtY, yOfPlace, type Flow, type LaidBlock, type Page, type Placed } from "../core/reading/pages";
import { bookProgress, placeOfHref, tocEntryAt, textBetween, type TextPlace } from "../core/reading/place";
import { LEADINGS, MEASURES, metricsFor, SIZES, type Metrics, type ReadingSettings } from "../core/reading/typography";
import type { AppController } from "../app/controller";
import { useAppState, useController } from "../ui/store";
import { Button, IconButton } from "../ui/Button";
import { Drawer } from "../ui/Drawer";
import { ProgressLine, Toggle } from "../ui/kit";
import { FAMILY, loadFaces, Typesetter } from "./typeset";
import { PlayButton } from "../ui/PlayerBar";
import { formatLeft } from "../core/speed";
import { chapterAt } from "../core/scan/chapters";
import { globalOffset, type Alignment } from "../core/reading/align";
import { sentenceAt, type Sentence } from "../core/reading/sentences";
import { cut } from "./marks";

/** A sentence marked in the text: the one a tap would listen from, or the one being read aloud. */
interface Mark extends Sentence {
  section: number;
  block: number;
}

/** What the reader shows: from the first character on screen to the last. */
interface Visible {
  from: TextPlace;
  to: TextPlace;
}

interface SectionLayout {
  blocks: LaidBlock[];
  pages: Page[];
  flow: Flow;
}

/**
 * The reader (docs/READING.md): the book's EPUB, typeset by Ribbon with
 * pretext, in pages or one long column. Over everything; the place is kept
 * as the reader moves.
 */
export function ReadingView() {
  const state = useAppState();
  const c = useController();
  const r = state.reading;
  const [contents, setContents] = useState(false);
  const [type, setType] = useState(false);
  // The listening bar shows itself while this book's audio is loaded; the header button shows or hides it either way.
  const [barPref, setBarPref] = useState<"auto" | "shown" | "hidden">("auto");
  if (!r) return null;
  const book = state.books.find((b) => b.book.id === r.bookId);
  const ebook = r.ebook;
  const place = r.place;
  const entry = ebook && place ? tocEntryAt(ebook, place) : -1;
  const chapter = ebook && entry >= 0 ? ebook.toc[entry]!.label : "";
  const loadedHere = state.current?.book.book.id === r.bookId;
  const barOpen = barPref === "shown" || (barPref === "auto" && loadedHere);

  return (
    <div role="dialog" aria-modal="true" aria-label={`Reading ${book?.book.title ?? "a book"}`} className="fixed inset-0 z-30 flex flex-col bg-canvas text-ink">
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
        <div className="relative">
          <Button variant={type ? "secondary" : "ghost"} aria-expanded={type} aria-haspopup="dialog" disabled={!ebook} onClick={() => setType((v) => !v)}>
            <span aria-hidden="true" className="font-serif text-base/5">
              Aa
            </span>
            <span className="sr-only">Text settings</span>
          </Button>
          {type && <TypeSettings settings={state.readingSettings} onChange={(p) => c.setReadingSettings(p)} onClose={() => setType(false)} />}
        </div>
      </header>

      {r.status === "opening" && <Middle>Opening the book…</Middle>}
      {r.status === "failed" && (
        <Middle>
          <p className="text-base/6 font-medium text-ink sm:text-sm/5">This book’s text could not be opened</p>
          <p className="mt-1 max-w-md text-base/6 text-ink-2 sm:text-sm/5">{r.message}</p>
        </Middle>
      )}
      {r.status === "ready" && ebook && place && <Text key={ebook.meta.title + r.bookId} bookId={r.bookId} ebook={ebook} place={place} settings={state.readingSettings} bar={barOpen} listen={!!r.alignment && !!book && book.book.durationMs > 0} c={c} />}

      {ebook && (
        <Drawer open={contents} onClose={() => setContents(false)} title="Contents">
          <Contents ebook={ebook} alignment={r.alignment} listening={r.listening} entry={entry} c={c} onGo={() => setContents(false)} />
        </Drawer>
      )}
    </div>
  );
}

/** Below this, a pair is shown as a guess. */
const UNSURE = 0.4;

/**
 * The contents, each entry with the audio chapter it is paired with.
 * Fixing the pairing puts a choice on each entry: automatic, not in the
 * audio, or a chapter of the recording; it is kept beside the book.
 */
function Contents({ ebook, alignment, listening, entry, c, onGo }: { ebook: Ebook; alignment: Alignment | undefined; listening: { done: number; total: number; what: "openings" | "checkpoints" } | undefined; entry: number; c: AppController; onGo: () => void }) {
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
            {listening ? `${listening.what === "openings" ? "Listening to chapter openings" : "Placing checkpoints"}… ${listening.done} of ${listening.total}` : paired ? "Paired with the audiobook’s chapters" : "Matched to the audiobook by length"}
          </p>
          <Button size="sm" variant={fixing ? "secondary" : "ghost"} aria-pressed={fixing} onClick={() => setFixing((v) => !v)}>
            {fixing ? "Done" : "Fix pairing"}
          </Button>
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

function Middle({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-base/6 text-ink-2 sm:text-sm/5">{children}</div>;
}

/** The type settings, under the Aa button. */
function TypeSettings({ settings, onChange, onClose }: { settings: ReadingSettings; onChange: (p: Partial<ReadingSettings>) => void; onClose: () => void }) {
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
    <div ref={ref} role="dialog" aria-label="Text settings" className="absolute top-full right-0 z-10 mt-2 flex w-72 flex-col gap-4 rounded-[10px] bg-surface p-4 shadow-lg ring-1 ring-line dark:shadow-none dark:ring-line-strong">
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
        <Toggle label="Justify the text" checked={settings.justify} onChange={(justify) => onChange({ justify })} />
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

/** Lay out sections on demand, remembering each for the current metrics. */
function useLayout(ebook: Ebook, settings: ReadingSettings, viewport: { width: number; height: number } | null, c: AppController) {
  const typesetter = useMemo(() => new Typesetter(ebook, (src) => c.readingImageUrl(src)), [ebook, c]);
  const metrics = useMemo(() => (viewport ? metricsFor(settings, viewport) : null), [settings, viewport]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    setReady(false);
    if (!metrics) return;
    void loadFaces(metrics.size).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [metrics?.size, metrics]);
  const cache = useRef(new Map<number, SectionLayout>());
  // Without hyphenation, justified lines in a narrow column open rivers: narrow columns stay ragged.
  const justify = !!metrics && settings.justify && metrics.column >= metrics.size * 24;
  const key = metrics ? `${metrics.size}:${metrics.lineHeight}:${metrics.column}:${metrics.pageHeight}:${justify}` : "";
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    keyRef.current = key;
    cache.current = new Map();
  }
  const layout = useCallback(
    (section: number): SectionLayout => {
      let l = cache.current.get(section);
      if (!l) {
        const blocks = typesetter.section(section, metrics!, justify);
        l = { blocks, pages: paginate(section, blocks, metrics!.pageHeight, Math.round(metrics!.pageHeight * 0.12)), flow: flow(section, blocks) };
        cache.current.set(section, l);
      }
      return l;
    },
    // The key carries the metrics and justification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typesetter, key],
  );
  return { metrics, ready: ready && !!metrics, layout };
}

/** The next and previous sections in the reading order. */
function neighbour(ebook: Ebook, section: number, step: 1 | -1): number | null {
  for (let s = section + step; s >= 0 && s < ebook.sections.length; s += step) if (ebook.sections[s]!.linear) return s;
  return null;
}

function Text({ bookId, ebook, place, settings, bar, listen, c }: { bookId: string; ebook: Ebook; place: TextPlace; settings: ReadingSettings; bar: boolean; listen: boolean; c: AppController }) {
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
  const { metrics, ready, layout } = useLayout(ebook, settings, viewport, c);
  const progress = bookProgress(ebook, place);

  // A tap on the text offers to listen from the sentence tapped, marked until the offer goes.
  const [tap, setTap] = useState<{ mark: Mark; x: number; y: number } | null>(null);
  useEffect(() => setTap(null), [place, settings]);
  useEffect(() => {
    if (!tap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setTap(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tap]);
  const onClick = (e: React.MouseEvent) => {
    if (!listen) return;
    const t = e.target as HTMLElement;
    if (tap) {
      if (!t.closest("[data-tap]")) setTap(null);
      return;
    }
    if (t.closest("button, [data-link]") || !t.closest("[data-block]")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const p = range ? placeAt(range.startContainer, range.startOffset) : null;
    const sentence = p && sentenceAt(ebook, p);
    const rect = box.current?.getBoundingClientRect();
    if (!p || !sentence || !rect) return;
    const line = t.closest("[data-block]")!.getBoundingClientRect();
    setTap({ mark: { section: p.section, block: p.block, ...sentence }, x: e.clientX - rect.left, y: line.bottom - rect.top });
  };
  const mark = tap?.mark ?? null;
  const dropTap = useCallback(() => setTap((t) => (t ? null : t)), []);

  // Copying gives back the book's text, paragraphs whole, not the drawn lines.
  const onCopy = (e: React.ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const a = placeAt(sel.anchorNode, sel.anchorOffset);
    const b = placeAt(sel.focusNode, sel.focusOffset);
    if (!a || !b) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", textBetween(ebook, a, b));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={box} className="relative min-h-0 flex-1" onCopy={onCopy} onClick={onClick}>
        {ready && metrics && viewport && (settings.layout === "pages" ? <Pages ebook={ebook} place={place} metrics={metrics} viewport={viewport} layout={layout} mark={mark} c={c} onVisible={onVisible} /> : <Scroll ebook={ebook} place={place} metrics={metrics} layout={layout} mark={mark} c={c} onVisible={onVisible} onScrolled={dropTap} />)}
        {tap && viewport && (
          <div data-tap className="absolute z-10" style={{ left: Math.max(8, Math.min(viewport.width - 168, tap.x - 80)), top: tap.y + 6 }}>
            <Button
              size="sm"
              leading={PlayIcon}
              className="shadow-lg"
              onClick={() => {
                const { section, block, start } = tap.mark;
                setTap(null);
                void c.listenFromHere({ section, block, offset: start });
              }}
            >
              Listen from here
            </Button>
          </div>
        )}
      </div>
      {bar && <ListeningBar bookId={bookId} ebook={ebook} visible={visible} c={c} />}
      <footer className="flex h-9 shrink-0 items-center gap-3 px-4">
        <ProgressLine fraction={progress} className="flex-1" />
        <span className="text-xs/4 text-ink-3 tabular-nums">{Math.round(progress * 100)}%</span>
      </footer>
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

const Pages = memo(function Pages({ ebook, place, metrics, viewport, layout, mark, c, onVisible }: { ebook: Ebook; place: TextPlace; metrics: Metrics; viewport: { width: number; height: number }; layout: (s: number) => SectionLayout; mark: Mark | null; c: AppController; onVisible: (v: Visible) => void }) {
  const l = layout(place.section);
  const at = pageOf(l.pages, place);
  const per = metrics.columns;
  const first = at - (at % per);
  const shown = l.pages.slice(first, first + per);
  const lastShown = shown[shown.length - 1];
  useEffect(() => {
    if (shown[0] && lastShown) onVisible({ from: { section: place.section, ...shown[0].start }, to: { section: place.section, ...lastShown.end } });
  });

  const go = useCallback(
    (step: 1 | -1) => {
      const cur = layout(place.section);
      const here = pageOf(cur.pages, place);
      const start = here - (here % per);
      const target = start + step * per;
      if (target >= 0 && target < cur.pages.length) {
        c.moveReading({ section: place.section, ...cur.pages[target]!.start });
        return;
      }
      const next = neighbour(ebook, place.section, step);
      if (next === null) return;
      if (step === 1) c.moveReading({ section: next, block: 0, offset: 0 });
      else {
        const prev = layout(next);
        const last = prev.pages.length - 1;
        c.moveReading({ section: next, ...prev.pages[last - (last % per)]!.start });
      }
    },
    [c, ebook, layout, per, place],
  );

  // Lay out the chapters on either side while the reader reads, so turning into them never waits.
  useEffect(() => {
    const id = setTimeout(() => {
      for (const s of [neighbour(ebook, place.section, 1), neighbour(ebook, place.section, -1)]) if (s !== null) layout(s);
    }, 120);
    return () => clearTimeout(id);
  }, [ebook, layout, place.section]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        go(-1);
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

  const width = per * metrics.column + (per - 1) * metrics.gap;
  const left = Math.max(0, Math.round((viewport.width - width) / 2));
  return (
    <div className="absolute inset-0 select-text" style={{ fontFamily: FAMILY }}>
      {shown.map((page, i) => (
        <div key={`${page.section}:${first + i}`} className="absolute" style={{ top: metrics.margin, left: left + i * (metrics.column + metrics.gap), width: metrics.column, height: metrics.pageHeight }}>
          {page.items.map((it) => (
            <Item key={`${it.at}:${it.line}`} b={l.blocks[it.at]!} it={it} column={metrics.column} mark={markOf(mark, l.blocks[it.at]!)} ebook={ebook} c={c} />
          ))}
        </div>
      ))}
      <button type="button" aria-label="Previous page" tabIndex={-1} className="absolute inset-y-0 left-0 w-[12%] cursor-w-resize focus:outline-none" onClick={() => go(-1)} />
      <button type="button" aria-label="Next page" tabIndex={-1} className="absolute inset-y-0 right-0 w-[12%] cursor-e-resize focus:outline-none" onClick={() => go(1)} />
      <p className="absolute right-0 bottom-1 left-0 text-center text-xs/4 text-ink-3 tabular-nums" aria-live="polite">
        {first + 1}
        {per === 2 && first + 1 < l.pages.length ? `–${first + 2}` : ""} of {l.pages.length}
      </p>
    </div>
  );
});

/** The sections in view while scrolling: the one being read and its neighbours, stacked. */
const Scroll = memo(function Scroll({ ebook, place, metrics, layout, mark, c, onVisible, onScrolled }: { ebook: Ebook; place: TextPlace; metrics: Metrics; layout: (s: number) => SectionLayout; mark: Mark | null; c: AppController; onVisible: (v: Visible) => void; onScrolled?: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [center, setCenter] = useState(place.section);
  const sections = [neighbour(ebook, center, -1), center, neighbour(ebook, center, 1)].filter((s): s is number => s !== null);
  const between = metrics.lineHeight * 4;
  const tops: number[] = [];
  let y = metrics.margin;
  for (const s of sections) {
    tops.push(y);
    y += layout(s).flow.height + between;
  }
  const total = y;
  const offsetOf = (s: number) => tops[sections.indexOf(s)] ?? 0;
  // Where the scroll should be after the next paint: a section and how far into it.
  const anchor = useRef<{ section: number; y: number } | null>({ section: place.section, y: yOfPlace(layout(place.section).blocks, layout(place.section).flow, place) });
  const lastPlace = useRef(place);

  // A jump from elsewhere (the contents, a link) moves the scroll.
  useEffect(() => {
    const was = lastPlace.current;
    lastPlace.current = place;
    if (was === place) return;
    const el = scroller.current;
    if (!el) return;
    const viewTop = el.scrollTop + metrics.margin;
    const inView = sections.includes(place.section) && Math.abs(offsetOf(place.section) + yOfPlace(layout(place.section).blocks, layout(place.section).flow, place) - viewTop) < metrics.lineHeight * 2;
    if (inView) return;
    anchor.current = { section: place.section, y: yOfPlace(layout(place.section).blocks, layout(place.section).flow, place) };
    setCenter(place.section);
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a || !sections.includes(a.section)) return;
    el.scrollTop = offsetOf(a.section) + a.y - metrics.margin;
    anchor.current = null;
  });

  /** The place at a height in the stack of sections. */
  const placeAtStackY = (y: number): TextPlace => {
    let i = sections.length - 1;
    while (i > 0 && tops[i]! > y) i--;
    const l = layout(sections[i]!);
    return { section: sections[i]!, ...placeAtY(l.blocks, l.flow, y - tops[i]!) };
  };

  // What is on screen, after every paint as well as every scroll.
  useEffect(() => {
    const el = scroller.current;
    if (el) onVisible({ from: placeAtStackY(el.scrollTop + metrics.margin), to: placeAtStackY(el.scrollTop + el.clientHeight - metrics.lineHeight) });
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    onScrolled?.();
    const top = el.scrollTop + metrics.margin;
    let i = sections.length - 1;
    while (i > 0 && tops[i]! > top) i--;
    const s = sections[i]!;
    const l = layout(s);
    const p = { section: s, ...placeAtY(l.blocks, l.flow, top - tops[i]!) };
    onVisible({ from: p, to: placeAtStackY(el.scrollTop + el.clientHeight - metrics.lineHeight) });
    lastPlace.current = p;
    c.moveReading(p);
    if (s !== center) {
      // Re-centre on the section now being read, keeping the text where it is on screen.
      anchor.current = { section: s, y: top - tops[i]! };
      setCenter(s);
    }
  };

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

  return (
    <div ref={scroller} tabIndex={-1} className="absolute inset-0 overflow-y-auto quiet-scroll outline-none" onScroll={onScroll} style={{ fontFamily: FAMILY }}>
      <div className="relative mx-auto" style={{ width: metrics.column, height: total }}>
        {sections.map((s, i) => {
          const l = layout(s);
          return (
            <div key={s} className="absolute inset-x-0" style={{ top: tops[i] }}>
              {l.flow.items.map((it) => (
                <Item key={`${it.at}:${it.line}`} b={l.blocks[it.at]!} it={it} column={metrics.column} mark={markOf(mark, l.blocks[it.at]!)} ebook={ebook} c={c} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function same(a: TextPlace, b: TextPlace): boolean {
  return a.section === b.section && a.block === b.block && a.offset === b.offset;
}

/**
 * The audiobook, under the text (docs/READING.md, section 6). For this
 * book: back, play, forward, where the narrator is, and the two switches
 * of level 1 when the narrator is not on the page. For another book
 * playing: its controls, under its own title. For none: a way to start.
 */
function ListeningBar({ bookId, ebook, visible, c }: { bookId: string; ebook: Ebook; visible: Visible | null; c: AppController }) {
  const state = useAppState();
  const cur = state.current;
  const here = cur?.book.book.id === bookId;
  const p = state.player;
  const narrator = here ? c.narratorInText() : null;
  const finding = !!state.reading?.finding;
  const onPage = (() => {
    if (!narrator || !visible) return true;
    const n = globalOffset(ebook, narrator);
    return n >= globalOffset(ebook, visible.from) && n <= globalOffset(ebook, visible.to);
  })();
  let where = "";
  if (here && cur) {
    const i = chapterAt(cur.book.chapters, p.positionMs);
    const ch = i >= 0 ? cur.book.chapters[i] : undefined;
    where = ch ? `${ch.title} · ${formatLeft((ch.endMs - p.positionMs) / (p.speed || 1))} left` : `${formatLeft((p.durationMs - p.positionMs) / (p.speed || 1))} left`;
  }
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t border-line px-3 sm:px-4" role="group" aria-label="Listening">
      {cur ? (
        <div className="flex items-center gap-1">
          <IconButton size="sm" label="Back 30 seconds" icon={BackwardIcon} onClick={() => c.skip(-30_000)} />
          <PlayButton size="sm" />
          <IconButton size="sm" label="Forward 30 seconds" icon={ForwardIcon} onClick={() => c.skip(30_000)} />
        </div>
      ) : null}
      <p className="min-w-0 flex-1 truncate text-sm/5 text-ink-2 tabular-nums sm:text-[0.8125rem]/5">
        {here ? where : cur ? <>Playing <span className="text-ink">{cur.book.book.title}</span></> : "The audiobook is not playing."}
      </p>
      {finding ? (
        <p className="shrink-0 text-sm/5 text-ink-3 sm:text-[0.8125rem]/5" aria-live="polite">
          Finding the place…
        </p>
      ) : (
        <>
          {here && !onPage && (
            <Button size="sm" variant="ghost" onClick={() => void c.goToNarrator()}>
              Go to the narrator
            </Button>
          )}
          {(!here || !onPage) && (
            <Button size="sm" variant={here && p.playing ? "secondary" : "primary"} onClick={() => void c.listenFromHere()}>
              Listen from here
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** The mark, when it is in this block. */
function markOf(mark: Mark | null, b: LaidBlock): Sentence | undefined {
  return mark && mark.section === b.section && mark.block === b.block ? mark : undefined;
}

const MARKED = "rounded-[2px] bg-place/20 box-decoration-clone";

/** One line, image or break, drawn where the layout put it. */
function Item({ b, it, column, mark, ebook, c }: { b: LaidBlock; it: Placed; column: number; mark?: Sentence | undefined; ebook: Ebook; c: AppController }) {
  if (b.kind === "img" && b.image) {
    return <img src={b.image.src} alt={b.image.alt} draggable={false} className="absolute select-none" style={{ top: it.y, left: Math.round((column - b.image.width) / 2), width: b.image.width, height: b.image.height }} />;
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
  };
  return (
    <div className="absolute" style={style} data-section={b.section} data-block={b.block} data-start={line.start}>
      {line.frags.map((f, k) => {
        const s: CSSProperties = {};
        if (f.i) s.fontStyle = "italic";
        if (f.b) s.fontWeight = 650;
        if (f.sc) s.fontVariantCaps = "small-caps";
        if (f.sup || f.sub) Object.assign(s, { fontSize: "0.7em", lineHeight: 0, verticalAlign: f.sup ? "super" : "sub" });
        const pieces = cut(f.start, f.text, !!f.gap, mark);
        const inner =
          pieces.length === 1 && !pieces[0]!.on
            ? (f.gap ? " " : "") + f.text
            : pieces.map((p, j) => (
                <span key={j} data-start={p.start} data-gap={p.gap ? "1" : undefined} className={p.on ? MARKED : undefined}>
                  {(p.gap ? " " : "") + p.text}
                </span>
              ));
        if (f.href) {
          const target = f.href.startsWith("http") ? null : placeOfHref(ebook, f.href);
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
}
