"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export type SparkPoint = {
  /** Bucket name shown in the hover tooltip, e.g. "Sep 2026". */
  label: string;
  value: number;
  /** The value as it should read, e.g. "$3,400". */
  display: string;
};

/**
 * A trend line with no axes: the history in the de-emphasis grey, the current
 * bucket marked in brand colour. Hovering shows each bucket's value.
 *
 * The line is drawn in a stretched SVG (non-scaling stroke keeps it 2px) and
 * the markers are HTML positioned by percentage, so they stay round at any
 * width.
 */
export function Sparkline({
  points,
  ariaLabel,
  className,
}: {
  points: readonly SparkPoint[];
  ariaLabel: string;
  className?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (points.length === 0) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  // Keep 12% headroom top and bottom so markers are never clipped.
  const y = (value: number) => (span === 0 ? 50 : 88 - ((value - min) / span) * 76);
  const x = (index: number) =>
    points.length === 1 ? 100 : (index / (points.length - 1)) * 100;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.value)}`).join(" ");
  const last = points.length - 1;
  const active = hovered ?? last;
  const activePoint = points[active]!;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn("relative h-12 w-full touch-none select-none", className)}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
        setHovered(Math.round(fraction * last));
      }}
      onPointerLeave={() => setHovered(null)}
    >
      {points.length > 1 && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
          aria-hidden
        >
          <path
            d={path}
            fill="none"
            stroke="var(--color-trend)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {/* The current bucket: brand colour, with a surface ring. Always shown. */}
      <span
        aria-hidden
        className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand ring-2 ring-panel"
        style={{ left: `${x(last)}%`, top: `${y(points[last]!.value)}%` }}
      />
      {/* The bucket under the pointer, when it is an earlier one. */}
      {hovered !== null && hovered !== last && (
        <span
          aria-hidden
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-2 ring-2 ring-panel"
          style={{ left: `${x(hovered)}%`, top: `${y(activePoint.value)}%` }}
        />
      )}

      {hovered !== null && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -top-7 z-10 whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[11px] text-on-ink shadow-soft-sm",
            // Keep the bubble inside the tile at either end.
            x(hovered) < 25
              ? "left-0"
              : x(hovered) > 75
                ? "right-0"
                : "-translate-x-1/2",
          )}
          style={x(hovered) >= 25 && x(hovered) <= 75 ? { left: `${x(hovered)}%` } : undefined}
        >
          <span className="opacity-70">{activePoint.label}</span>{" "}
          <span className="font-medium">{activePoint.display}</span>
        </span>
      )}
    </div>
  );
}
