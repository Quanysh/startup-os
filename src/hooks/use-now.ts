import { useSyncExternalStore } from "react";

// One shared clock for every "3h ago" label and staleness check. It ticks
// twice a minute; all subscribers share the single interval.
const TICK_MS = 30_000;

let current = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  if (timer === null) {
    timer = setInterval(() => {
      current = Date.now();
      for (const listener of listeners) listener();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  if (current === 0) current = Date.now();
  return current;
}

/** The current time, or null while rendering on the server. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
