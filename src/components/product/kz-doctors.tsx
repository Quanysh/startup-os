"use client";

import { useQuery } from "convex/react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import {
  DOCTOR_WEEK_GROUPS,
  DOCTOR_WEEK_LABELS,
  DOCTOR_WEEK_NOTES,
  TRIAL_OUTCOME_LABELS,
  type DoctorWeek,
  type TrialOutcome,
} from "@convex/lib/kzProductDetail";
import { Delta } from "@/components/metrics/change-chip";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel, fieldClass } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { dayLabel, formatPeriod } from "@/lib/format";
import { changeOf, kzClinicHref, lastWeek, seriesOf, spanOf, type Week } from "@/lib/metrics/kz-detail";
import {
  CARDS,
  CARD_NOTES,
  CARD_TITLES,
  TRIAL_LISTS,
  TRIAL_LIST_LABELS,
  cardDoctors,
  doctorOver,
  eventWords,
  filterDoctors,
  isWarningEvent,
  moduleLabel,
  nextSort,
  readDoctorsView,
  segmentCounts,
  sortDoctors,
  trialDoctors,
  whoParam,
  type Card,
  type Doctor,
  type Sort,
  type SortKey,
  type Who,
} from "@/lib/metrics/kz-doctors";
import type { Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";
import { SteadyLabel } from "./steady-label";

const count = (n: number) => n.toLocaleString("en-US");
const WEEK_TONE: Record<DoctorWeek, StatusTone> = {
  daily: "success",
  usual: "success",
  new: "success",
  more: "success",
  less: "warning",
  stopped: "danger",
  dormant: "neutral",
};
const CARD_TONE: Record<Card, StatusTone> = { stopped: "danger", less: "warning", more: "success", new: "success" };
const OUTCOME_TONE: Record<TrialOutcome, StatusTone> = { paid: "success", kept: "success", left: "danger", never: "neutral" };
const LIST_ID = "kz-doctor-list";
const DAY_MS = 24 * 60 * 60 * 1000;

function Move({ week, better = "up" }: { week: Week | null; better?: "up" | "down" }) {
  if (week === null) return <span className="text-ink-3">Not read yet</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-num">
        {week.previous !== null && <span className="text-ink-3">{count(week.previous)} → </span>}
        <span className="font-medium text-ink">{count(week.value)}</span>
      </span>
      <Delta change={changeOf(week, better)} />
    </span>
  );
}
const doctorWeek = (d: Doctor): Week => ({ periodStart: d.weekStart, value: d.actions, previous: d.previous });

/** A doctor's clinic as the link to the clinic's own page. */
function ClinicName({ d, name, span, end }: { d: Doctor; name: string; span: number; end: string | null }) {
  return (
    <Link
      href={kzClinicHref(d.customerId, span, end)}
      className="rounded-sm underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {name}
    </Link>
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

function Plan({ plan }: { plan: Doctor["plan"] }) {
  if (plan === null) return null;
  return <KindTag tone={plan === "paid" ? "violet" : "sand"}>{plan === "paid" ? "Paid" : "Trial"}</KindTag>;
}

/** Writes the doctors' view into the address, keeping the rest of it. */
function useWrite() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  return (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
}

function SortHeader({
  sort,
  column,
  numeric,
  onSort,
  children,
}: {
  sort: Sort;
  column: SortKey;
  numeric?: boolean;
  onSort: (sort: Sort) => void;
  children: ReactNode;
}) {
  const state = sort.key === column ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  const Icon = state === "ascending" ? ArrowUpIcon : state === "descending" ? ArrowDownIcon : ArrowUpDownIcon;
  return (
    <DataHeader numeric={numeric} aria-sort={state}>
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, column))}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
          state !== "none" && "text-ink",
        )}
      >
        {children}
        <Icon aria-hidden className="size-3.5" />
      </button>
    </DataHeader>
  );
}

/**
 * Product › Kazakhstan › Doctors, as the team's weekly report has it. The
 * counts are the weekly figures; the names are `customers.doctorRoster`'s, so
 * they are for viewers with the Customers page, and anyone else reads counts.
 */
export function DoctorsView({
  tiles,
  now,
  span = 1,
  end = null,
}: {
  tiles: readonly Tile[];
  now: number;
  span?: number;
  end?: string | null;
}) {
  const { can } = useViewer();
  const allowed = can("customers");
  const roster = useQuery(api.customers.doctorRoster, allowed ? {} : "skip");
  const register = useQuery(api.customers.list, allowed ? {} : "skip");
  const view = readDoctorsView(useSearchParams() ?? new URLSearchParams());
  const write = useWrite();
  const [words, setWords] = useState("");

  const week = (key: string) => spanOf(tiles, key, span, end);
  const say =
    span === 1
      ? { title: "Doctors this week", worked: "Worked this week", before: "the week before", last: "last week" }
      : {
          title: `Doctors over ${span} weeks`,
          worked: `Worked in the ${span} weeks, a week on average`,
          before: `the ${span} weeks before`,
          last: `the last ${span} weeks`,
        };
  const working = week("doctors_working");
  const daily = week("doctors_daily");
  const stopped = week("doctors_stopped");
  const never = week("doctors_never_started");
  const neverRecent = week("doctors_never_started_recent");
  // Each doctor over the period picked: their actions, usual and group by the week's rules.
  const doctors = (roster ?? []).map((d) => doctorOver(d, span, end));
  const clinicName = new Map((register?.customers ?? []).map((c) => [c.id as string, c.name]));
  const clinicOf = (d: Doctor) => clinicName.get(d.customerId) ?? "—";
  const showWho = (who: Who) => {
    write({ who: whoParam(view.who !== null && whoParam(view.who) === whoParam(who) ? null : who) });
    document.getElementById(LIST_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const counts = segmentCounts(doctors);
  const lastMonday = working?.periodStart ?? doctors[0]?.weekStart ?? null;
  const since = lastMonday === null ? "" : new Date(Date.parse(`${lastMonday}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);

  return (
    <section aria-label="Doctors" className="space-y-4">
      <Panel aria-label="Doctors this week" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium text-ink">{say.title}</h2>
          {lastMonday !== null && (
            <span className="text-xs text-ink-2">
              {span === 1 ? formatPeriod("week", lastMonday) : `${span} weeks from ${lastMonday.slice(8, 10)}.${lastMonday.slice(5, 7)}`}, against {say.before}
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label={say.worked} note="doctors with at least one action">
            <Move week={working} />
          </Stat>
          <Stat label="Work every day" note={DOCTOR_WEEK_NOTES.daily}>
            <Move week={daily} />
          </Stat>
          <Stat label="Stopped" note="worked last week, not this week">
            {stopped === null ? <span className="text-ink-3">Not read yet</span> : count(stopped.value)}
          </Stat>
          <Stat
            label="Never started"
            note={`signed up in the last 90 days, no action${neverRecent ? ` (${count(neverRecent.value)} new)` : ""}`}
          >
            {never === null ? <span className="text-ink-3">Not read yet</span> : count(never.value)}
          </Stat>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink">What changed</h3>
          {!allowed ? (
            <p className="text-sm text-ink-2">
              Who the doctors are is shown with the Customers page, which you do not have.
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {CARDS.map((card) => {
                const members = cardDoctors(doctors, card);
                return (
                  <div key={card} className="space-y-2 rounded-inner border border-line p-4">
                    <div className="flex items-center justify-between gap-2">
                      <StatusChip tone={CARD_TONE[card]}>{CARD_TITLES[card]}</StatusChip>
                      <span className="text-2xl text-ink">{count(members.length)}</span>
                    </div>
                    <p className="text-xs text-ink-2">
                      {span === 1 || card !== "stopped"
                        ? CARD_NOTES[card]
                        : `worked in the ${span} weeks before, no action in the last ${span}`}
                    </p>
                    {members.length === 0 ? (
                      <p className="text-sm text-ink-3">Nobody</p>
                    ) : (
                      <ul className="divide-y divide-line">
                        {members.slice(0, 5).map((d) => (
                          <li key={d.doctorId} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                            <span className="min-w-0">
                              <span className="font-medium text-ink">{d.name}</span>
                              <span className="block truncate text-xs text-ink-2">
                                <ClinicName d={d} name={clinicOf(d)} span={span} end={end} />
                                {d.plan ? ` · ${d.plan}` : ""}
                              </span>
                            </span>
                            {card === "new" ? (
                              <span className="text-ink-2">{count(d.actions)} actions</span>
                            ) : (
                              <Move week={doctorWeek(d)} />
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {members.length > 0 && (
                      <button
                        type="button"
                        onClick={() => showWho({ kind: "card", card })}
                        className="rounded-sm text-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {members.length > 5 ? `All ${count(members.length)} in the list ↓` : "Show in the list ↓"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <details className="group">
          <summary className="cursor-pointer list-none rounded-inner text-sm font-medium text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="group-open:hidden">▸</span>
            <span className="hidden group-open:inline">▾</span> Every group of doctors and what it means
          </summary>
          <DataTable label="Groups of doctors" className="mt-2" download={false}>
            <DataHead>
              <DataHeader>Group</DataHeader>
              <DataHeader>Who is in it</DataHeader>
              <DataHeader>The week before → this week</DataHeader>
            </DataHead>
            <DataBody>
              {DOCTOR_WEEK_GROUPS.flatMap((group) =>
                group.weeks.map((w) => (
                  <DataRow key={w}>
                    <DataRowHeader className="font-normal">
                      <span className="mr-2 text-xs text-ink-3">{group.title}</span>
                      {allowed ? (
                        <button
                          type="button"
                          onClick={() => showWho({ kind: "segment", week: w })}
                          className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <StatusChip tone={WEEK_TONE[w]}>{DOCTOR_WEEK_LABELS[w]}</StatusChip>
                        </button>
                      ) : (
                        <StatusChip tone={WEEK_TONE[w]}>{DOCTOR_WEEK_LABELS[w]}</StatusChip>
                      )}
                    </DataRowHeader>
                    <DataCell className="text-ink-2">{DOCTOR_WEEK_NOTES[w]}</DataCell>
                    <DataCell className="font-num">
                      {allowed ? (
                        <>
                          <span className="text-ink-3">{count(counts[w].before)} → </span>
                          <span className="text-ink">{count(counts[w].now)}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </DataCell>
                  </DataRow>
                )),
              )}
              <DataRow>
                <DataRowHeader className="font-normal">
                  <span className="mr-2 text-xs text-ink-3">Not working</span>
                  <StatusChip tone="warning">Never started</StatusChip>
                </DataRowHeader>
                <DataCell className="text-ink-2">signed up in the last 90 days, no action · not in the list of doctors</DataCell>
                <DataCell className="font-num text-ink">{never === null ? "—" : count(never.value)}</DataCell>
              </DataRow>
            </DataBody>
          </DataTable>
        </details>
      </Panel>

      <Trials
        tiles={tiles}
        doctors={doctors}
        allowed={allowed}
        list={view.trials}
        since={since}
        clinicOf={clinicOf}
        now={now}
        write={write}
        span={span}
        end={end}
      />

      {allowed && (
        <Panel aria-label="Every doctor" className="space-y-3" id={LIST_ID}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-medium text-ink">Doctors</h2>
            <span className="text-xs text-ink-2">
              {count(filterDoctors(doctors, view.who, words, clinicOf).length)} of {count(doctors.length)} doctors with an
              action in the last 5 weeks
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={words}
              onChange={(e) => setWords(e.target.value)}
              placeholder="Search by doctor or clinic"
              aria-label="Search by doctor or clinic"
              className={cn(fieldClass, "h-9 max-w-xs")}
            />
            {view.who !== null && (
              <button
                type="button"
                onClick={() => write({ who: null })}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-panel px-3 text-sm font-medium text-ink shadow-soft-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {view.who.kind === "card" ? CARD_TITLES[view.who.card] : DOCTOR_WEEK_LABELS[view.who.week]}
                <XIcon aria-hidden className="size-3.5" />
                <span className="sr-only">(show every doctor)</span>
              </button>
            )}
          </div>
          <DataTable caption="Doctors" className="min-w-[72rem]">
            <DataHead>
              <SortHeader sort={view.sort} column="doctor" onSort={(s) => write({ sort: s.key, dir: s.dir })}>
                Doctor
              </SortHeader>
              <SortHeader sort={view.sort} column="clinic" onSort={(s) => write({ sort: s.key, dir: s.dir })}>
                Clinic
              </SortHeader>
              <DataHeader>Plan</DataHeader>
              <DataHeader>Group</DataHeader>
              <SortHeader sort={view.sort} column="loss" onSort={(s) => write({ sort: s.key, dir: s.dir })}>
                Actions
              </SortHeader>
              <SortHeader sort={view.sort} column="usual" numeric onSort={(s) => write({ sort: s.key, dir: s.dir })}>
                <span title="Their average actions a week over the 4 weeks before last week">Usual week</span>
              </SortHeader>
              <SortHeader sort={view.sort} column="last" numeric onSort={(s) => write({ sort: s.key, dir: s.dir })}>
                Last action
              </SortHeader>
              <DataHeader>Last event</DataHeader>
              <DataHeader>Module</DataHeader>
            </DataHead>
            <DataBody>
              {sortDoctors(filterDoctors(doctors, view.who, words, clinicOf), view.sort, clinicOf).map((d) => (
                <DataRow key={`${d.customerId}:${d.doctorId}`}>
                  <DataRowHeader className="font-medium">{d.name}</DataRowHeader>
                  <DataCell className="text-ink-2">
                    <ClinicName d={d} name={clinicOf(d)} span={span} end={end} />
                  </DataCell>
                  <DataCell>
                    <Plan plan={d.plan} />
                  </DataCell>
                  <DataCell className="whitespace-nowrap">
                    <StatusChip tone={WEEK_TONE[d.week]}>{DOCTOR_WEEK_LABELS[d.week]}</StatusChip>
                    {d.weekBefore !== null && d.weekBefore !== d.week && (
                      <span className="ml-1 text-xs text-ink-3">was: {DOCTOR_WEEK_LABELS[d.weekBefore].toLowerCase()}</span>
                    )}
                  </DataCell>
                  <DataCell>
                    <Move week={doctorWeek(d)} />
                  </DataCell>
                  <DataCell numeric>{d.usual === null ? "—" : d.usual.toFixed(1)}</DataCell>
                  <DataCell numeric className="text-ink-2">
                    {d.lastActiveOn === null ? "—" : dayLabel(d.lastActiveOn, now)}
                  </DataCell>
                  <DataCell>
                    {isWarningEvent(d.lastEvent) ? (
                      <StatusChip variant="outline" tone="warning">
                        {eventWords(d.lastEvent)}
                      </StatusChip>
                    ) : (
                      <span className="font-mono text-xs text-ink-3">{eventWords(d.lastEvent)}</span>
                    )}
                  </DataCell>
                  <DataCell className="text-ink-2">{moduleLabel(d.mainModule)}</DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
          <p className="text-xs text-ink-2">
            Usual week: a doctor&apos;s average actions a week over the 4 weeks before last week. Their
            group compares last week with it.
          </p>
        </Panel>
      )}

      <NewDoctors tiles={tiles} />
    </section>
  );
}

function Trials({
  tiles,
  doctors,
  allowed,
  list,
  since,
  clinicOf,
  now,
  write,
  span,
  end,
}: {
  span: number;
  end: string | null;
  tiles: readonly Tile[];
  doctors: readonly Doctor[];
  allowed: boolean;
  list: (typeof TRIAL_LISTS)[number];
  since: string;
  clinicOf: (d: Doctor) => string;
  now: number;
  write: (patch: Record<string, string | null>) => void;
}) {
  const series = (key: string) => new Map(seriesOf(tiles, key).map((p) => [p.periodStart, p.value]));
  const ended = series("trials_ended");
  const paid = series("trials_converted");
  const kept = series("trials_continuing");
  const left = series("trials_lost");
  const weeks = [...ended.keys()].sort().reverse();
  const sum = (map: Map<string, number>) => weeks.reduce((total, w) => total + (map.get(w) ?? 0), 0);
  const totals = { ended: sum(ended), paid: sum(paid), kept: sum(kept), left: sum(left) };
  // Week by week, as the chart draws it: what is left of a week's trials once
  // paid, kept and left are taken out never used the app.
  const neverUsed = weeks.reduce(
    (total, w) =>
      total + Math.max(0, (ended.get(w) ?? 0) - (paid.get(w) ?? 0) - (kept.get(w) ?? 0) - (left.get(w) ?? 0)),
    0,
  );
  const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  const people = trialDoctors(doctors, list, since);
  /** The one thing the weeks say: is the share who pay after a trial rising or falling? */
  const paidTrend = () => {
    const share = (from: number, to: number) => {
      const span = weeks.slice(from, to);
      const e = span.reduce((total, w) => total + (ended.get(w) ?? 0), 0);
      const p = span.reduce((total, w) => total + (paid.get(w) ?? 0), 0);
      return e === 0 ? null : { p, e, rate: Math.round((p / e) * 100) };
    };
    const recent = share(0, 4);
    const before = share(4, 8);
    if (recent === null) return "No trial ended in the last 4 weeks.";
    const head = `In the last 4 weeks ${count(recent.p)} of ${count(recent.e)} doctors paid after their trial (${recent.rate}%)`;
    if (before === null) return `${head}.`;
    const way = recent.rate > before.rate ? "up from" : recent.rate < before.rate ? "down from" : "the same as";
    return `${head}, ${way} ${before.rate}% in the 4 weeks before.`;
  };

  return (
    <Panel aria-label="Trials that ended" className="space-y-3">
      <div>
        <h2 className="text-base font-medium text-ink">Trials that ended</h2>
        <p className="mt-1 text-xs text-ink-2">doctors whose trial ended, and what came after</p>
      </div>
      {weeks.length === 0 ? (
        <p className="text-sm text-ink-2">No trial has ended in the weeks on record.</p>
      ) : (
        <>
          <p className="text-sm text-ink">
            Since {short(weeks.at(-1)!)} a trial ended for <span className="font-medium">{count(totals.ended)}</span> doctors.
            Paid <span className="font-medium">{count(totals.paid)}</span>
            {totals.ended > 0 ? ` (${Math.round((totals.paid / totals.ended) * 100)}%)` : ""}, kept working{" "}
            <span className="font-medium">{count(totals.kept)}</span>, left <span className="font-medium">{count(totals.left)}</span>,
            never used it <span className="font-medium">{count(neverUsed)}</span>.
          </p>
          <p className="text-sm text-ink">{paidTrend()}</p>
          <MonthBars
            title="What came of trials that ended, by week"
            grain="week"
            mode="stacked"
            series={[
              { id: "paid", label: "Paid", color: "var(--chart-1)" },
              { id: "kept", label: "Kept working", color: "var(--chart-2)" },
              { id: "left", label: "Left", color: "var(--chart-4)" },
              { id: "never", label: "Never used it", color: "var(--chart-3)" },
            ]}
            rows={[...weeks].reverse().map((w) => {
              const e = ended.get(w) ?? 0;
              const p = paid.get(w) ?? 0;
              const k = kept.get(w) ?? 0;
              const l = left.get(w) ?? 0;
              return { periodStart: w, values: { paid: p, kept: k, left: l, never: Math.max(0, e - p - k - l) } };
            })}
            format={count}
          />
        </>
      )}
      {allowed && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-ink">Who</h3>
            <nav aria-label="Which trials" className="flex flex-wrap gap-1 rounded-full bg-surface p-1">
              {TRIAL_LISTS.map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={list === l}
                  onClick={() => write({ trials: l === "recent" ? null : l })}
                  className={cn(
                    "inline-flex h-8 items-center rounded-full px-3 text-sm text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
                    list === l && "bg-panel font-medium text-ink shadow-soft-sm",
                  )}
                >
                  <SteadyLabel>{TRIAL_LIST_LABELS[l]}</SteadyLabel>
                </button>
              ))}
            </nav>
          </div>
          {people.length === 0 ? (
            <p className="text-sm text-ink-2">Nobody here.</p>
          ) : (
            <DataTable caption="Doctors whose trial ended" className="min-w-[48rem]">
              <DataHead>
                <DataHeader>Doctor</DataHeader>
                <DataHeader>Clinic</DataHeader>
                <DataHeader>Trial ended</DataHeader>
                <DataHeader>What came next</DataHeader>
                <DataHeader>Actions before → since</DataHeader>
                <DataHeader numeric>Last action</DataHeader>
              </DataHead>
              <DataBody>
                {people.map((d) => (
                  <DataRow key={`${d.customerId}:${d.doctorId}`}>
                    <DataRowHeader className="font-medium">{d.name}</DataRowHeader>
                    <DataCell className="text-ink-2">
                      <ClinicName d={d} name={clinicOf(d)} span={span} end={end} />
                    </DataCell>
                    <DataCell className="text-ink-2">{dayLabel(d.trialEndedOn!, now)}</DataCell>
                    <DataCell>
                      <StatusChip tone={OUTCOME_TONE[d.trialOutcome!]}>{TRIAL_OUTCOME_LABELS[d.trialOutcome!]}</StatusChip>
                    </DataCell>
                    <DataCell className="font-num">
                      <span className="text-ink-3">{count(d.actionsBeforeTrialEnd ?? 0)} → </span>
                      <span className="text-ink">{count(d.actionsAfterTrialEnd ?? 0)}</span>
                    </DataCell>
                    <DataCell numeric className="text-ink-2">
                      {d.lastActiveOn === null ? "—" : dayLabel(d.lastActiveOn, now)}
                    </DataCell>
                  </DataRow>
                ))}
              </DataBody>
            </DataTable>
          )}
        </div>
      )}
    </Panel>
  );
}

/** New doctors who started working, by the week they came. */
function NewDoctors({ tiles }: { tiles: readonly Tile[] }) {
  const signed = seriesOf(tiles, "new_doctors");
  const started = new Map(seriesOf(tiles, "new_doctors_started").map((p) => [p.periodStart, p.value]));
  const rows = signed.map((p) => ({
    periodStart: p.periodStart,
    values: { share: p.value === 0 || !started.has(p.periodStart) ? null : Math.round(((started.get(p.periodStart) ?? 0) / p.value) * 100) },
  }));
  const never = lastWeek(seriesOf(tiles, "doctors_never_started"));
  const recent = lastWeek(seriesOf(tiles, "doctors_never_started_recent"));
  return (
    <Panel aria-label="New doctors: did they start" className="space-y-3">
      <div>
        <h2 className="text-base font-medium text-ink">New doctors: did they start working</h2>
        <p className="mt-1 text-xs text-ink-2">at least one action, by the week they came</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-2">No week read yet.</p>
      ) : (
        <MonthBars
          title="New doctors who started working"
          grain="week"
          mode="grouped"
          series={[{ id: "share", label: "Started working", color: "var(--chart-1)" }]}
          rows={rows}
          format={(v) => `${v}%`}
        />
      )}
      {never !== null && (
        <p className="text-xs text-ink-2">
          Signed up in the last 90 days and never ran anything: {count(never.value)} doctors
          {recent !== null ? ` (${count(recent.value)} of them came in the last 3 weeks)` : ""}.
        </p>
      )}
    </Panel>
  );
}
