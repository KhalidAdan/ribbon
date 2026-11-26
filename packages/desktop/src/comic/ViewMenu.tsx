import { AdjustmentsHorizontalIcon } from "@heroicons/react/16/solid";
import { clsx } from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ComicSettings, Ground } from "@ribbon/core/comic/settings";
import type { Fit } from "@ribbon/core/comic/size";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/kit";

/** How the pages are laid out: one at a time, two as printed, or one long scroll. */
type Layout = "one" | "two" | "scroll";

const LAYOUTS: { value: Layout; label: string }[] = [
  { value: "one", label: "One page" },
  { value: "two", label: "Two pages" },
  { value: "scroll", label: "Scroll" },
];

const FITS: { value: Fit; label: string }[] = [
  { value: "page", label: "Page" },
  { value: "width", label: "Width" },
  { value: "height", label: "Height" },
];

/** The grounds behind the page, each as its swatch shows it. Ribbon's own is the app's light or dark, whichever it is. */
const GROUNDS: { value: Ground; label: string; swatch: string }[] = [
  { value: "ribbon", label: "Ribbon", swatch: "bg-linear-to-br from-[#fafaf9] from-50% to-[#0a0a0a] to-50%" },
  { value: "black", label: "Black", swatch: "bg-black" },
  { value: "grey", label: "Grey", swatch: "bg-[#525252]" },
  { value: "white", label: "White", swatch: "bg-white" },
];

interface Props {
  settings: ComicSettings;
  rightToLeft: boolean;
  /** Whether the comic's panels are marked, so it can be read by them. */
  hasPanels: boolean;
  byPanel: boolean;
  /** How many pages: a comic of one page has nowhere to go. */
  count: number;
  /** Whether this person may mark the comic's panels (a server's comic, for its admin). */
  canMarkPanels: boolean;
  onSettings: (change: Partial<ComicSettings>) => void;
  onDirection: (rightToLeft: boolean) => void;
  onByPanel: (byPanel: boolean) => void;
  onJump: () => void;
  onMarkPanels: () => void;
  onKeys: () => void;
}

/**
 * How the comic's pages are shown (docs/COMICS.md, section 15), from the
 * View button at the top right of the reader. Every setting shows what it
 * is now, as a row of choices with the key that changes it beside its name,
 * and changes the pages at once with the panel left open, so a person can
 * try a few and see. What opens something else is under a hairline, last.
 *
 * Escape closes it and only it; a press outside closes it too.
 */
export function ViewMenu(p: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Before the reader hears it: Escape here closes the panel, not the comic.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const layout: Layout = p.settings.scroll ? "scroll" : p.settings.up;
  const scroll = p.settings.scroll;
  /** An action that opens something else: the panel goes first. */
  const then = (act: () => void) => () => {
    setOpen(false);
    act();
  };

  return (
    <div ref={ref} className="relative">
      <Button
        ref={button}
        variant="ghost"
        leading={AdjustmentsHorizontalIcon}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={clsx(open && "bg-raised text-ink")}
      >
        View
      </Button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="How the pages are shown"
          className="absolute top-full right-0 z-40 mt-1.5 flex w-76 max-w-[calc(100vw-1rem)] origin-top-right flex-col gap-4 rounded-[10px] bg-surface p-3 shadow-lg ring-1 ring-line transition-[scale,opacity] duration-150 ease-out starting:opacity-0 motion-safe:starting:scale-[0.97] dark:shadow-none dark:ring-line-strong"
        >
          <Choices
            name="layout"
            label="Layout"
            keys={["D", "S"]}
            options={LAYOUTS}
            value={layout}
            onChange={(v) => p.onSettings(v === "scroll" ? { scroll: true } : { scroll: false, up: v })}
          />
          <Choices
            name="fit"
            label="Fit"
            keys={["1", "2", "3"]}
            options={FITS}
            value={p.settings.fit}
            onChange={(fit) => p.onSettings({ fit })}
            // The scroll is a column of its own width; the fits are for turning the pages.
            disabled={scroll}
            hint={scroll ? "One long scroll is as wide as the window." : undefined}
          />
          <Choices
            name="direction"
            label="Reads"
            keys={["R"]}
            options={[
              { value: "ltr", label: "Left to right" },
              { value: "rtl", label: "Right to left" },
            ]}
            value={p.rightToLeft ? "rtl" : "ltr"}
            onChange={(v) => p.onDirection(v === "rtl")}
          />
          {p.hasPanels && (
            <Choices
              name="panels"
              label="Panels"
              keys={["P"]}
              options={[
                { value: "panels", label: "By panels" },
                { value: "whole", label: "Whole pages" },
              ]}
              value={p.byPanel ? "panels" : "whole"}
              onChange={(v) => p.onByPanel(v === "panels")}
              disabled={scroll}
            />
          )}
          <Grounds value={p.settings.ground} onChange={(ground) => p.onSettings({ ground })} />

          <div className="-mx-3 -mb-1 flex flex-col border-t border-line px-1 pt-1">
            {p.count > 1 && <Action label="Go to page…" keys={["G"]} onClick={then(p.onJump)} />}
            {p.canMarkPanels && <Action label="Mark its panels…" onClick={then(p.onMarkPanels)} />}
            <Action label="All keys…" keys={["?"]} onClick={then(p.onKeys)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** A setting's name, with the keys that change it on the right. */
function SettingName({ id, label, keys }: { id: string; label: string; keys: string[] }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p id={id} className="text-sm/5 font-medium text-ink-3 sm:text-[0.8125rem]/5">
        {label}
      </p>
      <span className="flex gap-1" aria-hidden="true">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}

/**
 * A row of choices, one of them chosen: native radio buttons, so the arrow
 * keys move along them and a screen reader says which is on, drawn as one
 * control with the chosen part lifted.
 */
function Choices<T extends string>({ name, label, keys, options, value, onChange, disabled = false, hint }: { name: string; label: string; keys: string[]; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; disabled?: boolean; hint?: string | undefined }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <SettingName id={`${id}-name`} label={label} keys={keys} />
      <div role="radiogroup" aria-labelledby={`${id}-name`} aria-describedby={hint ? `${id}-hint` : undefined} className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-md bg-raised p-0.5 ring-1 ring-line ring-inset">
        {options.map((o) => (
          <label
            key={o.value}
            className={clsx(
              "relative flex items-center justify-center rounded-[4px] px-2 py-1.5 text-center text-base/5 whitespace-nowrap text-ink-2 sm:py-1 sm:text-[0.8125rem]/5",
              "has-checked:bg-surface has-checked:text-ink has-checked:shadow-xs has-checked:ring-1 has-checked:ring-line dark:has-checked:bg-white/10 dark:has-checked:shadow-none",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-place",
              disabled ? "cursor-default text-ink-3 has-checked:text-ink-3" : "cursor-pointer hover:text-ink",
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-sm/5 text-ink-3 sm:text-xs/4">
          {hint}
        </p>
      )}
    </div>
  );
}

/** The grounds behind the page, as swatches with their names beneath. */
function Grounds({ value, onChange }: { value: Ground; onChange: (ground: Ground) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <SettingName id={`${id}-name`} label="Behind the page" keys={["B"]} />
      <div role="radiogroup" aria-labelledby={`${id}-name`} className="grid grid-cols-4 gap-2">
        {GROUNDS.map((g) => (
          <label key={g.value} className="group flex cursor-pointer flex-col items-center gap-1.5">
            <input type="radio" name="ground" value={g.value} checked={value === g.value} onChange={() => onChange(g.value)} className="sr-only" />
            <span
              aria-hidden="true"
              className={clsx(
                "h-8 w-full rounded-md ring-1 ring-line-strong ring-inset",
                g.swatch,
                "group-has-checked:outline-2 group-has-checked:outline-offset-2 group-has-checked:outline-ink group-has-focus-visible:outline-place",
              )}
            />
            <span className="text-sm/4 text-ink-3 group-hover:text-ink-2 group-has-checked:text-ink sm:text-xs/4">{g.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** Something that opens something else, with its key on the right. */
function Action({ label, keys = [], onClick }: { label: string; keys?: string[]; onClick: () => void }): ReactNode {
  return (
    <button type="button" onClick={onClick} className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-base/6 text-ink focus-ring hover:bg-raised sm:py-1.5 sm:text-sm/5">
      {label}
      {keys.length > 0 && (
        <span className="flex gap-1" aria-hidden="true">
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
    </button>
  );
}
