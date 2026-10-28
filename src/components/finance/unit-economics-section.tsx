"use client";

import { useId, type ReactNode } from "react";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { CATEGORY_LABELS, firstDayOf, kztToUsd } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import { BenchmarkChip } from "@/components/metrics/benchmark-chip";
import { GatedLink } from "@/components/gated-link";
import { Panel } from "@/components/panel";
import {
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import type { Lens } from "@/lib/finance/all-costs";
import { latestRate } from "@/lib/finance/group";
import type { CompanyUnitEconomics, Figure, Made, Need, Why } from "@/lib/finance/unit-economics";
import { formatPeriod, formatValue, monthRange } from "@/lib/format";
import { BENCHMARKS, classify, type Benchmark, type Verdict } from "@/lib/metrics/benchmarks";
import type { Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";
import { useUnitEconomics } from "./use-unit-economics";

// Unit economics: what one paying customer brings in and costs, per company,
// in its own currency (src/lib/finance/unit-economics.ts). The group lens is
// a column per company and never a sum: the two sell different products to
// different customers. Gross margin and CAC payback are set against the
// published bands on Startup's figures only: every band is of US and EU
// companies, and none is shown on a Kazakhstan figure.

type RowKey =
  | "paying"
  | "revenuePerCustomer"
  | "cogsPerCustomer"
  | "grossMargin"
  | "newCustomers"
  | "smSpend"
  | "cac"
  | "cacPayback"
  | "ltv"
  | "ltvToCac";
type Format = "count" | "money" | "percent" | "months" | "ratio";

const ROWS: readonly { key: RowKey; label: string; format: Format; band?: Benchmark }[] = [
  { key: "paying", label: "Paying customers", format: "count" },
  { key: "revenuePerCustomer", label: "Revenue per customer / month", format: "money" },
  { key: "cogsPerCustomer", label: "COGS per customer / month", format: "money" },
  { key: "grossMargin", label: "Gross margin", format: "percent", band: BENCHMARKS.gross_margin_ai },
  { key: "newCustomers", label: "New customers (last 3 months)", format: "count" },
  { key: "smSpend", label: "Sales and marketing spend (last 3 months)", format: "money" },
  { key: "cac", label: "CAC", format: "money" },
  { key: "cacPayback", label: "CAC payback", format: "months", band: BENCHMARKS.cac_payback_months },
  { key: "ltv", label: "LTV", format: "money" },
  { key: "ltvToCac", label: "LTV:CAC", format: "ratio" },
];

/** Why a figure is not known, in the few words a cell holds. */
const WHY_WORDS: Record<Why, string> = {
  no_mrr: "No MRR figure yet",
  no_paying: "No paying-customer figure yet",
  no_customers: "No paying customers yet",
  no_revenue: "No revenue yet",
  no_new_customers: "No new customers in the last 3 months",
  no_churn: "No churn figure",
  no_churn_yet: "No client has churned yet",
  no_margin: "Gross margin at or below zero",
  no_tokens: "AI token cost not in yet",
  rates: "A pay rate is not set",
  circle: "Pay lines subtract each other",
  no_rate: "No USD/KZT rate",
};

const NEED_PAGES: Record<Need, string> = { costs: "Costs", payroll: "Payroll", customers: "Customers" };

/** Where a hidden figure is: "On the Payroll page", "On the Costs and Payroll pages". */
function needsWords(needs: readonly Need[]): string {
  const pages = needs.map((need) => NEED_PAGES[need]);
  return pages.length === 1 ? `On the ${pages[0]} page` : `On the ${pages.slice(0, -1).join(", ")} and ${pages.at(-1)} pages`;
}

/** What a sum leaves out, as its label says it. */
function excludesWords(excludes: readonly Need[]): string | null {
  if (excludes.length === 0) return null;
  return excludes.map((need) => (need === "payroll" ? "excludes pay" : need === "costs" ? "excludes registered costs" : "excludes clinics")).join(", ");
}

// Each company's own currency, from its identity (convex/lib/identity.ts).
const CURRENCY: Record<CompanyId, Currency> = { us: COMPANIES.us.currency, kz: COMPANIES.kz.currency };
const MINUS = "−";

/** Money in minor units, as a tile shows it: "₸250K", "$1,640". */
const money = (minor: number, currency: Currency) => formatValue(minor / 100, "currency", currency);
const percent = (fraction: number) => `${fraction < 0 ? MINUS : ""}${Math.abs(fraction * 100).toFixed(1)}%`;
const wholePercent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const monthName = (month: string) => formatPeriod("month", firstDayOf(month));

function formatted(value: number, format: Format, currency: Currency): string {
  switch (format) {
    case "count":
      return String(value);
    case "money":
      return money(value, currency);
    case "percent":
      return percent(value);
    case "months":
      return `${value.toFixed(1)} months`;
    case "ratio":
      return `${value.toFixed(1)}×`;
  }
}

/** The value a band is read against: a margin in percent, a payback in months. */
const bandValue = (value: number, format: Format) => (format === "percent" ? value * 100 : value);

const VERDICT: Record<Verdict, { tone: StatusTone; words: string }> = {
  stronger: { tone: "success", words: "Stronger than typical" },
  typical: { tone: "info", words: "Typical" },
  weaker: { tone: "warning", words: "Weaker than typical" },
};

const linkClass =
  "rounded-sm font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const BYLINE: Record<Lens, string> = {
  group:
    "One paying customer, each company in its own currency: what it brings in, what serving it costs and what winning one costs. Never added across the companies: different products, different customers.",
  us: "One paying customer: what it brings in, what serving it costs and what winning one costs.",
  kz: "One paying customer, in tenge with dollars alongside: what it brings in, what serving it costs and what winning one costs.",
};

/** Mounted by the Finance page after All costs, for the lens in view. */
export function UnitEconomicsSection({ lens, currentMonth, tiles }: { lens: Lens; currentMonth: string; tiles: readonly Tile[] }) {
  const heading = useId();
  const companies = useUnitEconomics(lens, currentMonth, tiles);
  const rate = latestRate(tiles);
  const fx = rate?.rate ?? null;
  const measured = companies.filter((c) => c.stage === "measured");
  return (
    <Panel id="unit-economics" aria-labelledby={heading} className="min-w-0 scroll-mt-6" data-lens={lens}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id={heading} className="text-base">
            Unit economics
          </h2>
          <p className="mt-0.5 max-w-xl text-xs text-ink-3">{BYLINE[lens]}</p>
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <GatedLink href="/costs" className={linkClass} otherwise={null}>
            Mark costs on Costs
          </GatedLink>
          <GatedLink href="/payroll" className={linkClass} otherwise={null}>
            Mark people on Payroll
          </GatedLink>
        </p>
      </div>

      <div className="mt-5 space-y-5">
        {lens === "group" ? (
          <GroupTable companies={companies} fx={fx} />
        ) : companies[0]!.stage === "no_customers_yet" ? (
          <NoCustomersYet ue={companies[0]!} />
        ) : (
          <Figures ue={companies[0]!} fx={fx} />
        )}
        <MadeOf companies={lens === "group" ? companies : measured} named={lens === "group"} />
        <Notes companies={companies} lens={lens} rate={rate} />
      </div>
    </Panel>
  );
}

// ── One figure ──────────────────────────────────────────────────────────────

/** A figure, or the words for why there is none. `usd`: Globex's tenge in dollars, under it. */
function Value({
  figure,
  format,
  currency,
  fx,
  large = false,
}: {
  figure: Figure;
  format: Format;
  currency: Currency;
  fx: number | null;
  large?: boolean;
}) {
  if (figure.kind === "loading") return <Blank>…</Blank>;
  if (figure.kind === "hidden") return <Blank>{needsWords(figure.needs)}</Blank>;
  if (figure.kind === "unknown") return <Blank>{WHY_WORDS[figure.why]}</Blank>;
  const excludes = excludesWords(figure.excludes);
  const usd = format === "money" && currency === "KZT" && fx !== null && fx > 0 ? kztToUsd(figure.value, fx) : null;
  return (
    <>
      <span className={cn(large && "block text-2xl font-medium tracking-tight text-ink")}>
        {formatted(figure.value, format, currency)}
      </span>
      {usd !== null && <span className="block text-xs font-normal text-ink-2">≈ {money(usd, "USD")}</span>}
      {excludes !== null && <span className="block text-xs font-medium text-ink-2">{excludes}</span>}
    </>
  );
}

// ── A company's lens ────────────────────────────────────────────────────────

function Figures({ ue, fx }: { ue: CompanyUnitEconomics; fx: number | null }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-5 min-[420px]:grid-cols-2 lg:grid-cols-4">
      {ROWS.map((row) => {
        const figure = ue[row.key];
        // Bands are of US and EU companies: never set against a Kazakhstan figure.
        const band = ue.company === "us" && figure.kind === "known" ? row.band : undefined;
        return (
          <div key={row.key} className="min-w-0">
            <dt className="text-sm text-ink-2">{row.label}</dt>
            <dd className="mt-1">
              <Value figure={figure} format={row.format} currency={ue.currency} fx={fx} large />
              {band !== undefined && figure.kind === "known" && (
                <BenchmarkChip value={bandValue(figure.value, row.format)} benchmark={band} className="mt-2" />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** What will make a company's figures work, when it has no paying customer yet. */
const NEXT_STEP: Record<CompanyId, (name: string) => string> = {
  us: (name) =>
    `What will make it work: record ${name}'s MRR and paying customers on Record a figure as they come, keep each clinic's contract date in the client register, and mark what serves customers and what wins them on Costs and Payroll.`,
  kz: () =>
    "What will make it work: MRR and paying clinics arrive with the CFO workbook, each clinic's contract date with the client register; mark what serves customers and what wins them on Costs and Payroll.",
};

function NoCustomersYet({ ue }: { ue: CompanyUnitEconomics }) {
  const { name } = COMPANIES[ue.company];
  const why =
    ue.mrr.kind === "known" && ue.mrr.value === 0 ? `MRR ${money(0, ue.currency)}` : "0 paying clinics";
  return (
    <div className="space-y-1 text-sm">
      <p className="text-ink">
        {name} has no paying customers yet ({why}).
      </p>
      <p className="text-ink-2">{NEXT_STEP[ue.company](name)}</p>
    </div>
  );
}

// ── The group ───────────────────────────────────────────────────────────────

function GroupTable({ companies, fx }: { companies: CompanyUnitEconomics[]; fx: number | null }) {
  return (
    <DataTable caption="Unit economics by company" download="Unit economics" className="min-w-[30rem]">
      <DataHead>
        <DataHeader pinned>Figure</DataHeader>
        {companies.map((ue) => (
          <DataHeader key={ue.company} numeric>
            {`${COMPANIES[ue.company].name}, ${CURRENCY[ue.company]}`}
          </DataHeader>
        ))}
      </DataHead>
      <DataBody>
        {ROWS.map((row) => (
          <DataRow key={row.key}>
            <DataRowHeader pinned>{row.label}</DataRowHeader>
            {companies.map((ue) => {
              const figure = ue[row.key];
              const verdict =
                ue.company === "us" && row.band !== undefined && figure.kind === "known"
                  ? classify(bandValue(figure.value, row.format), row.band)
                  : null;
              return (
                <DataCell key={ue.company} numeric>
                  <Value figure={figure} format={row.format} currency={ue.currency} fx={fx} />
                  {verdict !== null && (
                    <StatusChip tone={VERDICT[verdict].tone} className="mt-1">
                      {VERDICT[verdict].words}
                    </StatusChip>
                  )}
                </DataCell>
              );
            })}
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}

// ── What the figures are made of ────────────────────────────────────────────

/** "33% of pay marked as serving customers ₸550K"; pay is only ever a sum. */
function payWords(pay: Made["pay"], what: string, currency: Currency): string {
  switch (pay.kind) {
    case "hidden":
      return "pay, on the Payroll page (left out)";
    case "loading":
      return "pay …";
    case "unknown":
      return `pay marked as ${what} (not known: ${WHY_WORDS[pay.why].toLowerCase()})`;
    case "known": {
      const share = pay.share === null ? "pay" : `${wholePercent(pay.share)} of pay`;
      return pay.amount > 0 ? `${share} marked as ${what} ${money(pay.amount, currency)}` : `${share} marked as ${what}`;
    }
  }
}

function costWords(costs: Made["costs"], what: string, currency: Currency): string[] {
  switch (costs.kind) {
    case "hidden":
      return ["registered costs, on the Costs page (left out)"];
    case "loading":
      return ["registered costs …"];
    case "unknown":
      return ["registered costs (not known: no USD/KZT rate)"];
    case "known":
      return costs.parts.length === 0
        ? [`no cost line counted as ${what}`]
        : costs.parts.map((part) => `${CATEGORY_LABELS[part.category]} ${money(part.amount, currency)}`);
  }
}

function tokenWords(tokens: Made["tokens"]): string[] {
  if (tokens === null) return [];
  const month = monthName(tokens.month);
  if (tokens.kind === "unknown") {
    return [tokens.why === "no_rate" ? `AI tokens for ${month} (no USD/KZT rate to put them in tenge)` : `AI tokens for ${month} (not in yet)`];
  }
  const clinics = tokens.clinics === null ? "" : `, ${tokens.clinics} ${tokens.clinics === 1 ? "clinic" : "clinics"}`;
  return [`AI tokens ${money(tokens.usd, "USD")} (${month}${clinics})`];
}

function linesOf(ue: CompanyUnitEconomics): string[] {
  const { currency } = ue;
  const lines: string[] = [];
  if (ue.mrrMonth !== null && ue.payingMonth !== null && ue.mrr.kind === "known" && ue.paying.kind === "known" && ue.paying.value > 0) {
    lines.push(
      `Revenue per customer: MRR ${money(ue.mrr.value, currency)} (${monthName(ue.mrrMonth)}) ÷ ${ue.paying.value} paying clinics (${monthName(ue.payingMonth)}).`,
    );
  }
  const cogsTotal = ue.cogs.kind === "known" ? ` = ${money(ue.cogs.value, currency)} a month` : "";
  lines.push(
    `COGS: ${[...costWords(ue.cogsMade.costs, "serving customers", currency), payWords(ue.cogsMade.pay, "serving customers", currency), ...tokenWords(ue.cogsMade.tokens)].join(" + ")}${cogsTotal}.`,
  );
  const window = monthRange(firstDayOf(ue.window[0]!), firstDayOf(ue.window.at(-1)!));
  const contracted =
    ue.newCustomers.kind === "known"
      ? `÷ ${ue.newCustomers.value} ${ue.newCustomers.value === 1 ? "clinic" : "clinics"} contracted in those months`
      : ue.newCustomers.kind === "hidden"
        ? "÷ the clinics contracted in those months (on the Customers page)"
        : "÷ the clinics contracted in those months";
  const cacTotal = ue.cac.kind === "known" ? ` = ${money(ue.cac.value, currency)}` : "";
  lines.push(
    `CAC: what was paid ${window}, ${[...costWords(ue.smMade.costs, "sales and marketing", currency), payWords(ue.smMade.pay, "sales and marketing", currency)].join(" + ")}, ${contracted}${cacTotal}.`,
  );
  if (ue.undated !== null && ue.undated > 0) {
    lines.push(`${ue.undated} ${ue.undated === 1 ? "clinic has" : "clinics have"} no contract date and ${ue.undated === 1 ? "is" : "are"} not counted.`);
  }
  lines.push(
    ue.churn.kind === "known" && ue.churnMonth !== null
      ? `LTV: revenue per customer × gross margin ÷ monthly churn of ${ue.churn.value}% (${monthName(ue.churnMonth)}).`
      : "LTV: revenue per customer × gross margin ÷ monthly churn, which has no figure for this company.",
  );
  return lines;
}

function MadeOf({ companies, named }: { companies: CompanyUnitEconomics[]; named: boolean }) {
  if (companies.length === 0) return null;
  return (
    <div className="space-y-3 text-xs leading-relaxed text-ink-2">
      {companies.map((ue) => {
        const { name } = COMPANIES[ue.company];
        const lines =
          ue.stage === "no_customers_yet"
            ? [`No paying customers yet${ue.mrr.kind === "known" && ue.mrr.value === 0 ? ` (MRR ${money(0, ue.currency)})` : ""}: its figures start with the first one.`]
            : linesOf(ue);
        return (
          <ul key={ue.company} aria-label={named ? `What ${name}'s figures are made of` : "What the figures are made of"} className="space-y-1">
            {lines.map((line) => (
              <li key={line}>{named ? `${name} · ${line}` : line}</li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}

// ── Notes ───────────────────────────────────────────────────────────────────

/** Each reason a figure in view is not known, once, with where it is put right. */
const WHY_SENTENCES: Partial<Record<Why, (ue: CompanyUnitEconomics) => string>> = {
  no_tokens: (ue) =>
    `${COMPANIES[ue.company].name}'s AI token cost for ${monthName(ue.cogsMade.tokens?.month ?? ue.month)} has not arrived: it comes from the app's PostHog with the daily run, and COGS waits for it.`,
  no_mrr: (ue) => `${COMPANIES[ue.company].name}'s MRR has no figure yet.`,
  no_paying: (ue) => `${COMPANIES[ue.company].name}'s paying customers have no figure yet.`,
  rates: (ue) => `A pay rate is not set on ${COMPANIES[ue.company].name}'s Payroll page for someone counted here.`,
  circle: (ue) => `Two of ${COMPANIES[ue.company].name}'s pay lines subtract each other in a circle.`,
  no_rate: () => "Tenge and dollars cannot be added until a USD/KZT rate is on record: it arrives with the CFO workbook.",
};

function whysOf(ue: CompanyUnitEconomics): Why[] {
  return ROWS.flatMap((row) => {
    const figure = ue[row.key];
    return figure.kind === "unknown" ? [figure.why] : [];
  });
}

function Notes({
  companies,
  lens,
  rate,
}: {
  companies: CompanyUnitEconomics[];
  lens: Lens;
  rate: { rate: number; periodStart: string } | null;
}) {
  const lines: ReactNode[] = [];
  const seen = new Set<string>();
  // A company with no paying customer yet has its own line, which says so.
  for (const ue of companies.filter((c) => c.stage === "measured")) {
    for (const why of whysOf(ue)) {
      const sentence = WHY_SENTENCES[why]?.(ue);
      if (sentence !== undefined && !seen.has(sentence)) {
        seen.add(sentence);
        lines.push(sentence);
      }
    }
  }
  const kz = companies.find((ue) => ue.company === "kz");
  if (kz !== undefined && kz.stage === "measured") {
    lines.push(`No benchmark band on ${COMPANIES.kz.name}'s figures: the published bands are of US and EU companies.`);
    if (rate !== null) {
      lines.push(`Dollars for tenge at ₸${rate.rate.toLocaleString("en-US")} per $1, the ${formatPeriod("month", rate.periodStart)} rate.`);
    }
  }
  if (lens === "group") {
    lines.push("Not added across the companies: each sells its own product to its own customers.");
  }
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1 text-xs leading-relaxed text-ink-3">
      {lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}
