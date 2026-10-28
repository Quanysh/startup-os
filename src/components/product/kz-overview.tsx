"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { Delta } from "@/components/metrics/change-chip";
import { Panel } from "@/components/panel";
import { StatusChip } from "@/components/ui/status-chip";
import { formatPeriod } from "@/lib/format";
import { useViewer } from "@/hooks/use-viewer";
import { clinicLine } from "@/lib/metrics/kz-clinics";
import { addsUp, changeOf, spanOf, type Span } from "@/lib/metrics/kz-detail";
import { kzReport, type NamedClinic, type ReportItem } from "@/lib/metrics/kz-report";
import type { Tile } from "@/lib/metrics/scorecard";

const WATCH_ID = "kz-watch";

/**
 * Kazakhstan's clinics with their week, for the report to name. Only for a
 * viewer with the Customers page, through `customers.list`; anyone else's
 * report counts clinics without naming them.
 */
export function useNamedClinics(): NamedClinic[] {
  const { can } = useViewer();
  const allowed = can("customers");
  const register = useQuery(api.customers.list, allowed ? {} : "skip");
  const usage = useQuery(api.customers.usage, allowed ? {} : "skip");
  if (register === undefined || usage === undefined) return [];
  const weeksOf = new Map(usage.map((u) => [u.customerId as string, u.weeks]));
  return register.customers
    .filter((c) => c.market === "kz" && !c.archived)
    .map((c) => ({ name: c.name, line: clinicLine(weeksOf.get(c.id) ?? []) }));
}
const count = (n: number) => n.toLocaleString("en-US");

/** The report's figures in bold, as the weekly report sets them: "879 → 1,132 (+29%)", "6 of 11 (55%)". */
const FIGURES = /(\d[\d,.]*(?: s)? → \d[\d,.]*(?: s)?(?: \([^)]*\))?|\d[\d,]* of \d[\d,]*(?: \([^)]*\))?)/;
function Bolded({ text }: { text: string }) {
  return (
    <>
      {text.split(FIGURES).map((part, i) => (i % 2 === 1 ? <b key={i} className="font-semibold">{part}</b> : part))}
    </>
  );
}

function Linked({ item }: { item: ReportItem }) {
  return (
    <>
      {item.text}
      {item.href !== null && (
        <>
          {" "}
          <Link
            href={item.href}
            className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Open
          </Link>
        </>
      )}
    </>
  );
}

/**
 * The report on top of the overview: the main line, what to fix first as chips
 * that lead to "Errors", and a link down to what to watch and what works.
 * Worked out from the figures (`kzReport`): every sentence is a count shown below.
 */
export function KzReport({ tiles, span, end = null }: { tiles: readonly Tile[]; span: Span; end?: string | null }) {
  const report = kzReport(tiles, useNamedClinics(), span, end);
  return (
    <Panel aria-label="This week" className="space-y-3">
      <p className="text-base text-ink">
        <span className="font-medium">Main: </span>
        {report.headline.length === 0 ? "No week has been read yet." : <Bolded text={report.headline.join(" ")} />}
        {report.weekStart !== null && (
          <span className="text-ink-2">
            {" "}
            ({span === 1 ? formatPeriod("week", report.weekStart).toLowerCase() : weeksWords(report.weekStart, span)})
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {report.broken.map((item) => (
          <Link
            key={item.title}
            href={item.href ?? "#"}
            className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <StatusChip tone="danger" variant={item.pri === "P0" ? "solid" : "outline"}>
              {item.pri} · {item.title}
            </StatusChip>
          </Link>
        ))}
        {report.broken.length === 0 && (
          <StatusChip tone="success">Nothing broke this week</StatusChip>
        )}
        <a
          href={`#${WATCH_ID}`}
          onClick={() => {
            const details = document.getElementById(WATCH_ID);
            if (details instanceof HTMLDetailsElement) details.open = true;
          }}
          className="rounded-sm text-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {count(report.watch.length)} to watch · {count(report.works.length)} working ↓
        </a>
      </div>
    </Panel>
  );
}

/** What to watch (P2) and what works, folded at the foot of the overview. */
export function KzWatch({ tiles, span, end = null }: { tiles: readonly Tile[]; span: Span; end?: string | null }) {
  const { watch, works } = kzReport(tiles, useNamedClinics(), span, end);
  return (
    <Panel>
      <details id={WATCH_ID} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-inner outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span>
            <span className="text-base font-medium text-ink">To watch and what works</span>{" "}
            <span className="text-sm text-ink-2">
              {count(watch.length)} to watch · {count(works.length)} working
            </span>
          </span>
          <span className="rounded-full bg-surface px-3 py-1 text-xs text-ink-2 group-open:hidden">Show</span>
          <span className="hidden rounded-full bg-surface px-3 py-1 text-xs text-ink-2 group-open:inline">Hide</span>
        </summary>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-ink">P2 · To watch</h3>
            {watch.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">Nothing to watch this week.</p>
            ) : (
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink">
                {watch.map((item) => (
                  <li key={item.text}>
                    <Linked item={item} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium text-ink">What works</h3>
            {works.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">Nothing grew enough to call out this week.</p>
            ) : (
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink">
                {works.map((item) => (
                  <li key={item.text}>
                    <Linked item={item} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>
    </Panel>
  );
}

const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** "05.10–11.10 → 12.10–18.10": the span before, then the span from `monday` (one week, or `weeks`). */
export const weeksWords = (monday: string, weeks = 1) =>
  `${short(plusDays(monday, -7 * weeks))}–${short(plusDays(monday, -1))} → ${short(monday)}–${short(plusDays(monday, 7 * weeks - 1))}`;

function Figure({
  label,
  children,
  before,
  span,
}: {
  label: string;
  children: ReactNode;
  before: string | null;
  span: Span;
}) {
  const what = span === 1 ? "the week before" : `the ${span} weeks before`;
  return (
    <div className="min-w-0 rounded-card bg-panel p-4 shadow-soft">
      <p className="text-xs text-ink-2">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-3xl text-ink">{children}</div>
      <p className="mt-2 text-xs text-ink-2">{before === null ? `${what}: not on record` : `${what}: ${before}`}</p>
    </div>
  );
}

/**
 * The period's eight figures, as the weekly report's overview gives them:
 * each with its chip and the week before under it. Checks and clinics by
 * plan read "trial / paid".
 */
export function PeriodFigures({ tiles, span, end = null }: { tiles: readonly Tile[]; span: Span; end?: string | null }) {
  // AI cost and paying clinics are finance figures: sent only to Finance, and left out otherwise.
  const finance = useViewer().can("finance");
  const week = (key: string) => spanOf(tiles, key, span, end);
  const one = (label: string, key: string, better: "up" | "down" | "none", format: (v: number) => string = count) => {
    const w = week(key);
    // Doctors and clinics over weeks are a weekly average: one doctor is not counted four times.
    const shown = span === 1 || addsUp(key) ? label : `${label}, a week on average`;
    return (
      <Figure key={key} label={shown} span={span} before={w?.previous == null ? null : format(w.previous)}>
        {w === null ? <span className="text-base text-ink-3">Not read yet</span> : format(w.value)}
        <Delta change={changeOf(w, better)} />
      </Figure>
    );
  };
  const split = (label: string, trialKey: string, paidKey: string) => {
    const trial = week(trialKey);
    const paid = week(paidKey);
    return (
      <Figure
        key={label}
        label={span === 1 ? label : `${label}${trialKey.startsWith("clinics") ? ", a week on average" : ""}`}
        span={span}
        before={trial?.previous == null || paid?.previous == null ? null : `${count(trial.previous)} / ${count(paid.previous)}`}
      >
        {trial === null || paid === null ? (
          <span className="text-base text-ink-3">Not read yet</span>
        ) : (
          `${count(trial.value)} / ${count(paid.value)}`
        )}
      </Figure>
    );
  };
  const monday = week("checks_started")?.periodStart ?? null;
  return (
    <section aria-label="This week's figures" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-medium text-ink">
          {end !== null ? `${span === 1 ? "The week's" : `${span} weeks'`} figures` : span === 1 ? "This week's figures" : `The last ${span} weeks' figures`}
        </h2>
        {monday !== null && <span className="text-xs text-ink-2">{weeksWords(monday, span)}</span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {one("Checks started", "checks_started", "up")}
        {one("Trials ended (doctors)", "trials_ended", "none")}
        {one("Doctors with an action", "doctors_working", "up")}
        {one("Clinics that ran a check", "clinics_checking", "up")}
        {split("Checks, trial / paid", "checks_trial", "checks_paid")}
        {/* Paying clinics are paying clients: Finance's, so the split is shown only with Finance. */}
        {finance ? split("Clinics, trial / paid", "clinics_trial", "clinics_paid") : one("Clinics on a trial", "clinics_trial", "up")}
        {one("Failures", "failures_total", "down")}
        {finance && one("AI cost", "ai_cost_total", "down", (v) => `$${v.toFixed(2)}`)}
      </div>
    </section>
  );
}
