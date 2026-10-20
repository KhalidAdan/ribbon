import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AppController, AppState } from "../app/controller";

export const ControllerContext = createContext<AppController | null>(null);

export function useController(): AppController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error("ControllerContext missing");
  return c;
}

/**
 * The app's state, or the part of it a component draws.
 *
 * With no selector, the whole `AppState`: the component redraws on every
 * change, including the player's place five times a second while a book
 * plays. With a selector, it redraws only when what the selector returns
 * changes, compared with `equal` (`shallowEqual` by default: the same
 * values in an object's keys or an array's items). So pick what is drawn,
 * not more:
 *
 * ```ts
 * const { books, view } = useAppState((s) => ({ books: s.books, view: s.view }));
 * const playing = useAppState((s) => s.player.playing);
 * ```
 *
 * A selector may close over props; it is read again whenever it changes.
 * What a controller method reads during render (`c.coverUrl`, say) is a
 * dependency too: select what it depends on (`coverDeps`).
 */
export function useAppState(): AppState;
export function useAppState<T>(select: (s: AppState) => T, equal?: (a: T, b: T) => boolean): T;
export function useAppState<T>(select?: (s: AppState) => T, equal: (a: T, b: T) => boolean = shallowEqual): T | AppState {
  const c = useController();
  // The value last drawn, so a new but equal selection keeps its identity across renders.
  const drawn = useRef<{ value: T } | null>(null);
  const getSelection = useMemo((): (() => T | AppState) => {
    if (!select) return c.getState;
    let seen: { state: AppState; value: T } | null = null;
    return (): T => {
      const state = c.getState();
      if (seen && seen.state === state) return seen.value;
      const next = select(state);
      const prev = seen?.value ?? drawn.current?.value;
      const value = (seen || drawn.current) && equal(prev as T, next) ? (prev as T) : next;
      seen = { state, value };
      return value;
    };
  }, [c, select, equal]);
  const value = useSyncExternalStore(c.subscribe, getSelection, getSelection);
  useEffect(() => {
    if (select) drawn.current = { value: value as T };
  });
  return value;
}

/** Equal values, or plain objects (and arrays) whose own keys hold equal values. A Map, a Set or a class instance is equal only to itself. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!plain(a) || !plain(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function plain(v: unknown): v is object {
  if (typeof v !== "object" || v === null) return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * What `c.coverUrl` reads besides the book: the mirrored covers, and
 * whether each folder serves its files. Select it in anything that draws
 * covers, so a cover that becomes available is drawn.
 */
export function coverDeps(s: AppState): readonly unknown[] {
  return [s.coverVersion, s.assetsReady, s.sourceStatus];
}

/** Redraw when a cover becomes available (`coverDeps`); for components that draw covers and select little else. */
export function useCovers(): void {
  useAppState(coverDeps);
}
