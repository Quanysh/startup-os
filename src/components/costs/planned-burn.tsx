"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { firstDayOf } from "@convex/lib/costs";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import { summarise } from "@convex/lib/payroll";
import { periodStart } from "@convex/lib/periods";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import type { CompanyId } from "@/lib/company";
import { compare, payOf, plannedBurn, type Amount, type Pay, type Planned } from "@/lib/costs/planned";
import { formatMinor, formatPeriod, formatUsd, monthRange } from "@/lib/format";
import { financeSummary } from "@/lib/metrics/finance";
import { CURRENCY_NAMES, NOT_KNOWN, type Summary } from "./shared";

const linkClass =
  "rounded-sm text-ink underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** Said where the viewer does not hold the Payroll page. */
export const PAY_ELSEWHERE = "Pay is not included: it is on the Payroll page.";
const PAY_UNKNOWN = "Pay is not included: its total cost is not known yet.";

const said = (amount: Amount) =>
  amount.kind === "unknown" ? NOT_KNOWN : formatMinor(amount.minor, amount.currency);

/** Why pay is out of the figure, in a sentence. Null when it is in. */
function PayLine({ planned }: { planned: Planned }) {
  switch (planned.payOut) {
    case null:
    case "loading":
      return null;
    case "no_access":
      return <p>{PAY_ELSEWHERE}</p>;
    case "rates":
      return (
        <p>
          {PAY_UNKNOWN} Set the rates on the{" "}
          <Link href="/payroll" className={linkClass}>
            Payroll page
          </Link>
          .
        </p>
      );
    case "circle":
      return (
        <p>
          {PAY_UNKNOWN} Some payroll lines subtract each other in a circle: see the{" "}
          <Link href="/payroll" className={linkClass}>
            Payroll page
          </Link>
          .
        </p>
      );
  }
}

/**
 * The actual net burn the Finance page shows, and the plan beside it. Mounted
 * only for a viewer who holds Finance: it reads the scorecard, which they are
 * sent. Nothing here works a burn out: `financeSummary` does, as it does there.
 */
function Actual({
  company,
  planned,
  fxRate,
  now,
}: {
  company: CompanyId;
  planned: Planned;
  fxRate: number | null;
  now: number;
}) {
  const data = useScorecard();
  const kzHistory = useQuery(
    api.metrics.series,
    company === "kz" ? { key: "cash", scope: "kz", limit: 400 } : "skip",
  );
  const kzCash = company === "kz" ? kzHistory : [];
  if (data === undefined || kzCash === undefined) return <Skeleton className="h-24 rounded-inner" />;

  const summary = financeSummary(
    data.money.tiles,
    kzCash,
    periodStart("month", now),
    data.money.mercuryReadAt,
    [company],
  );
  const average = summary.average;
  const result = compare(planned, average?.value ?? null, fxRate);
  return (
    <div role="group" aria-label="Run-rate incl. pay vs actual" className="min-w-0 space-y-3 border-line max-lg:border-t max-lg:pt-5 lg:border-l lg:pl-6">
      <div>
        <p className="text-xs text-ink-2">Actual net burn, a month</p>
        <p className="mt-1 text-lg font-medium text-ink">
          {average === null ? <span className="text-ink-2">{NOT_KNOWN}</span> : formatUsd(average.value)}
        </p>
        <p className="mt-1 text-xs text-ink-3">
          {average === null
            ? "The Finance page has no complete month among the last three."
            : `From the Finance page: the average of ${monthRange(average.months[0]!, average.months.at(-1)!)}.`}
        </p>
      </div>
      <div>
        <p className="text-xs text-ink-2">Run-rate incl. pay vs actual</p>
        {result.kind === "compared" ? (
          <p className="mt-1 text-sm text-ink">
            {result.difference === 0
              ? "The run-rate and the actual burn are the same."
              : `The run-rate is ${formatMinor(Math.abs(result.difference), "USD")} ${result.difference > 0 ? "above" : "below"} the actual net burn.`}
            {planned.total.kind === "amount" && planned.total.currency === "KZT" && fxRate !== null && (
              <span className="mt-1 block text-xs text-ink-2">
                The run-rate is {formatMinor(result.plannedUsd, "USD")} at {fxRate} tenge to the dollar.
              </span>
            )}
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-2">
            {result.reason === "no_actual" && `${NOT_KNOWN}: there is no actual net burn to set the run-rate against.`}
            {result.reason === "pay_out" && "Not compared: pay is not in the run-rate."}
            {result.reason === "planned_unknown" && "Not compared: the run-rate is not known."}
            {result.reason === "no_rate" && "Not compared: no USD/KZT rate is on record."}
          </p>
        )}
        <p className="mt-1 text-xs text-ink-3">
          Net burn is what went out less what came in. The run-rate is spending alone, so with
          revenue the run-rate reads higher.
        </p>
      </div>
    </div>
  );
}

/**
 * Planned burn: run-rate costs plus payroll. Pay is in it only for a viewer
 * who also holds the Payroll page for this company, worked out by payroll's
 * own summary from payroll's own functions; nobody else is sent anything of
 * pay, and the line says where it is. Pay that is not known is left out and
 * said to be: never a part passed off as the whole.
 */
export function PlannedBurn({
  company,
  summary,
  now,
}: {
  company: CompanyId;
  summary: Summary;
  now: number;
}) {
  const viewer = useViewer();
  const holdsPayroll = viewer.can("payroll");
  const ask = holdsPayroll ? { company } : "skip";
  const people = useQuery(api.payroll.listPeople, ask);
  const lines = useQuery(api.payroll.listLines, ask);
  const month = firstDayOf(summary.month);

  const pay = useMemo<Pay>(() => {
    if (!holdsPayroll) return { kind: "no_access" };
    if (people === undefined || lines === undefined) return { kind: "loading" };
    try {
      return payOf(summarise({ people, lines, month, companyCurrency: MARKET_CURRENCY[company] }));
    } catch {
      return payOf(null);
    }
  }, [holdsPayroll, people, lines, month, company]);

  const fxRate = summary.fx?.rate ?? null;
  const planned = plannedBurn({ costs: summary, pay, fxRate });
  const name = formatPeriod("month", month);

  return (
    <Panel aria-labelledby="planned-burn">
      <h2 id="planned-burn" className="text-base">
        Run-rate incl. pay
      </h2>
      {pay.kind === "loading" ? (
        <Skeleton className="mt-4 h-24 rounded-inner" />
      ) : (
        <div className={viewer.can("finance") ? "mt-4 grid gap-5 lg:grid-cols-2" : "mt-4"}>
          <div role="group" aria-label="Run-rate incl. pay, a month" className="min-w-0">
            <p className="text-xs font-medium text-ink">
              {planned.includesPay ? "Costs and pay, a month" : "Costs only, a month"}
            </p>
            <p
              className={
                planned.total.kind === "unknown"
                  ? "mt-1 text-xl font-medium text-ink-2"
                  : "mt-1 text-2xl font-semibold text-ink sm:text-3xl"
              }
            >
              {said(planned.total)}
            </p>
            <div className="mt-2 max-w-xl space-y-1 text-sm text-ink-2">
              {planned.includesPay && planned.pay !== null && (
                <p>
                  Run-rate costs {said(planned.costs)} + pay {said(planned.pay)}, for {name}. Pay
                  is payroll&apos;s total cost at today&apos;s pay and rates.
                </p>
              )}
              <PayLine planned={planned} />
              {planned.total.kind === "unknown" && (
                <>
                  <p>No USD/KZT rate is on record, so the two currencies are not added together.</p>
                  <ul className="font-num text-ink">
                    {planned.parts.map((part) => (
                      <li key={part.currency}>
                        {formatMinor(part.costs + part.pay, part.currency)}
                        <span className="font-sans text-ink-2"> in {CURRENCY_NAMES[part.currency]}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {planned.total.kind === "amount" && planned.total.rate !== undefined && (
                <p>In US dollars at {planned.total.rate} tenge to the dollar.</p>
              )}
            </div>
          </div>
          {viewer.can("finance") && (
            <Actual company={company} planned={planned} fxRate={fxRate} now={now} />
          )}
        </div>
      )}
    </Panel>
  );
}
