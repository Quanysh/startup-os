"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

// A border with a light travelling around it, for what needs attention.
// Adapted from 21st.dev's "Animated Border" (kevingirelli): one rotating
// layer (transform only, so the compositor does the work), paused while off
// screen, still under `prefers-reduced-motion`. The colour is the brand's.

/** Whether the element is on screen (or near it); true where there is no observer. */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? true), {
      rootMargin: "100px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, onScreen] as const;
}

export function AnimatedBorder({
  seconds = 8,
  className,
  contentClassName,
  children,
  ...props
}: ComponentProps<"div"> & {
  /** Seconds for the light to go round once. */
  seconds?: number;
  /** Classes for the surface inside the border, where the content sits. */
  contentClassName?: string;
}) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-slot="animated-border"
      className={cn("relative isolate overflow-hidden rounded-card bg-line p-px shadow-soft", className)}
      {...props}
    >
      {/* Centred with margins, not a transform, which the spin would overwrite. */}
      <span
        aria-hidden="true"
        data-slot="animated-border-light"
        className="pointer-events-none absolute top-1/2 left-1/2 -mt-[100%] -ml-[100%] aspect-square w-[200%] animate-spin motion-reduce:animate-none forced-colors:hidden"
        style={{
          background: "conic-gradient(from 0deg, transparent 0 62%, var(--color-brand) 82%, transparent 96%)",
          animationDuration: `${seconds}s`,
          animationPlayState: onScreen ? "running" : "paused",
        }}
      />
      <div className={cn("relative h-full rounded-[calc(var(--radius-card)-1px)] bg-panel", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
