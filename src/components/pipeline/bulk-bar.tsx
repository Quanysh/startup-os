"use client";

import { ArchiveIcon, Loader2Icon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const bulkControlClass =
  "h-8 rounded-full border border-line bg-panel px-3 text-xs text-ink outline-none transition hover:border-ink-3 focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60";
export const bulkQuietClass =
  "inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium text-ink-2 outline-none transition hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60";

/**
 * The bar a pipeline table shows while rows are ticked: how many, the
 * actions it is given, and Cancel; under it, always on the page, the status
 * line that says how the last action went (so it is read out even once the
 * bar has gone). The sales table's deals and the investors share it.
 */
export function BulkBar({
  label,
  count,
  busy,
  onClear,
  report,
  reportLabel,
  children,
}: {
  /** The region's name: "Selected deals". */
  label: string;
  /** The status line's name, when it holds more than a sentence. */
  reportLabel?: string;
  count: number;
  busy: boolean;
  onClear: () => void;
  /** What the last action did. */
  report: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {count > 0 && (
        <div
          role="region"
          aria-label={label}
          aria-busy={busy}
          className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-card bg-panel p-1.5 pl-4 shadow-soft"
        >
          <span className="mr-1 font-num text-xs font-medium text-ink">{count} selected</span>
          {children}
          <button type="button" onClick={onClear} className={bulkQuietClass} aria-label="Cancel selection">
            {busy ? (
              <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <XIcon aria-hidden className="size-3.5" />
            )}
            Cancel
          </button>
        </div>
      )}
      <div role="status" aria-label={reportLabel} className="text-center text-xs text-ink-2 empty:hidden">
        {report}
      </div>
    </>
  );
}

/** "Archive", asked once more before it runs: "Archive 3 deals?" Archive 3 / Keep. */
export function BulkArchive({
  count,
  one,
  many,
  busy,
  onArchive,
}: {
  count: number;
  /** "deal", "investor". */
  one: string;
  many: string;
  busy: boolean;
  onArchive: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" aria-disabled={busy} onClick={() => setConfirming(true)} className={bulkQuietClass}>
        <ArchiveIcon aria-hidden className="size-3.5" />
        Archive
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 pl-1 text-xs text-ink-2">
      Archive {count} {count === 1 ? one : many}?
      <button
        type="button"
        aria-disabled={busy}
        onClick={() => {
          setConfirming(false);
          onArchive();
        }}
        className={cn(bulkQuietClass, "text-ink hover:bg-surface")}
      >
        {`Archive ${count}`}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className={bulkQuietClass}>
        Keep
      </button>
    </span>
  );
}
