"use client";

import type { Currency } from "@convex/lib/metricRegistry";
import { Panel } from "@/components/panel";
import { formatMinor, formatPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";
import { firstDayOf } from "@convex/lib/costs";
import { NOT_KNOWN, type Summary } from "./shared";

type FigureKey = "runRate" | "cashDue" | "next3" | "yearly";

const TILES: { key: FigureKey; label: string; note: (month: string) => string }[] = [
  {
    key: "runRate",
    label: "Monthly run-rate",
    note: (month) => `Recurring lines in ${month}, spread evenly: a yearly bill counts a twelfth.`,
  },
  {
    key: "cashDue",
    label: "Cash due this month",
    note: (month) => `What falls in ${month}: yearly and quarterly bills whole, and one-offs.`,
  },
  {
    key: "next3",
    label: "Next 3 months, cash due",
    note: () => "The three months after this one.",
  },
  {
    key: "yearly",
    label: "Yearly, at this rate",
    note: () => "The run-rate × 12: a simple multiple, not a forecast.",
  },
];

/** One currency's own figure, as small print under a total. */
function Subtotals({ summary, figure }: { summary: Summary; figure: FigureKey }) {
  return (
    <ul className="mt-1 space-y-0.5 font-num text-xs text-ink-2">
      {summary.currencies.map((set) => (
        <li key={set.currency}>{formatMinor(set[figure], set.currency)}</li>
      ))}
    </ul>
  );
}

/**
 * The four figures the page leads with. Run-rate and cash due are two
 * different things and sit in tiles of their own, each saying which it is.
 * With two currencies and no exchange rate on record the total is "Not known
 * yet" and each currency's own figure still shows.
 */
export function HeadTiles({ summary }: { summary: Summary }) {
  const month = formatPeriod("month", firstDayOf(summary.month));
  const { combined } = summary;
  const converted = combined.kind === "converted";
  return (
    <section aria-label="Costs this month" className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map((tile, index) => (
          <Panel key={tile.key} role="group" aria-label={tile.label} className="min-w-0">
            <p className={cn("text-xs", index === 0 ? "font-medium text-ink" : "text-ink-2")}>
              {tile.label}
            </p>
            {combined.kind === "unknown" ? (
              <>
                <p className="mt-1 text-xl font-medium text-ink-2">{NOT_KNOWN}</p>
                <Subtotals summary={summary} figure={tile.key} />
              </>
            ) : (
              <>
                <p className="mt-1 text-2xl font-semibold text-ink sm:text-3xl">
                  {formatMinor(combined[tile.key], combined.currency as Currency)}
                </p>
                {converted && <Subtotals summary={summary} figure={tile.key} />}
              </>
            )}
            <p className="mt-2 text-xs leading-relaxed text-ink-3">{tile.note(month)}</p>
          </Panel>
        ))}
      </div>
      <p className="text-sm text-ink-2">
        {summary.lines === 0
          ? `No line is active in ${month}.`
          : `${summary.estimates} of ${summary.lines} ${summary.lines === 1 ? "line is an estimate" : "lines are estimates"}.`}{" "}
        {combined.kind === "converted" &&
          summary.fx !== null &&
          `Totals are in US dollars at ${summary.fx.rate} tenge to the dollar, the rate stored for ${formatPeriod("month", summary.fx.periodStart)}.`}
        {combined.kind === "unknown" &&
          "The lines are in two currencies and no USD/KZT rate is on record, so they are not added together."}
      </p>
    </section>
  );
}
