import type { ReactNode } from "react";

/**
 * A chip's words that keep their width when the chip is chosen and turns bold:
 * a bold copy, hidden, holds the room, so the chips beside it do not move.
 */
export function SteadyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-grid">
      <span aria-hidden className="invisible col-start-1 row-start-1 font-medium">
        {children}
      </span>
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  );
}
