"use client";

import { useQuery } from "convex/react";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { runwayInputs } from "@convex/lib/budget";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import type { Currency } from "@convex/lib/metricRegistry";
import { NO_PROJECTION } from "@/components/budget/runway-section";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { formatValue } from "@/lib/format";
import type { GroupFigures } from "@/lib/finance/group";
import {
  companyCashPath,
  groupCashPath,
  isShortRunway,
  runOutLabel,
  type cashPath,
  type CashPath,
  type RunOutDay,
} from "@/lib/finance/runway-path";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { LineChart } from "./line-chart";

type Projected = Extract<CashPath, { kind: "projected" }>;

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const monthShortYear = new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** When cash runs out, as a chip or the panel says it: a day within two months, a month after. */
function runOutWords(runOut: RunOutDay, today: string) {
  if (runOut.kind === "beyond") return "Lasts beyond 24 months";
  return isShortRunway(runOut) ? `Runs out around ${runOutLabel(runOut, today)}` : `Runs out in ${runOutLabel(runOut, today)}`;
}

/** "the next 5 weeks", "the next 6 months". */
const windowWords = (path: Projected) =>
  path.window.unit === "week" ? `the next ${path.window.weeks} weeks` : `the next ${path.window.months} months`;

/**
 * Cash from today at today's net burn, to the day it runs out and no
 * further: the line stops at zero, that point is ringed and labelled, and
 * nothing is drawn below it. Weeks when it runs out within two months, else
 * the months that hold the drop; the same figures as a table.
 */
function RunwayPathChart({ path, today, currency }: { path: Projected; today: string; currency: Currency }) {
  const money = (minor: number) => formatValue(minor / 100, "currency", currency);
  const { points, span } = path;
  const runOut = path.runOut.kind === "date" ? path.runOut : null;
  const nameOf = (i: number) => {
    const point = points[i]!;
    if (point.kind === "today") return `Today, ${dayMonthYear.format(time(point.date))}`;
    if (point.kind === "run_out") return `Runs out around ${dayMonthYear.format(time(point.date))}`;
    return dayMonthYear.format(time(point.date));
  };
  const weekly = path.window.unit === "week";
  const long = path.window.unit === "month" && path.window.months > 12;
  const axis = path.ticks
    .map((tick, i) => ({
      at: span === 0 ? 0 : tick.day / span,
      label:
        i === 0
          ? "Today"
          : weekly
            ? dayMonth.format(time(tick.date))
            : tick.date.slice(5, 7) === "01"
              ? monthShortYear.format(time(tick.date))
              : monthShort.format(time(tick.date)),
    }))
    // A label every week; in months every one, every second over 12, every sixth over 24, so they never crowd.
    .filter((tick, i) => i === 0 || !long || (i - 1) % 6 === 0 || (path.ticks.length <= 14 && (i - 1) % 2 === 0))
    // The first month's label would sit on "Today".
    .filter((tick, i, all) => i === 0 || tick.at - all[0]!.at > 0.06);

  return (
    <LineChart
      label={`Cash at today's net burn, ${windowWords(path)}${runOut === null ? "" : `, until it runs out around ${dayMonthYear.format(time(runOut.date))}`}`}
      xs={points.map((p) => `${p.kind}:${p.day}`)}
      xLabel={() => ""}
      xName={nameOf}
      positions={points.map((p) => (span === 0 ? 0 : Math.min(p.day / span, 1)))}
      axis={axis}
      format={money}
      lines={[{ id: "baseline", label: "Today's burn", color: "var(--chart-1)", values: points.map((p) => p.cash) }]}
      rings={
        runOut === null
          ? []
          : [
              {
                index: points.length - 1,
                value: 0,
                color: "var(--chart-1)",
                label: "Cash runs out",
                callout: `Runs out ~${runOutLabel(runOut, today)}`,
              },
            ]
      }
    />
  );
}

/** The panel's frame: heading, the link to the tab, and what is in it. */
function RunwayFrame({ title, heading, children }: { title: string; heading: string; children: ReactNode }) {
  return (
    <Panel aria-labelledby={heading} className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={heading} className="text-base">
          {title}
        </h2>
        <Link
          href="/finance/plan"
          className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Edit on Budget and runway
          <ArrowRightIcon aria-hidden className="size-3.5" />
        </Link>
      </div>
      {children}
    </Panel>
  );
}

/**
 * The projection, led by the sentence when cash runs out within two months:
 * the chart then supports the sentence instead of carrying it.
 */
function RunwayBody({
  path,
  today,
  subject,
  cash,
  netBurn,
  note,
}: {
  path: CashPath;
  today: string;
  /** "Cash", "Group cash". */
  subject: string;
  /** Minor units, for the sentence's figures. */
  cash: number | null;
  netBurn: number | null;
  note?: ReactNode;
}) {
  if (path.kind === "unknown") {
    return (
      <>
        {note}
        <p className="mt-3 text-sm text-ink-2">{NO_PROJECTION[path.reason]}</p>
      </>
    );
  }
  const money = (minor: number) => formatValue(minor / 100, "currency", path.currency);
  const short = isShortRunway(path.runOut) && path.runOut.kind === "date";
  return (
    <>
      {short && path.runOut.kind === "date" && (
        <div className="mt-2">
          <p className="text-lg font-medium text-ink">
            {/* The spaces are explicit: a build can drop one beside an expression. */}
            {`${subject} runs out around ${runOutLabel(path.runOut, today)} at today's burn.`}
          </p>
          {cash !== null && netBurn !== null && (
            <p className="mt-0.5 font-num text-sm text-ink-2">
              {money(cash)} in the bank today, net burn {money(netBurn)} a month.
            </p>
          )}
        </div>
      )}
      {note}
      <p className="mt-1 text-xs text-ink-3">
        Cash at today&apos;s net burn over {windowWords(path)}
        {path.runOut.kind === "date" ? ", to where it runs out" : ""}
      </p>
      <div className="mt-4">
        <RunwayPathChart path={path} today={today} currency={path.currency} />
      </div>
    </>
  );
}

/** What a company's line counts, beside the other's (the group lens): the two do not add up. */
const COMPANY_NOTE: Record<CompanyId, string> = {
  us: `${COMPANIES.us.name}'s burn here includes what it sends ${COMPANIES.kz.name}, so this line and ${COMPANIES.kz.name}'s do not add up; the group runway counts that money once.`,
  kz: `${COMPANIES.kz.name}'s burn here is without new money from ${COMPANIES.us.name}, so this line and ${COMPANIES.us.name}'s do not add up; the group runway counts that money once.`,
};

/**
 * Runway and what changes it: cash from today at today's burn to the day it
 * runs out (`src/lib/finance/runway-path.ts`), and each saved scenario's
 * run-out as a chip. Scenarios are made and changed on the Budget and
 * runway tab; nothing is edited here.
 */
export function RunwayGlance({
  company,
  summary,
  today,
  named = false,
}: {
  company: CompanyId;
  summary: FinanceSummary;
  /** "YYYY-MM-DD": where the line starts. */
  today: string;
  /** Beside the other company's (the group view): the heading names whose runway it is, and says what its burn counts. */
  named?: boolean;
}) {
  const heading = useId();
  const scenarios = useQuery(api.scenarios.list, { company });
  const start = runwayInputs(summary, company);
  const pathOf = (changes: Parameters<typeof cashPath>[0]["changes"]) => companyCashPath(summary, company, today, changes);
  const baseline = pathOf([]);

  return (
    <RunwayFrame title={`Runway and what changes it${named ? ` · ${COMPANIES[company].name}` : ""}`} heading={heading}>
      <RunwayBody
        path={baseline}
        today={today}
        subject="Cash"
        cash={start.cash}
        netBurn={start.netBurn}
        note={named ? <p className="mt-1 text-xs text-ink-2">{COMPANY_NOTE[company]}</p> : undefined}
      />

      <div className="mt-5">
        <h3 className="text-sm font-medium text-ink-2">Scenarios</h3>
        {scenarios === undefined ? (
          <Skeleton className="mt-2 h-8 w-64 rounded-full" />
        ) : scenarios.length === 0 ? (
          <p className="mt-1 text-sm text-ink-2">
            None yet. Add hires, costs or revenue on Budget and runway to see how each moves the day cash runs
            out.
          </p>
        ) : (
          <ul aria-label="Scenarios" className="mt-2 flex flex-wrap gap-2">
            {scenarios.map((scenario) => {
              const path = pathOf(scenario.changes);
              return (
                <li key={scenario.id}>
                  <Link
                    href="/finance/plan"
                    className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-2xl bg-surface px-3 py-1.5 text-xs outline-none transition-colors hover:bg-table-hover focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="min-w-0 font-medium break-words text-ink">{scenario.name}</span>
                    <span className="shrink-0 text-ink-2">
                      {path.kind === "projected" ? runOutWords(path.runOut, today) : "Not known yet"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </RunwayFrame>
  );
}

/**
 * The group's runway, in the group lens above the two companies': group cash
 * in dollars at the group's net burn, the intercompany-correct figures the
 * hero divides (`groupFigures`: Startup's own spending plus Globex's own
 * burn, so what Startup sends Globex is counted once). Scenarios are each
 * company's, below.
 */
export function GroupRunwayGlance({ group, today }: { group: GroupFigures; today: string }) {
  const heading = useId();
  const cash = group.cash.kind === "known" ? Math.round(group.cash.usd * 100) : null;
  const netBurn = group.netBurn.kind === "known" ? Math.round(group.netBurn.usd * 100) : null;
  const path = groupCashPath(group, today);
  const note = (
    <p className="mt-1 text-xs text-ink-2">
      Group cash in dollars at the group&apos;s net burn: {COMPANIES.us.name}&apos;s own spending plus {COMPANIES.kz.name}&apos;s own burn, what{" "}
      {COMPANIES.us.name} sends {COMPANIES.kz.name} counted once. Scenarios are each company&apos;s, below.
    </p>
  );
  return (
    <RunwayFrame title="Group runway" heading={heading}>
      {path.kind === "unknown" ? (
        <>
          {note}
          <p className="mt-3 text-sm text-ink-2">
            Not known yet: the group&apos;s {cash === null ? "cash" : "net burn"} is not known. The figures at the top of
            the page say what is missing.
          </p>
        </>
      ) : (
        <RunwayBody path={path} today={today} subject="Group cash" cash={cash} netBurn={netBurn} note={note} />
      )}
    </RunwayFrame>
  );
}
