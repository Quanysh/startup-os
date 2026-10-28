"use client";

import type { Currency } from "@convex/lib/metricRegistry";
import { isWhole, type CurrencySummary, type Figure, type SummaryTotals } from "@convex/lib/payroll";
import { formatMinor } from "@/lib/format";
import { CURRENCY_NAMES, Money } from "./shared";

/** Where the rates are typed: the heading of the lines section, further down the page. */
export const LINES_HREF = "#payroll-lines";
export const NOT_KNOWN = "Not known yet";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const persons = (n: number) => count(n, "person", "people");

export const linkClass =
  "rounded-sm text-ink underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Why some figures are not known, one sentence a cause, and what the link to
 * the lines says. Counts only: never a name, never an amount.
 */
function reasonsFor(set: CurrencySummary, companyCurrency: Currency) {
  const { gaps, currency } = set;
  const withheld = count(gaps.withheldRates, "withheld rate is", "withheld rates are");
  const reasons: string[] = [];
  if (gaps.grossBlocked > 0) {
    reasons.push(
      `${withheld} not set, so gross cannot be worked out for ${persons(gaps.grossBlocked)}.`,
    );
  }
  if (gaps.withheldBlocked > 0) {
    const what = `what is withheld and net pay cannot be worked out for ${persons(gaps.withheldBlocked)} whose pay is entered as gross.`;
    reasons.push(
      gaps.grossBlocked > 0 ? `For the same reason, ${what}` : `${withheld} not set, so ${what}`,
    );
  }
  if (gaps.companyBlocked > 0) {
    reasons.push(
      `${count(gaps.companyRates, "company-paid rate is", "company-paid rates are")} not set, so what the company pays on top, and the total cost, cannot be worked out for ${persons(gaps.companyBlocked)}.`,
    );
  }
  if (gaps.otherCurrency > 0) {
    reasons.push(
      `${persons(gaps.otherCurrency)} paid in ${CURRENCY_NAMES[currency]} ${gaps.otherCurrency === 1 ? "has" : "have"} a line with an allowance or a cap. Those are amounts in ${CURRENCY_NAMES[companyCurrency]}, so the line is not computed in another currency.`,
    );
  }
  if (gaps.noGross > 0) {
    reasons.push(
      `For ${persons(gaps.noGross)}, what is withheld leaves no gross that gives the net entered.`,
    );
  }
  if (gaps.dependent > 0) {
    reasons.push(
      `For ${persons(gaps.dependent)}, a line is worked out on pay less another line that has no amount yet, so it is not known either.`,
    );
  }
  const rates = gaps.withheldRates + gaps.companyRates;
  const link =
    rates === 0 ? "See the lines below." : rates === 1 ? "Set the rate below." : "Set the rates below.";
  return { reasons, link };
}

/**
 * What the table's foot cannot say for one currency: why a total is not
 * known, with the way to the rates, or, when the cost is whole, what a year
 * at this month's rate comes to. Nothing at all when there is neither.
 */
export function MonthSummary({
  set,
  companyCurrency,
}: {
  set: CurrencySummary;
  companyCurrency: Currency;
}) {
  const { reasons, link } = reasonsFor(set, companyCurrency);
  const { overall, currency } = set;
  if (reasons.length > 0) {
    return (
      <div className="max-w-2xl space-y-1.5 rounded-inner bg-surface px-4 py-3 text-sm text-ink">
        {reasons.map((reason, index) => (
          <p key={reason}>
            {reason}
            {index === 0 && (
              <>
                {" "}
                <a href={LINES_HREF} className={linkClass}>
                  {link}
                </a>
              </>
            )}
          </p>
        ))}
      </div>
    );
  }
  if (overall.people === 0 || !isWhole(overall.cost, overall)) return null;
  return (
    <p className="max-w-2xl text-sm text-ink-2">
      A year at this month&apos;s rate:{" "}
      <span className="font-num text-ink">{formatMinor(overall.cost.sum * 12, currency)}</span>.
      That is the total cost × 12: a simple multiple, not a forecast.
    </p>
  );
}

/** Lines that subtract each other in a circle: nothing can be worked out. */
export function CircleNote() {
  return (
    <p className="max-w-2xl text-sm text-ink">
      {NOT_KNOWN}: some lines subtract each other in a circle.{" "}
      <a href={LINES_HREF} className={linkClass}>
        See the lines below.
      </a>
    </p>
  );
}

/**
 * A total in the table's foot: the amount, or that it is not known. Never a
 * part passed off as the whole; only the net, a sum of what was typed, keeps
 * its part, and says whose it is.
 */
export function FigureCell({
  figure,
  totals,
  currency,
  partial = false,
}: {
  figure: Figure;
  totals: SummaryTotals;
  currency: Currency;
  partial?: boolean;
}) {
  if (isWhole(figure, totals)) return <Money minor={figure.sum} currency={currency} />;
  if (partial && figure.known > 0) {
    return (
      <>
        <Money minor={figure.sum} currency={currency} />
        <span className="block font-sans text-xs font-normal text-ink-2">
          for {figure.known} of {totals.people}
        </span>
      </>
    );
  }
  return <span className="font-sans font-normal text-ink-2">{NOT_KNOWN}</span>;
}
