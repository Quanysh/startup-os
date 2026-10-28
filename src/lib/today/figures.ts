// The quiet strip of key figures under "The company" on Today: a number, a
// change where a comparable one exists, and the series behind it for a
// sparkline. Pure, and built only from what the pages' own summaries already
// work out (`financeSummary`, `pipelineValue`): nothing is computed a second
// way. A figure that is not known says so; it is never a zero, and a partial
// total is never given as the whole.

import { LONGEST_RUNWAY_MONTHS, type FinanceSummary } from "@/lib/metrics/finance";
import { formatPeriod, formatUsd, formatValue } from "@/lib/format";
import type { PipelineValue } from "@/lib/pipeline/derive";

export type StripFigure = {
  id: "cash" | "burn" | "mrr" | "pipeline";
  label: string;
  value: string;
  /** A quieter line under the number. */
  sub: string | null;
  change: { ratio: number; better: "up" | "down"; versus: string } | null;
  /** The number behind `value`, so it can count up; `format` of it is `value`. */
  count: { value: number; format: (value: number) => string } | null;
  /** Needs attention: the line under the number is flagged (a short runway). */
  alert: boolean;
  href: string;
};

export type MoneyInput = Pick<FinanceSummary, "cash" | "average" | "runway" | "burn" | "mrr">;

const NOT_KNOWN = "Not known";

/** A runway under this many months is flagged. */
export const SHORT_RUNWAY_MONTHS = 6;

/**
 * Past this many times the month before, a percentage stops meaning
 * anything ("+4,580%"): the change is said in money instead.
 */
const MOST_PERCENT_CHANGE = 3;

function runwayWords(runway: MoneyInput["runway"]): string | null {
  if (runway === null) return null;
  if (runway.kind === "not_burning") return "Not burning cash";
  if (runway.months > LONGEST_RUNWAY_MONTHS) return "10+ years of runway";
  return `${runway.months.toFixed(1)} months of runway`;
}

/** Cash with its runway, net burn, and MRR where there is a figure. */
export function moneyFigures(summary: MoneyInput): StripFigure[] {
  const { cash, average, burn, mrr } = summary;
  const whole = cash !== null && cash.missing.length === 0;
  const complete = burn.filter((point) => point.complete);
  const [before, last] = complete.slice(-2);
  const burnChange =
    average !== null && before !== undefined && last !== undefined && before.value > 0
      ? (last.value - before.value) / before.value
      : null;
  const wild = burnChange !== null && Math.abs(burnChange) > MOST_PERCENT_CHANGE;
  const short = summary.runway?.kind === "months" && summary.runway.months < SHORT_RUNWAY_MONTHS;
  const figures: StripFigure[] = [
    {
      id: "cash",
      label: "Cash",
      value: whole ? formatUsd(cash.usd) : NOT_KNOWN,
      count: whole ? { value: cash.usd, format: formatUsd } : null,
      sub: cash !== null && !whole ? "A balance is missing" : whole ? runwayWords(summary.runway) : null,
      change: null,
      alert: whole && short,
      href: "/finance",
    },
    {
      id: "burn",
      label: "Net burn a month",
      value: average === null ? NOT_KNOWN : formatUsd(average.value),
      count: average === null ? null : { value: average.value, format: formatUsd },
      sub:
        wild && before !== undefined && last !== undefined
          ? `${last.value > before.value ? "Up" : "Down"} from ${formatUsd(before.value)} in ${formatPeriod("month", before.periodStart, "short")}`
          : null,
      change:
        burnChange !== null && !wild && before !== undefined
          ? { ratio: burnChange, better: "down", versus: formatPeriod("month", before.periodStart, "short") }
          : null,
      alert: false,
      href: "/finance",
    },
  ];
  if (mrr !== null) {
    figures.push({
      id: "mrr",
      label: "MRR",
      value: formatUsd(mrr.latest.value),
      count: { value: mrr.latest.value, format: formatUsd },
      sub: mrr.latest.value === 0 ? "No recurring revenue yet" : null,
      change:
        mrr.growthPercent !== null && mrr.previousPeriodStart !== null
          ? {
              ratio: mrr.growthPercent / 100,
              better: "up",
              versus: formatPeriod("month", mrr.previousPeriodStart, "short"),
            }
          : null,
      alert: false,
      href: "/finance",
    });
  }
  return figures;
}

/** Open deals of the market in view and their monthly value, as the Sales page sums them. */
export function pipelineFigure(value: PipelineValue, currency: string): StripFigure {
  return {
    id: "pipeline",
    label: "Open pipeline",
    // With no fee on any open deal the count is the figure, not "No amount".
    value:
      value.value === null
        ? value.open === 1
          ? "1 deal"
          : `${value.open} deals`
        : `${formatValue(value.value, "currency", currency)}/mo`,
    sub:
      value.value === null ? "No monthly fee on any yet" : value.open === 1 ? "1 open deal" : `${value.open} open deals`,
    count:
      value.value === null
        ? null
        : { value: value.value, format: (amount: number) => `${formatValue(amount, "currency", currency)}/mo` },
    change: null,
    alert: false,
    href: "/sales",
  };
}
