import { createContext, useContext, useSyncExternalStore } from "react";
import type { AppController, AppState } from "../app/controller";

export const ControllerContext = createContext<AppController | null>(null);

export function useController(): AppController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error("ControllerContext missing");
  return c;
}

export function useAppState(): AppState {
  const c = useController();
  return useSyncExternalStore(c.subscribe, c.getState, c.getState);
}
