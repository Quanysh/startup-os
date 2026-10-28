"use client";

import { useEffect } from "react";

// A soft light that follows the pointer across a panel, and along its edge.
// Adapted from 21st.dev's "Spotlight" (kevingirelli): there each surface
// wraps itself in a component; here one listener serves every panel, so the
// many `rounded-card bg-panel` surfaces get it without each being rewritten.
// The light and the ring are drawn by src/styles/globals.css ("Spotlight");
// this only writes two CSS variables on the panel under the pointer, once a
// frame, so nothing re-renders. A finger leaves no light behind, and
// `prefers-reduced-motion` keeps the light from fading in and out.

/** What carries the light: every panel, and anything marked for it. */
export const SPOTLIGHT_SELECTOR = ".rounded-card.bg-panel, [data-spotlight]";

/** Mounted once, in the app's shell. Renders nothing. */
export function SpotlightTracker() {
  useEffect(() => {
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !(event.target instanceof Element)) return;
      const panel = event.target.closest<HTMLElement>(SPOTLIGHT_SELECTOR);
      if (panel === null) return;
      const { clientX, clientY } = event;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = panel.getBoundingClientRect();
        panel.style.setProperty("--spot-x", `${clientX - bounds.left}px`);
        panel.style.setProperty("--spot-y", `${clientY - bounds.top}px`);
      });
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
