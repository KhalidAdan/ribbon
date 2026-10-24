import { clsx } from "clsx";
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { ChevronRightIcon, EllipsisHorizontalIcon } from "@heroicons/react/16/solid";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * The few shapes every screen is built from (docs/DESIGN.md): a section
 * header, grouped inset rows, toggles and checkboxes in ink, quiet empty
 * states, a compact menu, and the progress marks in the place colour.
 */

/** Title and one muted line on the left, the section's actions on the right. */
export function SectionHeader({ title, description, actions, id, level = 2 }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string; level?: 1 | 2 }) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <H id={id} className={clsx("font-semibold text-balance text-ink", level === 1 ? "text-xl" : "text-base/6 sm:text-[0.9375rem]/6")}>
          {title}
        </H>
        {description && <p className="mt-0.5 max-w-[65ch] text-base/6 text-pretty text-ink-2 sm:text-sm/6">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A group of rows in an inset card: a small label above, an outer ring,
 * and rows one step lighter inside it with concentric corners.
 */
export function Group({ label, children, footer, className }: { label?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <p className="mb-2 px-1 text-sm/5 font-medium text-ink-3 sm:text-[0.8125rem]/5">{label}</p>}
      <div className="flex flex-col gap-1 rounded-[10px] bg-surface p-1 ring-1 ring-line">{children}</div>
      {footer && <div className="mt-2 px-1 text-sm/5 text-pretty text-ink-3 sm:text-[0.8125rem]/5">{footer}</div>}
    </div>
  );
}

interface RowProps {
  title: ReactNode;
  description?: ReactNode;
  /** What sits on the right: a value, a control, a button. */
  aside?: ReactNode;
  /** Makes the whole row a button with a chevron. */
  onClick?: () => void;
  leading?: ReactNode;
  className?: string;
}

/** One row of a group. A row with onClick is a button and shows a chevron. */
export function Row({ title, description, aside, onClick, leading, className }: RowProps) {
  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base/6 font-medium text-ink sm:text-sm/5">{title}</span>
        {description && <span className="mt-0.5 block text-sm/5 text-pretty text-ink-2 sm:text-[0.8125rem]/5">{description}</span>}
      </span>
      {aside !== undefined && <span className="flex shrink-0 items-center gap-2 text-base/6 text-ink-2 tabular-nums sm:text-sm/5">{aside}</span>}
      {onClick && <ChevronRightIcon className="size-4 shrink-0 fill-ink-3" aria-hidden="true" />}
    </>
  );
  const cls = clsx("flex min-h-11 items-center gap-3 rounded-md bg-raised px-3 py-2.5 text-left", className);
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={clsx(cls, "w-full focus-ring hover:bg-line")}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** A switch: a native checkbox styled by its own state, in ink. */
export function Toggle({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; id?: string; disabled?: boolean }) {
  const auto = useId();
  return (
    <div className="group relative inline-flex w-11 shrink-0 rounded-full bg-line-strong p-0.5 outline-offset-2 outline-place transition-colors duration-200 ease-in-out has-checked:bg-primary has-focus-visible:outline-2 has-disabled:opacity-40 sm:w-9">
      <span className="aspect-square w-1/2 rounded-full bg-surface shadow-xs ring-1 ring-black/5 transition-transform duration-200 ease-in-out group-has-checked:translate-x-full dark:bg-canvas dark:shadow-none dark:ring-0" />
      <input
        id={id ?? auto}
        type="checkbox"
        role="switch"
        aria-label={label}
        name={id ?? auto}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="absolute inset-0 size-full cursor-pointer appearance-none focus:outline-hidden disabled:cursor-default"
      />
    </div>
  );
}

/** A checkbox in ink. Label it with `id` and a <label htmlFor>, or with `label`. */
export function Checkbox({ checked, onChange, id, label, name }: { checked: boolean; onChange: () => void; id?: string; label?: string; name?: string }) {
  return (
    <span className="group inline-grid size-5 shrink-0 grid-cols-1 sm:size-4">
      <input
        id={id}
        name={name ?? id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="col-start-1 row-start-1 appearance-none rounded-sm border border-line-strong bg-surface checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-place forced-colors:appearance-auto"
      />
      <svg viewBox="0 0 14 14" fill="none" className="pointer-events-none col-start-1 row-start-1 size-7/8 self-center justify-self-center stroke-on-primary">
        <path d="M3 8L6 11L11 3.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-not-has-checked:opacity-0" />
      </svg>
    </span>
  );
}

/** One quiet icon, one bold line, one muted line, at most one action. */
export function EmptyState({ icon: Glyph, title, children, action, compact = false }: { icon?: Icon; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={clsx("flex flex-col items-center px-6 text-center", compact ? "py-8" : "py-14")}>
      {Glyph && <Glyph className="size-4 fill-ink-3" aria-hidden="true" />}
      <p className="mt-2 text-base/6 font-medium text-ink sm:text-sm/5">{title}</p>
      {children && <p className="mt-1 max-w-[42ch] text-base/6 text-pretty text-ink-2 sm:text-sm/5">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A small outlined label. */
export function Badge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "place" }) {
  return (
    <span className={clsx("inline-flex items-center rounded-[5px] px-1.5 py-px text-xs/5 font-medium ring-1 ring-inset", tone === "place" ? "text-place ring-place/40" : "text-ink-2 ring-line-strong")}>
      {children}
    </span>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** How wide a menu's list opens (min-w-44): its button's own box is too narrow for the list to be any wider. */
const MENU_WIDTH = 176;

/** A "more" button that opens a compact list of actions under a muted label. The phone reader's dock gives it its own glyph and a 40px button. */
export function Menu({ label, items, title = "Actions", align = "right", icon: Glyph = EllipsisHorizontalIcon, size = "sm" }: { label: string; items: MenuItem[]; title?: string; align?: "left" | "right"; icon?: Icon; size?: "sm" | "dock" }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [side, setSide] = useState(align);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          // Open upward when the window has no room below for the list, and the other way when it has no room on the side asked for.
          const r = ref.current?.getBoundingClientRect();
          setUp(!!r && window.innerHeight - r.bottom < 40 + items.length * 34 && r.top > window.innerHeight - r.bottom);
          setSide(!r ? align : align === "left" && r.left + MENU_WIDTH > window.innerWidth - 8 ? "right" : align === "right" && r.right - MENU_WIDTH < 8 ? "left" : align);
          setOpen((v) => !v);
        }}
        className={clsx("relative inline-flex items-center justify-center rounded-md text-ink-2 focus-ring hover:bg-raised hover:text-ink", size === "dock" ? "size-10" : "p-[5px]", open && "bg-raised text-ink")}
      >
        <span className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true" />
        <Glyph className={clsx(size === "dock" ? "size-5" : "size-4", "fill-current")} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={title} className={clsx("absolute z-30 min-w-44", up ? "bottom-full mb-1" : "top-full mt-1", "rounded-[10px] bg-surface p-1 shadow-lg ring-1 ring-line dark:shadow-none dark:ring-line-strong", side === "right" ? "right-0" : "left-0")}>
          <p className="px-2.5 pt-1.5 pb-1 text-xs/5 font-medium text-ink-3">{title}</p>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
              className={clsx("flex w-full rounded-md px-2.5 py-1.5 text-left text-base/6 focus-ring hover:bg-raised disabled:opacity-40 sm:text-sm/5", it.danger ? "text-red-600 dark:text-red-400" : "text-ink")}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** How far along, as a hairline in the place colour. */
export function ProgressLine({ fraction, className }: { fraction: number; className?: string }) {
  return (
    <div className={clsx("h-[3px] overflow-hidden rounded-full bg-line-strong", className)} aria-hidden="true">
      <div className="h-full w-(--fraction) rounded-full bg-place" style={{ "--fraction": `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%` } as React.CSSProperties} />
    </div>
  );
}

/**
 * A series at a glance: one segment per book, finished ones solid,
 * the one you are in filled as far as you have got.
 */
export function SegmentedProgress({ parts, className }: { parts: number[]; className?: string }) {
  return (
    <div className={clsx("flex h-[3px] gap-[2px]", className)} aria-hidden="true">
      {parts.map((f, i) => (
        <div key={i} className="relative h-full min-w-[2px] flex-1 overflow-hidden rounded-[1px] bg-line-strong">
          {f > 0 && <div className="absolute inset-y-0 left-0 w-(--fraction) bg-place" style={{ "--fraction": `${(Math.min(1, f) * 100).toFixed(1)}%` } as React.CSSProperties} />}
        </div>
      ))}
    </div>
  );
}

/** A button's words, and the shorter ones a phone shows instead. */
export function Short({ phone, children }: { phone: string; children: string }) {
  return (
    <>
      <span className="sm:hidden">{phone}</span>
      <span className="max-sm:hidden">{children}</span>
    </>
  );
}

/** A keyboard key, for hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[4px] px-1 font-sans text-[0.6875rem]/4 text-ink-3 ring-1 ring-line-strong ring-inset">{children}</kbd>;
}
