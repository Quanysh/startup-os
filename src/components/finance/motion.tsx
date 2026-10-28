"use client";

import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The Finance page's motion, in two pieces and CSS (the keyframes are in
// src/styles/globals.css). Plain CSS and one small hook: no animation library.
//
// - A figure counts up from zero once, the first time the page shows it.
// - A section rises in, a little after the one before it.
// - A chart's marks draw in (globals.css: `animate-wipe`, `animate-grow`).
//
// `prefers-reduced-motion: reduce` gets none of it: CSS animations are
// `motion-safe:` only, and a figure is written in its final words at once.
// Nothing here changes a box's size: a counting figure reserves the width of
// its final words, and the rest moves by opacity, transform and clip-path.

/** Figures that have already counted on this page load, by id. */
const counted = new Set<string>();

/** For tests: forget which figures have counted. */
export function forgetCountUps() {
  counted.clear();
}

const DURATION_MS = 900;
const easeOut = (p: number) => 1 - (1 - p) ** 3;

function reducedMotion(): boolean {
  // No matchMedia (a server, an old test environment): no motion.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A figure that counts up from zero to `value` the first time it is shown on
 * this page load. Its text is always `format(value)` as far as React and a
 * screen reader are concerned; only the frames between are written by hand,
 * onto the same text node React owns.
 */
export function CountUp({
  id,
  value,
  format,
  className,
  title,
}: {
  /** Which figure this is: a figure counts once a page load. */
  id: string;
  value: number;
  format: (value: number) => string;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = format(value);
  // What the count should end on, read by the running animation each frame.
  const target = useRef({ value, final });
  const frame = useRef<number | null>(null);
  useLayoutEffect(() => {
    target.current = { value, final };
  });

  // Before the first paint, so the final figure never flashes first.
  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    if (!node || counted.has(id)) return;
    counted.add(id);
    // A page nobody can see (a background tab, a thumbnail) runs no frames:
    // the count would sit at zero. It shows the figure instead.
    if (reducedMotion() || document.visibilityState !== "visible") return;
    const start = performance.now();
    node.nodeValue = format(0);
    const stop = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      clearTimeout(deadline);
      document.removeEventListener("visibilitychange", hidden);
    };
    let landed = false;
    const land = () => {
      landed = true;
      stop();
      node.nodeValue = target.current.final;
    };
    // Hidden mid-count: end on the figure at once, never on a part of it.
    const hidden = () => {
      if (document.visibilityState !== "visible") land();
    };
    // A browser that starves the page of frames (a window behind another)
    // would leave the count short of the figure: it lands on time anyway.
    const deadline = setTimeout(land, DURATION_MS + 150);
    const tick = (at: number) => {
      const progress = Math.min((at - start) / DURATION_MS, 1);
      if (progress >= 1) return land();
      node.nodeValue = format(target.current.value * easeOut(progress));
      frame.current = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", hidden);
    frame.current = requestAnimationFrame(tick);
    // Taken away mid-count (React's development double mount does exactly
    // this): never leave a part of the figure behind, and let the next mount
    // count, since this one never finished.
    return () => {
      if (landed) return;
      land();
      counted.delete(id);
    };
    // Once: a later figure is taken up by `target`, not by a new count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new figure is written by React onto the same text node; mid-count, the
  // next frame takes it up from `target`, and the last frame ends on it.

  return (
    <span
      ref={ref}
      data-testid="count-up"
      data-final={final}
      title={title}
      className={cn("count-up", className)}
    >
      {final}
    </span>
  );
}

/** How far apart, in time, consecutive sections start to rise. */
export const STAGGER_MS = 70;

/** A block that rises in after `order` others, where motion is welcome. */
export function Reveal({
  order,
  className,
  style,
  children,
  ...props
}: { order: number; children: ReactNode } & ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("motion-safe:animate-rise", className)}
      style={{ ...style, animationDelay: `${order * STAGGER_MS}ms` }}
    >
      {children}
    </div>
  );
}
