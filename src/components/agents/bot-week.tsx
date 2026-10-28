"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { COMPANIES } from "@convex/lib/company";
import type { ReactNode } from "react";

export type BotWeekRow = FunctionReturnType<typeof api.bots.telemetry>[number];

export const COMPANY_WORDS = { us: COMPANIES.us.name, kz: COMPANIES.kz.name, both: "Both" } as const;

/** A share as a percent: whole above 10%, one decimal below (2.5%). */
export function percentText(share: number): string {
  const percent = share * 100;
  return `${percent >= 10 || percent === 0 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;
}

const usd = (amount: number) => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A duration: "500 ms". */
export const msText = (ms: number) => `${ms.toLocaleString("en-US")} ms`;

/** This month's cost against the budget: what the bot reported, or that it reported none. */
export function costText(row: Pick<BotWeekRow, "costMonthUsd" | "monthlyBudgetUsd">): string {
  const budget = row.monthlyBudgetUsd === null ? null : usd(row.monthlyBudgetUsd);
  if (row.costMonthUsd === null) return budget === null ? "Not reported" : `Not reported (budget ${budget})`;
  return budget === null ? usd(row.costMonthUsd) : `${usd(row.costMonthUsd)} of ${budget}`;
}

/** A week's figure: the number, or that nothing was reported. */
function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-inner bg-surface p-3">
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * One bot's last seven UTC days on its Week tab (Bot Loop v3, J), from the
 * `agents` read's own row (`bots.telemetry`): calls, the share of its
 * proposals approved, failed calls and calls whose arguments did not fit,
 * p95, the last day it called, and this month's cost (what it reported)
 * against its budget. A figure nothing was reported for is said, never 0.
 * The table over it holds the same figures; a phone drops some of its
 * columns, so they are all here.
 */
export function BotWeekFigures({ row }: { row: BotWeekRow }) {
  return (
    <dl aria-label="Last 7 days" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Figure label="Calls">{row.calls7d === null ? "None" : row.calls7d.toLocaleString("en-US")}</Figure>
      <Figure label="Approved">{row.approvalRate === null ? "None decided" : percentText(row.approvalRate)}</Figure>
      <Figure label="Errors">{row.errorRate7d === null ? "None reported" : percentText(row.errorRate7d)}</Figure>
      <Figure label="Bad arguments">
        {row.schemaFailureRate7d === null ? "None reported" : percentText(row.schemaFailureRate7d)}
      </Figure>
      <Figure label="p95">{row.p95Ms7d === null ? "None reported" : msText(row.p95Ms7d)}</Figure>
      <Figure label="Last seen">{row.lastSeenDay ?? "Never"}</Figure>
      <Figure label="Company">{row.company === null ? "Not set" : COMPANY_WORDS[row.company]}</Figure>
      <Figure label="Cost this month">{costText(row)}</Figure>
    </dl>
  );
}
