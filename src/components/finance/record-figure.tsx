"use client";

import { ChevronDownIcon } from "lucide-react";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { RECORD_FIGURE_ANCHOR } from "@convex/lib/attention/scorecard";
import { ManualEntry } from "@/components/manual-entry";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewer } from "@/hooks/use-viewer";
import { cn } from "@/lib/utils";

/**
 * "Record a figure": every number with no system of record (Kazakhstan's
 * month-end cash, financing received, and the other typed-in metrics), typed
 * here on Finance. The `settings` area's, as the entry form always was
 * (`snapshots.setManual` / `removeManual`): mounted only for a holder, and a
 * link to it (`recordFigureHref`) is offered only to one (`canOpen`).
 * Settings › Sources keeps only how each connection is doing.
 *
 * A quiet disclosure at the foot of the page: closed until asked for, and
 * open on arrival when a note's link points here.
 */
export function RecordFigure() {
  const { can } = useViewer();
  const ref = useRef<HTMLElement>(null);
  const holds = can("settings");
  // A note's link lands here by its anchor: the form is then open on arrival.
  // Only ever rendered in the browser (the page waits for the clock), so the
  // address can be read for the first state.
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash === `#${RECORD_FIGURE_ANCHOR}`,
  );
  const bodyId = useId();

  // The panel arrives after the page's figures, so it is brought into view once it is there.
  useEffect(() => {
    if (holds && window.location.hash === `#${RECORD_FIGURE_ANCHOR}`) {
      ref.current?.scrollIntoView?.({ block: "start" });
    }
  }, [holds]);

  if (!holds) return null;
  return (
    <section
      ref={ref}
      id={RECORD_FIGURE_ANCHOR}
      aria-labelledby="record-a-figure-heading"
      className="scroll-mt-6 rounded-card border border-line px-5 py-4 sm:px-6"
    >
      <h2 id="record-a-figure-heading" className="text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((was) => !was)}
          className="flex w-full items-center justify-between gap-3 rounded-sm text-left font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Record a figure
          <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
        </button>
      </h2>
      {open && (
        <div id={bodyId} className="mt-3">
          <p className="max-w-2xl text-sm text-ink-2">
            Numbers with no system of record: Kazakhstan&apos;s month-end bank balance, financing
            received, and the other figures typed in by hand.
          </p>
          <div className="mt-4">
            <Suspense fallback={<Skeleton className="h-40 rounded-inner" />}>
              <ManualEntry />
            </Suspense>
          </div>
        </div>
      )}
    </section>
  );
}
