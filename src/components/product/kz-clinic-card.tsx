"use client";

import { useQuery } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { TRIAL_OUTCOME_LABELS } from "@convex/lib/kzProductDetail";
import { GatedLink } from "@/components/gated-link";
import { Delta } from "@/components/metrics/change-chip";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { COMPANIES } from "@/lib/company";
import { dayLabel } from "@/lib/format";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel } from "@/components/panel";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { changeOf, kzClinicHref, kzHref, readPeriod, type Week } from "@/lib/metrics/kz-detail";
import { CLINIC_STATUS_LABELS, clinicPeriodLine, type ClinicLine, type ClinicStatus } from "@/lib/metrics/kz-clinics";
import { doctorOver, eventWords, isWarningEvent, type Doctor } from "@/lib/metrics/kz-doctors";
import { ClinicDoctors, ClinicTrials } from "./kz-clinic-doctors";
import { PeriodBar } from "./kz-period";
import { AppLink } from "./kz-app-link";

const CRUMB =
  "rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const count = (n: number) => n.toLocaleString("en-US");
const STATUS_TONE: Record<ClinicStatus, StatusTone> = {
  quiet: "danger",
  fell: "warning",
  usual: "neutral",
  grew: "success",
  new: "info",
  idle: "neutral",
};
const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

function Move({ week }: { week: Week | null }) {
  if (week === null) return <span className="text-ink-3">Not read yet</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-num">
        {week.previous !== null && <span className="text-ink-3">{count(week.previous)} → </span>}
        <span className="font-medium text-ink">{count(week.value)}</span>
      </span>
      <Delta change={changeOf(week, "up")} />
    </span>
  );
}

function Stat({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div className="min-w-0 rounded-inner bg-surface p-3">
      <p className="text-xs text-ink-2">{label}</p>
      <div className="mt-1 text-lg text-ink">{children}</div>
      {note && <p className="mt-1 text-xs text-ink-2">{note}</p>}
    </div>
  );
}

/**
 * What the figures say about a clinic, as the weekly report's clinic card
 * words it, first fitting first. Counts and names only: never an error's text.
 */
export function clinicHints(line: ClinicLine, doctors: readonly Doctor[]): ReactNode[] {
  const hints: ReactNode[] = [];
  const now = line.actions?.value ?? 0;
  if (now === 0 && line.lastActiveOn !== null) {
    hints.push(<>No action this week. The clinic&apos;s last action was on <b>{short(line.lastActiveOn)}</b>.</>);
  }
  const stopped = doctors.filter((d) => (d.previous ?? 0) > 0 && d.actions === 0);
  if (stopped.length > 0) {
    hints.push(
      <>
        Stopped working:{" "}
        {stopped.map((d, i) => (
          <span key={d.doctorId}>
            {i > 0 && ", "}
            <b>{d.name}</b> ({d.previous} → 0)
          </span>
        ))}
        .
      </>,
    );
  }
  for (const m of line.modules) {
    if (m.previous >= 3 && m.now === 0) {
      hints.push(<><b>{m.label}</b>: {m.previous} → 0, the module stopped being used.</>);
    }
  }
  for (const d of doctors) {
    if (isWarningEvent(d.lastEvent)) hints.push(<><b>{d.name}</b>&apos;s last event: {eventWords(d.lastEvent)}.</>);
  }
  const trials = doctors.filter((d) => d.trialEndedOn !== null && d.trialOutcome !== null);
  if (trials.length > 0) {
    hints.push(
      <>
        A trial ended for {trials.length}:{" "}
        {trials
          .map((d) => `${d.name} (${short(d.trialEndedOn!)}, ${TRIAL_OUTCOME_LABELS[d.trialOutcome!].toLowerCase()})`)
          .join(", ")}
        .
      </>,
    );
  }
  if (hints.length === 0) hints.push(<>Nothing unusual in this week&apos;s figures.</>);
  return hints;
}

/**
 * A Kazakhstan clinic's own page (`/product/kz/clinics/<id>`), as the weekly
 * report's clinic card has it, with the room a card lacked: its name, plan and
 * status; its period's figures; its 13 weeks; what the figures show; what it
 * uses and its trials side by side; and every doctor. The name is the client
 * register's, read through `customers.list`, so the page is for viewers with
 * the Customers page too.
 */
export function ClinicPage({ id }: { id: string }) {
  const params = useSearchParams();
  const period = readPeriod(params ?? new URLSearchParams());
  const { weeks: span, end } = period;
  const { can } = useViewer();
  const allowed = can("customers");
  const scorecard = useScorecard();
  const register = useQuery(api.customers.list, allowed ? {} : "skip");
  const usage = useQuery(api.customers.usage, allowed ? {} : "skip");
  const clinic = register?.customers.find((c) => c.id === id && c.market === "kz");
  const stored = useQuery(api.customers.doctors, clinic ? { customerId: clinic.id } : "skip");
  const now = useNow();

  const crumbs = (
    <nav aria-label="Where this page is" className="flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
      <Link href={kzHref({ view: "overview", module: null }, span, end)} className={CRUMB}>
        Product › Kazakhstan
      </Link>
      <span aria-hidden>›</span>
      <Link href={kzHref({ view: "clinics", module: null }, span, end)} className={CRUMB}>
        <ArrowLeftIcon aria-hidden className="mr-1 inline size-3.5" />
        Clinics
      </Link>
    </nav>
  );
  if (!allowed) {
    return (
      <div className="space-y-4">
        {crumbs}
        <Panel>
          <p className="text-sm text-ink-2">
            Clinics are named from the client register, which is on the Customers page. Ask the
            owner for that page to see a clinic here.
          </p>
        </Panel>
      </div>
    );
  }
  if (register === undefined || usage === undefined || now === null) {
    return <Skeleton className="h-96 w-full rounded-card" />;
  }
  if (clinic === undefined) {
    return (
      <div className="space-y-4">
        {crumbs}
        <Panel>
          <p className="text-sm text-ink-2">This clinic is not in Kazakhstan&apos;s client register.</p>
        </Panel>
      </div>
    );
  }

  const weeks = usage.find((u) => u.customerId === clinic.id)?.weeks ?? [];
  const line = clinicPeriodLine(weeks, span, end);
  const doctors = (stored ?? []).map((d) => doctorOver(d, span, end));
  const docsBefore = doctors.filter((d) => (d.previous ?? 0) > 0).length;
  const docsNow = doctors.filter((d) => d.actions > 0).length;
  const unit = span === 1 ? "week" : `${span} weeks`;
  const periods = span === 1 ? "weeks" : `periods of ${span} weeks`;
  const mondays = weeks.map((w) => w.weekStart);

  return (
    <div className="space-y-6">
      {crumbs}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl sm:text-3xl">
            {clinic.name}
            {line.plan && (
              <KindTag tone={line.plan === "paid" ? "violet" : "sand"}>{line.plan === "paid" ? "Paid" : "Trial"}</KindTag>
            )}
            {weeks.length > 0 && <StatusChip tone={STATUS_TONE[line.status]}>{CLINIC_STATUS_LABELS[line.status]}</StatusChip>}
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            Its use of {COMPANIES.kz.name}&apos;s app.{" "}
            <GatedLink href="/customers" className="font-medium text-brand underline-offset-2 hover:underline">
              Payments and notes on Customers
            </GatedLink>
          </p>
        </div>
        <PeriodBar
          view={{ view: "clinics", module: null }}
          period={period}
          mondays={mondays}
          sources={scorecard?.sources ?? {}}
          hrefFor={(s, e) => kzClinicHref(clinic.id, s, e)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Actions" note={span === 1 ? "the week before → last week" : `the ${unit} before → the last ${unit}`}>
          <Move week={line.actions} />
        </Stat>
        <Stat label={`Usual ${unit}`} note={`on average, the 4 ${periods} before`}>
          {line.norm === null ? "—" : line.norm.toFixed(1)}
        </Stat>
        <Stat label="Doctors working" note={`with an action in 13 weeks: ${doctors.length}`}>
          <span className="font-num">
            <span className="text-ink-3">{count(docsBefore)} → </span>
            {count(docsNow)}
          </span>
        </Stat>
        <Stat label="Last action">{line.lastActiveOn === null ? "—" : dayLabel(line.lastActiveOn, now)}</Stat>
      </div>

      <AppLink customerId={clinic.id} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel className="min-w-0">
          <MonthBars
            title="Actions and checks, the last 13 weeks"
            grain="week"
            mode="grouped"
            series={[
              { id: "actions", label: "Actions", color: "var(--chart-1)" },
              { id: "checks", label: "Checks", color: "var(--chart-2)" },
            ]}
            rows={weeks.slice(-13).map((w) => ({ periodStart: w.weekStart, values: { actions: w.actions, checks: w.checks } }))}
            format={count}
          />
        </Panel>
        <Panel aria-label="What the figures show" className="space-y-2">
          <h2 className="text-sm font-medium text-ink">What the figures show</h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink">
            {clinicHints(line, doctors).map((hint, i) => (
              <li key={i}>{hint}</li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel aria-label="What they use" className="min-w-0 space-y-2">
          <h2 className="text-sm font-medium text-ink">What they use</h2>
          {line.modules.length === 0 ? (
            <p className="text-sm text-ink-2">No module in these two {periods}.</p>
          ) : (
            <DataTable label="Modules at this clinic" download="Modules at this clinic">
              <DataHead>
                <DataHeader>Module</DataHeader>
                <DataHeader>{span === 1 ? "The week before → last week" : `The ${unit} before → the last ${unit}`}</DataHeader>
              </DataHead>
              <DataBody>
                {line.modules.map((m) => (
                  <DataRow key={m.id}>
                    <DataRowHeader className="font-normal">
                      <Link href={kzHref({ view: "modules", module: m.id }, span, end)} className={CRUMB}>
                        {m.label}
                      </Link>
                    </DataRowHeader>
                    <DataCell>
                      <Move week={{ periodStart: "", value: m.now, previous: m.previous }} />
                    </DataCell>
                  </DataRow>
                ))}
              </DataBody>
            </DataTable>
          )}
        </Panel>
        <Panel className="min-w-0">
          <ClinicTrials doctors={doctors} now={now} />
        </Panel>
      </div>

      <Panel className="min-w-0">
        <ClinicDoctors customerId={clinic.id} now={now} span={span} end={end} withTrials={false} />
      </Panel>
    </div>
  );
}
