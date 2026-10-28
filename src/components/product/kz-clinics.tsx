"use client";

import { useQuery } from "convex/react";
import { XIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { KZ_MODULES, type KzModuleId } from "@convex/lib/kzProductDetail";
import { Delta } from "@/components/metrics/change-chip";
import { Panel } from "@/components/panel";
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
import { useViewer } from "@/hooks/use-viewer";
import { dayLabel } from "@/lib/format";
import { changeOf, kzClinicHref, kzHref, type Week } from "@/lib/metrics/kz-detail";
import {
  CLINIC_STATUS_LABELS,
  clinicPeriodLine,
  moduleWeek,
  periodRows,
  usesModule,
  type ClinicLine,
  type ClinicStatus,
  type UsageWeek,
} from "@/lib/metrics/kz-clinics";
import { cn } from "@/lib/utils";
import { SteadyLabel } from "./steady-label";
import { UnlinkedAppClinics } from "./kz-app-link";

const count = (n: number) => n.toLocaleString("en-US");
const usual = (n: number | null) => (n === null ? "—" : n < 10 ? n.toFixed(1) : count(Math.round(n)));

const STATUS_TONE: Record<ClinicStatus, StatusTone> = {
  quiet: "danger",
  fell: "warning",
  usual: "neutral",
  grew: "success",
  new: "info",
  idle: "neutral",
};

/** The groups of regular clinics, in the order to look at them, each with what it means. */
const GROUPS: { status: ClinicStatus; title: string; means: (w: Words) => string }[] = [
  { status: "quiet", title: "Gone quiet", means: (w) => `no action ${w.last}` },
  { status: "fell", title: "Below usual", means: (w) => `under 70% of its usual ${w.unit}` },
  { status: "usual", title: "As usual", means: (w) => `within 30% of its usual ${w.unit}` },
  { status: "grew", title: "Above usual", means: (w) => `over 130% of its usual ${w.unit}` },
];

/** How the tab says its period: a week, or a span of weeks. */
type Words = { unit: string; last: string; before: string };
export const wordsFor = (span: number): Words =>
  span === 1
    ? { unit: "week", last: "last week", before: "the week before" }
    : { unit: `${span} weeks`, last: `in the last ${span} weeks`, before: `the ${span} weeks before` };

/** The filters of the all-clinics table, kept in the address (`?status=`). */
const FILTERS: (ClinicStatus | "all")[] = ["all", "quiet", "fell", "grew", "new"];
const FILTER_LABELS: Record<(typeof FILTERS)[number], string> = {
  all: "All",
  quiet: "Gone quiet",
  fell: "Fell",
  grew: "Grew",
  new: "New",
  usual: "As usual",
  idle: "Not using",
};

type Row = {
  id: Id<"customers">;
  name: string;
  weeks: readonly UsageWeek[];
  line: ClinicLine;
};

/** "10 → 0" with its chip. */
function Move({ week, better, of }: { week: Week | null; better: "up" | "down"; of?: number | null }) {
  if (week === null) return <span className="text-ink-3">Not read yet</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-num">
        {week.previous !== null && <span className="text-ink-3">{count(week.previous)} → </span>}
        <span className="font-medium text-ink">{count(week.value)}</span>
        {of != null && <span className="text-ink-3"> of {count(of)}</span>}
      </span>
      <Delta change={changeOf(week, better)} />
    </span>
  );
}

/** Five weeks of actions as small bars, last week in full ink. For the eye only: the figures are beside it. */
function FiveWeeks({ values }: { values: readonly number[] }) {
  const max = Math.max(1, ...values);
  return (
    <svg aria-hidden width={60} height={22} viewBox="0 0 60 22" className="block">
      {values.map((value, i) => {
        const height = value === 0 ? 1.5 : Math.max(2, (value / max) * 20);
        return (
          <rect
            key={i}
            x={i * 12}
            y={22 - height}
            width={9}
            height={height}
            rx={1.5}
            fill="var(--chart-1)"
            opacity={i === values.length - 1 ? 1 : 0.55}
          />
        );
      })}
    </svg>
  );
}

/** Last week's modules with their actions; one that fell to nothing is struck through. */
function ModuleChips({ line }: { line: ClinicLine }) {
  if (line.modules.length === 0) return <span className="text-ink-3">None</span>;
  return (
    <span className="flex max-w-[18rem] flex-wrap gap-1">
      {line.modules.map((m) => (
        <span
          key={m.id}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs whitespace-nowrap",
            m.now === 0 ? "text-ink-3 line-through" : "text-ink-2",
          )}
        >
          {m.label} <span className="font-num font-medium text-ink">{count(m.now)}</span>
          {m.now === 0 && <span className="sr-only"> (none last week, {count(m.previous)} the week before)</span>}
        </span>
      ))}
    </span>
  );
}

function Stat({ label, children, note }: { label: string; children: ReactNode; note: string }) {
  return (
    <div className="min-w-0 rounded-inner bg-surface p-4">
      <p className="text-xs text-ink-2">{label}</p>
      <div className="mt-1 text-xl text-ink">{children}</div>
      <p className="mt-1 text-xs text-ink-2">{note}</p>
    </div>
  );
}

/** A clinic's name as the link to its own page, the period picked kept. */
function ClinicLink({ row, span, end }: { row: Row; span: number; end: string | null }) {
  return (
    <Link
      href={kzClinicHref(row.id, span, end)}
      className="rounded-inner text-left font-medium text-ink underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {row.name}
    </Link>
  );
}

function RegularTable({
  rows,
  words,
  span,
  end,
}: {
  rows: Row[];
  words: Words;
  span: number;
  end: string | null;
}) {
  return (
    <DataTable label="Regular clinics" className="min-w-[72rem]" download={false}>
      <DataHead>
        <DataHeader pinned>Clinic</DataHeader>
        <DataHeader>{words.unit === "week" ? "Last 5 weeks" : `Last 5 periods of ${words.unit}`}</DataHeader>
        <DataHeader>Actions</DataHeader>
        <DataHeader numeric>
              <span title={`Its average actions a ${words.unit} over the 4 ${words.unit === "week" ? "weeks" : "periods"} before`}>
                Usual {words.unit}
              </span>
            </DataHeader>
        <DataHeader>Doctors working</DataHeader>
        <DataHeader>Days worked</DataHeader>
        <DataHeader>Modules, {words.last}</DataHeader>
        <DataHeader>What changed</DataHeader>
      </DataHead>
      <DataBody>
        {rows.map((row) => (
          <DataRow key={row.id}>
            <DataRowHeader pinned className="font-normal">
              <ClinicLink row={row} span={span} end={end} />
            </DataRowHeader>
            <DataCell exportValue={row.line.last5.join(" ")}>
              <FiveWeeks values={row.line.last5} />
            </DataCell>
            <DataCell>
              <Move week={row.line.actions} better="up" />
            </DataCell>
            <DataCell numeric>{usual(row.line.norm)}</DataCell>
            <DataCell>
              <Move week={row.line.doctors} better="up" of={row.line.doctorsTotal} />
            </DataCell>
            <DataCell>
              <Move week={row.line.days} better="up" />
            </DataCell>
            <DataCell>
              <ModuleChips line={row.line} />
            </DataCell>
            <DataCell className="max-w-[16rem] text-xs text-ink-2">
              {row.line.changes.length === 0 ? "—" : row.line.changes.join(" · ")}
            </DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}

/**
 * Product › Kazakhstan › Clinics, as the team's weekly report has it: the
 * regular clinics in four groups against their usual week, then every clinic
 * with a filter. A clinic's name leads to its own page. Names are the client register's,
 * read through `customers.list`, so the tab is for viewers with the Customers page.
 */
export function ClinicsView({
  now,
  module,
  span = 1,
  end = null,
}: {
  now: number;
  module: KzModuleId | null;
  span?: number;
  end?: string | null;
}) {
  const words = wordsFor(span);
  const { can } = useViewer();
  const allowed = can("customers");
  const register = useQuery(api.customers.list, allowed ? {} : "skip");
  const usage = useQuery(api.customers.usage, allowed ? {} : "skip");
  const asked = useSearchParams()?.get("status") ?? "all";
  const filter = (FILTERS as string[]).includes(asked) ? (asked as (typeof FILTERS)[number]) : "all";
  // A clinic named in the address (from a module's card) opens with the tab.
  // The table keeps the height of every clinic while a filter shortens it, so
  // the page does not scroll up under the filter that was clicked.
  const tableBox = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (filter === "all" && tableBox.current) setHeld(tableBox.current.scrollHeight);
  }, [filter, register, usage]);

  if (!allowed) {
    return (
      <Panel>
        <p className="text-sm text-ink-2">
          Clinics are named from the client register, which is on the Customers page. Ask the
          owner for that page to see each clinic here.
        </p>
      </Panel>
    );
  }
  if (register === undefined || usage === undefined) {
    return <Skeleton className="h-96 w-full rounded-card" />;
  }

  const weeksOf = new Map<string, readonly UsageWeek[]>(usage.map((u) => [u.customerId, u.weeks]));
  const moduleLabel = KZ_MODULES.find((m) => m.id === module)?.label;
  const rows: Row[] = register.customers
    .filter((c) => c.market === "kz" && !c.archived)
    .map((c) => {
      const weeks = weeksOf.get(c.id) ?? [];
      // The clinic's weeks as periods of the length picked: the rules read a period as a week.
      const periods = periodRows(weeks, span, end);
      return { id: c.id, name: c.name, weeks: periods, line: clinicPeriodLine(weeks, span, end) };
    })
    .filter((r) => module === null || usesModule(r.weeks, module));
  const byActions = (a: Row, b: Row) =>
    (b.line.actions?.value ?? -1) - (a.line.actions?.value ?? -1) ||
    (b.line.actions?.previous ?? -1) - (a.line.actions?.previous ?? -1);
  const byFall = (a: Row, b: Row) =>
    (b.line.actions?.previous ?? 0) - (b.line.actions?.value ?? 0) -
    ((a.line.actions?.previous ?? 0) - (a.line.actions?.value ?? 0));

  const regular = rows.filter((r) => r.line.regular);
  const sum = (list: Row[], pick: (w: Week) => number | null) =>
    list.reduce((total, r) => total + (r.line.actions ? (pick(r.line.actions) ?? 0) : 0), 0);
  const actionsNow = sum(regular, (w) => w.value);
  const actionsBefore = sum(regular, (w) => w.previous);
  const workedNow = regular.filter((r) => (r.line.actions?.value ?? 0) > 0).length;
  const workedBefore = regular.filter((r) => (r.line.actions?.previous ?? 0) > 0).length;
  const largest = [...regular].sort(byActions)[0];

  const counts = Object.fromEntries(
    FILTERS.map((f) => [f, f === "all" ? rows.length : rows.filter((r) => r.line.status === f).length]),
  ) as Record<(typeof FILTERS)[number], number>;
  const listed = rows
    .filter((r) => filter === "all" || r.line.status === filter)
    .sort((a, b) =>
      module !== null
        ? (moduleWeek(b.weeks, module)?.value ?? -1) - (moduleWeek(a.weeks, module)?.value ?? -1)
        : ["quiet", "fell", "new", "grew", "usual", "idle"].indexOf(a.line.status) -
            ["quiet", "fell", "new", "grew", "usual", "idle"].indexOf(b.line.status) || byFall(a, b),
    );
  const filterHref = (f: (typeof FILTERS)[number]) => {
    const params = new URLSearchParams({ product: "kz_product", view: "clinics" });
    if (module !== null) params.set("module", module);
    if (f !== "all") params.set("status", f);
    return `/product?${params.toString()}`;
  };

  return (
    <section aria-label="Clinics" className="space-y-4">
      {moduleLabel !== undefined && (
        <Link
          href={kzHref({ view: "clinics", module: null })}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-panel px-3 text-sm font-medium text-ink shadow-soft-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Uses {moduleLabel} <XIcon aria-hidden className="size-3.5" />
          <span className="sr-only">(show every clinic)</span>
        </Link>
      )}

      {module === null && (
        <Panel aria-label="Regular clinics" className="space-y-4">
          <div>
            <h2 className="text-base font-medium text-ink">Regular clinics: how they use the app</h2>
            <p className="mt-1 text-xs text-ink-2">
              Paying clinics that worked in 3 or more of the last 5 weeks · usual = the average of
              the 4 {words.unit === "week" ? "weeks" : `periods of ${words.unit}`} before, as far as the 13 weeks on
              record go · open a clinic for its card
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Regular clinics" note="paying, worked 3 or more of the last 5 weeks">
              {count(regular.length)}
            </Stat>
            <Stat label={`Worked ${words.last}`} note="clinics with at least one action">
              <span className="text-ink-3">{count(workedBefore)} → </span>
              {count(workedNow)}
            </Stat>
            <Stat label="Actions" note="every regular clinic together">
              <Move week={{ periodStart: "", value: actionsNow, previous: actionsBefore }} better="up" />
            </Stat>
            <Stat
              label="Largest"
              note={
                largest && actionsNow > 0
                  ? `${Math.round(((largest.line.actions?.value ?? 0) / actionsNow) * 100)}% of regular clinics' actions`
                  : `no action ${words.last}`
              }
            >
              <span className="block truncate">{largest?.name ?? "—"}</span>
            </Stat>
          </div>
          {GROUPS.map((group) => {
            const members = regular
              .filter((r) => r.line.status === group.status)
              .sort(group.status === "usual" || group.status === "grew" ? byActions : byFall);
            if (members.length === 0) return null;
            return (
              <div key={group.status} className="space-y-2">
                <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  <StatusChip tone={STATUS_TONE[group.status]}>
                    {group.title} · {count(members.length)}
                  </StatusChip>
                  {group.means(words)}
                </p>
                <RegularTable rows={members} words={words} span={span} end={end} />
              </div>
            );
          })}
        </Panel>
      )}

      <Panel aria-label="Every clinic" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-medium text-ink">{moduleLabel ? `Clinics using ${moduleLabel}` : "Every clinic"}</h2>
          <nav aria-label="Filter clinics" className="flex flex-wrap gap-1 rounded-full bg-surface p-1">
            {FILTERS.map((f) => (
              <Link
                key={f}
                href={filterHref(f)}
                // A filter changes the table, not the place on the page.
                scroll={false}
                aria-current={filter === f ? "true" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
                  filter === f && "bg-panel font-medium text-ink shadow-soft-sm",
                )}
              >
                <SteadyLabel>
                  {FILTER_LABELS[f]} <span className="font-num text-ink-3">{counts[f]}</span>
                </SteadyLabel>
              </Link>
            ))}
          </nav>
        </div>
        <div ref={tableBox} style={held !== null && filter !== "all" ? { minHeight: held } : undefined}>
        <DataTable caption={`Every clinic, ${words.before} → ${words.last}`} className="min-w-[56rem]">
          <DataHead>
            <DataHeader pinned>Clinic</DataHeader>
            {moduleLabel !== undefined && <DataHeader>{moduleLabel}: actions</DataHeader>}
            <DataHeader>Plan</DataHeader>
            <DataHeader>Status</DataHeader>
            <DataHeader>Actions</DataHeader>
            <DataHeader numeric>
              <span title={`Its average actions a ${words.unit} over the 4 ${words.unit === "week" ? "weeks" : "periods"} before`}>
                Usual {words.unit}
              </span>
            </DataHeader>
            <DataHeader>Doctors</DataHeader>
            <DataHeader>Last active</DataHeader>
          </DataHead>
          <DataBody>
            {listed.map((row) => (
              <DataRow
                key={row.id}
                tone={row.line.status === "quiet" ? "danger" : row.line.status === "fell" ? "warning" : undefined}
              >
                <DataRowHeader pinned className="font-normal">
                  <ClinicLink row={row} span={span} end={end} />
                </DataRowHeader>
                {module !== null && (
                  <DataCell>
                    <Move week={moduleWeek(row.weeks, module)} better="up" />
                  </DataCell>
                )}
                <DataCell>
                  {row.line.plan === null ? (
                    <span className="text-ink-3">Not read yet</span>
                  ) : (
                    <KindTag tone={row.line.plan === "paid" ? "violet" : "sand"}>{row.line.plan === "paid" ? "Paid" : "Trial"}</KindTag>
                  )}
                </DataCell>
                <DataCell>
                  {row.weeks.length === 0 ? (
                    <span className="text-ink-3">Not read yet</span>
                  ) : (
                    <StatusChip variant="outline" tone={STATUS_TONE[row.line.status]}>
                      {CLINIC_STATUS_LABELS[row.line.status]}
                    </StatusChip>
                  )}
                </DataCell>
                <DataCell>
                  <Move week={row.line.actions} better="up" />
                </DataCell>
                <DataCell numeric>{usual(row.line.norm)}</DataCell>
                <DataCell>
                  <Move week={row.line.doctors} better="up" />
                </DataCell>
                <DataCell className={row.line.lastActiveOn === null ? "text-ink-3" : "text-ink-2"}>
                  {row.line.lastActiveOn === null ? "Not read yet" : dayLabel(row.line.lastActiveOn, now)}
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
        </div>
        <p className="text-xs text-ink-2">
          Green is good news and red is not. Usual is the average of the 4{" "}
          {words.unit === "week" ? "weeks" : `periods of ${words.unit}`} before; a clinic fell under 70% of it and grew
          over 130%. Doctors over a span of weeks are a weekly average.
        </p>
      </Panel>
      <UnlinkedAppClinics />
    </section>
  );
}
