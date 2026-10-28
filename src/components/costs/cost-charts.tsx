"use client";

import { CATEGORY_LABELS, firstDayOf, type Figures } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel } from "@/components/panel";
import { formatMinor, formatPeriod } from "@/lib/format";
import { CURRENCY_NAMES, type Summary } from "./shared";

const CASH_SERIES = [{ id: "cash", label: "Cash due", color: "var(--chart-1)" }];

/**
 * This month's run-rate by category: one bar a category, the largest first,
 * one hue (the bars differ in length, not in kind), every value written
 * beside its bar. A category with nothing recurring this month is not drawn.
 */
function CategoryBars({ figures, currency }: { figures: Figures; currency: Currency }) {
  const rows = figures.byCategory.filter((row) => row.runRate > 0);
  const max = Math.max(0, ...rows.map((row) => row.runRate));
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-ink-3">Nothing recurring this month.</p>;
  }
  return (
    <ul className="mt-4 space-y-2.5">
      {rows.map((row) => (
        <li
          key={row.category}
          className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-x-3 text-sm"
        >
          <span className="truncate text-ink-2">{CATEGORY_LABELS[row.category]}</span>
          <span aria-hidden className="h-3 min-w-0">
            <span
              data-bar={row.category}
              className="block h-full min-w-px rounded-r-[4px] forced-color-adjust-none"
              style={{
                width: `${Math.round((row.runRate / max) * 10_000) / 100}%`,
                backgroundColor: "var(--chart-1)",
              }}
            />
          </span>
          <span className="font-num text-ink">{formatMinor(row.runRate, currency)}</span>
        </li>
      ))}
    </ul>
  );
}

function Block({
  summary,
  figures,
  currency,
  suffix,
}: {
  summary: Summary;
  figures: Figures;
  currency: Currency;
  /** Said after each title where there is a block per currency. */
  suffix: string;
}) {
  const month = formatPeriod("month", firstDayOf(summary.month));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel className="min-w-0" role="group" aria-label={`Run-rate by category${suffix}`}>
        <h3 className="text-sm font-medium text-ink-2">
          Run-rate by category · {month}
          {suffix}
        </h3>
        <CategoryBars figures={figures} currency={currency} />
      </Panel>
      <Panel className="min-w-0">
        <MonthBars
          title={`Cash due by month${suffix}`}
          mode="stacked"
          series={CASH_SERIES}
          rows={summary.months.map((m, index) => ({
            periodStart: firstDayOf(m),
            values: { cash: figures.cashByMonth[index]! },
          }))}
          format={(value) => formatMinor(value, currency)}
        />
        <p className="mt-3 text-xs text-ink-3">
          What falls in each month, this one and the next eleven: a yearly bill shows whole, in
          its month.
        </p>
      </Panel>
    </div>
  );
}

/**
 * The two charts: this month's run-rate by category, and twelve months of
 * cash due. In the total's currency where there is a total; where the lines
 * are in two currencies and no rate is on record, once per currency, since a
 * bar of dollars and a bar of tenge share no scale.
 */
export function CostCharts({ summary }: { summary: Summary }) {
  const { combined } = summary;
  return (
    <section aria-labelledby="costs-by-category" className="space-y-4">
      <h2 id="costs-by-category" className="text-base">
        By category
      </h2>
      {combined.kind === "unknown" ? (
        summary.currencies.map((set) => (
          <Block
            key={set.currency}
            summary={summary}
            figures={set}
            currency={set.currency}
            suffix={`, in ${CURRENCY_NAMES[set.currency]}`}
          />
        ))
      ) : (
        <Block summary={summary} figures={combined} currency={combined.currency} suffix="" />
      )}
    </section>
  );
}
