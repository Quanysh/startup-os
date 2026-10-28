"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { runwayInputs } from "@convex/lib/budget";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { periodStart } from "@convex/lib/periods";
import { PLAN_SCENARIO_LABELS } from "@convex/lib/planShape";
import { project } from "@convex/lib/runway";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { dayLabel, formatPeriod, formatUsd } from "@/lib/format";
import {
  burnSentence,
  cashSentence,
  mrrSentence,
  planChart,
  readBurn,
  readCash,
  readMrr,
} from "@/lib/finance/plan";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { LineChart } from "./line-chart";

const ACTUAL = "var(--chart-1)";
const PLAN = "var(--chart-2)";

/**
 * Plan against reality: the financial model's plan for this year (its base
 * scenario, with bear to bull as a band) against Startup's MRR so far, and two
 * or three sentences on MRR, burn and year-end cash. The plan is Startup's US
 * business and is read with `plan.get` (the `finance` area on the `us`
 * company), so it is asked for only where Startup is in view; Globex's view
 * says where it is.
 */
export function PlanSection({
  company,
  summary,
  now,
  mrr,
  onShowStartup,
}: {
  company: CompanyId;
  /** Away from Startup's lens: switches to it, where the plan is. */
  onShowStartup?: () => void;
  /** The finance summary of the company in view. */
  summary: FinanceSummary;
  now: number;
  /** Startup's MRR by month, in dollars. */
  mrr: readonly { periodStart: string; value: number }[];
}) {
  const plan = useQuery(api.plan.get, company === "us" ? {} : "skip");
  // Another company's view: one quiet line where the plan is, not an empty panel.
  if (company !== "us") {
    return (
      <section aria-labelledby="plan-heading" className="rounded-card border border-line px-5 py-4 sm:px-6">
        <h2 id="plan-heading" className="text-sm font-medium text-ink-2">
          Plan against reality
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          The financial model&apos;s plan is {COMPANIES.us.name}&apos;s, so it is set against {COMPANIES.us.name}&apos;s figures.{" "}
          {onShowStartup ? (
            <button
              type="button"
              onClick={onShowStartup}
              className="rounded-sm font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Show {COMPANIES.us.name}
            </button>
          ) : (
            `Choose ${COMPANIES.us.name} above to see it.`
          )}
        </p>
      </section>
    );
  }
  return (
    <Panel aria-labelledby="plan-heading" className="min-w-0">
      <h2 id="plan-heading" className="text-base">
        Plan against reality
      </h2>
      {plan === undefined ? (
        <Skeleton className="mt-4 h-56 rounded-inner" />
      ) : plan === null ? (
        <p className="mt-2 text-sm text-ink-2">
          No plan from the financial model yet. It arrives when the model&apos;s connector pushes it, and is then
          set against MRR, burn and cash here.
        </p>
      ) : (
        <Loaded plan={plan} summary={summary} now={now} mrr={mrr} />
      )}
    </Panel>
  );
}

function Loaded({
  plan,
  summary,
  now,
  mrr,
}: {
  plan: NonNullable<FunctionReturnType<typeof api.plan.get>>;
  summary: FinanceSummary;
  now: number;
  mrr: readonly { periodStart: string; value: number }[];
}) {
  const year = Number(summary.currentMonth.slice(0, 4));
  const chart = planChart(plan.rows, year, mrr);
  const start = runwayInputs(summary, "us");
  const projection = project({
    startMonth: summary.currentMonth.slice(0, 7),
    currency: start.currency,
    cash: start.cash,
    netBurn: start.netBurn,
    changes: [],
    fxUsdKzt: null,
  });
  const sentences = [
    mrrSentence(readMrr(plan.rows, year, mrr), year),
    burnSentence(readBurn(plan.rows, year, summary.average?.value ?? null), year),
    cashSentence(readCash(plan.rows, year, projection), year),
  ];
  const monthName = (i: number) => formatPeriod("month", chart.months[i]!);

  return (
    <>
      <p className="mt-1 text-xs text-ink-3">
        {`Financial model · ${year}, ${PLAN_SCENARIO_LABELS.base.toLowerCase()} scenario · pushed ${dayLabel(periodStart("day", plan.syncedAt), now)}`}
      </p>
      {chart.drawable ? (
        <div className="mt-4">
          <ul aria-label="Legend" className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-2">
            <li className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="16" height="8"><line x1="1" y1="4" x2="15" y2="4" stroke={ACTUAL} strokeWidth="2" strokeLinecap="round" /></svg>
              MRR
            </li>
            <li className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="16" height="8"><line x1="1" y1="4" x2="15" y2="4" stroke={PLAN} strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round" /></svg>
              Base plan
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-4 rounded-[3px] opacity-20 forced-color-adjust-none" style={{ backgroundColor: PLAN }} />
              Bear to bull
            </li>
          </ul>
          <LineChart
            label={`MRR in ${year} against the plan`}
            xs={chart.months}
            xLabel={(i) => formatPeriod("month", chart.months[i]!, "short")}
            xName={monthName}
            labelEvery={3}
            format={formatUsd}
            lines={[
              // With no line for the plan, the year-end figures stand alone at December.
              {
                id: "plan",
                label: "Base plan",
                color: PLAN,
                dashed: true,
                values: chart.base ?? chart.months.map((_, i) => (i === 11 && chart.yearEnd ? chart.yearEnd.base : null)),
                dots: chart.base === null,
              },
              { id: "mrr", label: "MRR", color: ACTUAL, values: chart.actual, dots: true },
            ]}
            band={
              chart.band !== null
                ? { label: "Bear to bull", color: PLAN, values: chart.band }
                : null
            }
          />
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-3">
          The chart needs three months of MRR in {year}; the sentences below use what there is.
        </p>
      )}
      <ul className="mt-4 space-y-2 text-sm text-ink">
        {sentences.map((sentence) => (
          <li key={sentence} className="flex gap-2">
            <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3" />
            {sentence}
          </li>
        ))}
      </ul>
    </>
  );
}
