"use client";

import { useQuery } from "convex/react";
import { useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, DEFAULT_COMPANY } from "@/lib/company";
import { monthOf } from "@/lib/payroll/input";
import { lastChange } from "@/lib/source-freshness";
import { HistoryPanel } from "./history-panel";
import { LinesPanel } from "./lines-panel";
import { MonthPanel } from "./month-panel";
import { CURRENCY_NAMES } from "./shared";

/** What someone without the Payroll page reads in its place. */
export const PAYROLL_NOT_YOURS =
  "Only the owner, and people the owner gives the Payroll page, can open this page.";

/**
 * The payroll page, for the company in view: one table of the month's people
 * and their pay (live until the month is marked paid, then frozen), the tax
 * and contribution lines, and the months paid so far. It is the `payroll`
 * area's: the owner's, and a teammate's the owner ticked it for by name, who
 * is sent only the companies they are on (the company in view is always one
 * of them).
 *
 * Anyone else gets a line and no query: every payroll function refuses them,
 * and a refused query breaks the page. That is presentation; the refusal
 * itself is the server's (`memberQuery("payroll")` and `requireCompany`).
 */
export function PayrollView() {
  const viewer = useViewer();
  const allowed = viewer.can("payroll");
  const company = useCompany() ?? DEFAULT_COMPANY;
  const now = useNow();
  // The month being looked at; null follows the calendar.
  const [chosen, setChosen] = useState<string | null>(null);
  const month = chosen ?? (now === null ? null : monthOf(now));
  const headingRef = useRef<HTMLHeadingElement>(null);

  const ask = allowed ? { company } : "skip";
  const people = useQuery(api.payroll.listPeople, ask);
  const lines = useQuery(api.payroll.listLines, ask);
  const runs = useQuery(api.payroll.listRuns, ask);
  const run = useQuery(api.payroll.getRun, allowed && month !== null ? { company, month } : "skip");

  if (!allowed) {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-2xl sm:text-3xl">Payroll</h1>
        </header>
        <Panel>
          <p className="text-sm text-ink-2">{PAYROLL_NOT_YOURS}</p>
        </Panel>
      </div>
    );
  }

  // Typed in here: when a person, a line or a saved month last changed, from
  // what this page already reads (no other function reads a payroll table).
  const changed =
    people === undefined || lines === undefined || runs === undefined
      ? undefined
      : lastChange([
          ...people.map((person) => ({ changedAt: person.changedAt })),
          ...lines.map((line) => ({ changedAt: line.changedAt })),
          ...runs.map((saved) => ({ changedAt: saved.preparedAt })),
        ]);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl">Payroll</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            What {COMPANIES[company].name} pays its people each month, in{" "}
            {CURRENCY_NAMES[MARKET_CURRENCY[company]]}: salaries, what is withheld, what the
            company pays on top, and what it all costs.{" "}
            {viewer.isOwner
              ? "Only you can open this page: payroll and costs are the owner's alone."
              : "The owner gave you this page."}
          </p>
        </div>
        <TypedFreshness label="People, lines and saved months" at={changed} />
      </header>

      {/* The clock is not known while rendering on the server. */}
      {month === null || now === null ? (
        <Skeleton className="h-48 rounded-card" />
      ) : (
        <>
          <MonthPanel
            company={company}
            month={month}
            now={now}
            run={run}
            people={people}
            lines={lines}
            onMonth={setChosen}
            headingRef={headingRef}
          />
          <LinesPanel key={`lines:${company}`} company={company} lines={lines} />
          <HistoryPanel
            runs={runs}
            now={now}
            onOpen={(opened) => {
              setChosen(opened);
              // The month is at the top of the page: take the reader there.
              headingRef.current?.focus();
            }}
          />
        </>
      )}
    </div>
  );
}
