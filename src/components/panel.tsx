import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** The white, softly raised surface every section of a page sits on. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-card bg-panel p-5 shadow-soft sm:p-6", className)}
      {...props}
    />
  );
}

// Shared control styles, so forms across the app read as one system.
export const fieldClass =
  "w-full rounded-inner border border-input bg-panel px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

export const primaryButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-brand-fill px-5 text-sm font-medium text-on-brand outline-none transition hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60";

/** A button with an outline: a switch or an action that must read as one at a glance (Connections, Grant). */
export const outlineButtonClass =
  "inline-flex h-8 items-center justify-center gap-2 rounded-full border border-line bg-panel px-3 text-xs font-medium text-ink outline-none transition hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60 disabled:opacity-60";

export const quietButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium text-ink-2 outline-none transition hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60";
