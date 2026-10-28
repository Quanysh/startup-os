import { useSyncExternalStore } from "react";

/** Below Tailwind's `sm` (40rem): a phone held upright. */
const QUERY = "(max-width: 639.98px)";

const media = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

function subscribe(onChange: () => void) {
  const query = media();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/**
 * Whether the screen is narrower than `sm`, live. False on the server and
 * where the browser cannot say (no `matchMedia`): the wide layout.
 */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
}
