"use client";

import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { classify, type Benchmark, type Verdict } from "@/lib/metrics/benchmarks";
import { cn } from "@/lib/utils";

const VERDICT: Record<Verdict, { label: string; icon: typeof CircleCheckIcon; tone: string }> = {
  stronger: { label: "Stronger than typical for seed", icon: CircleCheckIcon, tone: "text-good" },
  typical: { label: "Typical for seed", icon: CircleDotIcon, tone: "text-brand" },
  weaker: { label: "Weaker than typical for seed", icon: TriangleAlertIcon, tone: "text-weak" },
};

/**
 * Where a value sits against its published benchmark. The verdict is an icon
 * plus words (never colour alone), and it opens to show the band, the source
 * and anything that qualifies it, so the label can always be checked.
 */
export function BenchmarkChip({
  value,
  benchmark,
  className,
}: {
  value: number;
  benchmark: Benchmark;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const verdict = classify(value, benchmark);
  if (verdict === null) return null;
  const { label, icon: Icon, tone } = VERDICT[verdict];

  return (
    <div className={cn("min-w-0", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        // The label wraps where the chip is wider than its tile (a summary
        // tile at four columns). The radius is a fixed one, not a full pill:
        // on one line it is more than half the chip's 24px height, so the
        // browser clamps it and the chip is the pill it always was (the home
        // hero); on two lines the corners stay clear of the words.
        className="inline-flex max-w-full items-center gap-1.5 rounded-xl bg-panel/80 py-1 pr-2 pl-2.5 text-left text-xs font-medium text-ink shadow-soft-sm outline-none transition hover:bg-panel focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Icon aria-hidden className={cn("size-3.5 shrink-0", tone)} />
        {label}
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <dl
          id={panelId}
          className="mt-3 grid max-w-md gap-x-4 gap-y-1.5 rounded-inner bg-panel/80 p-4 text-xs text-ink-2 shadow-soft-sm sm:grid-cols-[auto_1fr]"
        >
          <dt className="text-ink-3">Benchmark</dt>
          <dd className="text-ink">
            {benchmark.bands}
            {benchmark.derived && (
              <span className="ml-1.5 rounded-full bg-surface px-1.5 py-0.5 text-[10px] text-ink-2">
                derived
              </span>
            )}
          </dd>
          {benchmark.seriesA && (
            <>
              <dt className="text-ink-3">Series A bar</dt>
              <dd className="text-ink">{benchmark.seriesA}</dd>
            </>
          )}
          <dt className="text-ink-3">Source</dt>
          <dd>
            <a
              href={benchmark.source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-brand underline-offset-2 hover:underline"
            >
              {benchmark.source.name}, {benchmark.source.year}
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          </dd>
          {benchmark.alt && (
            <>
              <dt className="text-ink-3">Also</dt>
              <dd>{benchmark.alt}</dd>
            </>
          )}
          {benchmark.caveat && (
            <>
              <dt className="text-ink-3">Note</dt>
              <dd>{benchmark.caveat}</dd>
            </>
          )}
          {benchmark.derived && (
            <dd className="text-ink-3 sm:col-span-2">
              “Derived” means the band&apos;s edges were set from the source&apos;s published
              figures; the source does not state them as a band.
            </dd>
          )}
        </dl>
      )}
    </div>
  );
}
