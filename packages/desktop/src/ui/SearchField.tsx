import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Open the first match. */
  onSubmit: () => void;
  count: number | null;
}

/**
 * The shelf's search box. `/` or Ctrl+F focuses it from anywhere that
 * is not already a text field; Escape clears it and gives focus back.
 */
export function SearchField({ value, onChange, onSubmit, count }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.key === "/" && !typing) || (e.key === "f" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      role="search"
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="library-search" className="sr-only">
        Search your library
      </label>
      <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 fill-ink-3" aria-hidden="true" />
      <input
        ref={ref}
        id="library-search"
        name="q"
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onChange("");
            ref.current?.blur();
          }
        }}
        placeholder="Search"
        aria-describedby={count !== null ? "library-search-count" : undefined}
        className="block w-full rounded-md bg-raised py-1.5 pr-8 pl-8 text-base/6 text-ink ring-1 ring-line placeholder:text-ink-3 focus:bg-surface focus:outline-2 focus:-outline-offset-1 focus:outline-place sm:py-1 sm:text-sm/6 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-ink-3 focus-ring hover:text-ink"
        >
          <XMarkIcon className="size-4 fill-current" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-[4px] px-1 font-sans text-[0.6875rem]/4 text-ink-3 ring-1 ring-line-strong ring-inset pointer-coarse:hidden" aria-hidden="true">
          /
        </kbd>
      )}
      {count !== null && (
        <p id="library-search-count" className="sr-only" aria-live="polite">
          {count === 0 ? "No matches" : `${count} ${count === 1 ? "match" : "matches"}`}
        </p>
      )}
    </form>
  );
}
