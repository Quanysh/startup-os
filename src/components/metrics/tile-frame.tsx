"use client";

import { createContext, useContext, type ReactNode } from "react";

// How a tile is framed. On its own page a tile is a card. On the dashboard
// several sit inside one section's panel, where a card inside a card would be
// noise: there the same tile is drawn flat, with the same words and numbers.
// In the Finance page's hero the same tiles are drawn larger, inside the
// hero's one panel, and their figures count up (`HeroTiles`).
type Frame = "card" | "flat" | "hero";
const FrameContext = createContext<Frame>("card");

/** Tiles below this are drawn without a card of their own. */
export function FlatTiles({ children }: { children: ReactNode }) {
  return <FrameContext.Provider value="flat">{children}</FrameContext.Provider>;
}

/** Tiles below this are the Finance hero's: no card, a larger figure that counts up. */
export function HeroTiles({ children }: { children: ReactNode }) {
  return <FrameContext.Provider value="hero">{children}</FrameContext.Provider>;
}

const CARD = "min-h-44 rounded-card bg-panel p-5 shadow-soft";

/** The classes of a tile's frame: a card, or nothing inside `FlatTiles` and `HeroTiles`. */
export function useTileFrame(): { flat: boolean; hero: boolean; frame: string } {
  const frame = useContext(FrameContext);
  return { flat: frame === "flat", hero: frame === "hero", frame: frame === "card" ? CARD : "" };
}
