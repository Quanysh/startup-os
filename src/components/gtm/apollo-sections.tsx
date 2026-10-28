"use client";

import type { ReactNode } from "react";
import { getMetric, type MetricDef } from "@convex/lib/metricRegistry";
import { periodStart } from "@convex/lib/periods";
import { Note } from "@/components/finance/notes";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { MetricTile } from "@/components/metrics/metric-tile";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel } from "@/components/panel";
import {
  Blank,
  DataBody,
  DataCell,
  DataFoot,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { dayLabel, formatExact, formatPeriod, formatValue } from "@/lib/format";
import {
  idleDays,
  listAgeDays,
  newestPoint,
  rateOf,
  sequenceStatus,
  sequenceTotals,
  stageRows,
  weeklyCounts,
  type SequenceRow,
  type StageCount,
} from "@/lib/metrics/apollo";
import type { Point } from "@/lib/metrics/derive";
import { MIN_DELIVERED_FOR_VERDICT } from "@/lib/metrics/gtm";
import { metricFreshness, type Tile } from "@/lib/metrics/scorecard";

/** What `workTools.outbound` returns: Apollo's two shared lists and when each was read. */
export type ApolloLists = {
  sequences: { readAt: number | null; rows: SequenceRow[] };
  stages: { readAt: number | null; rows: StageCount[] };
  lastOkAt: number | null;
};

const count = (n: number) => formatValue(n, "count");
const percent = (n: number) => formatValue(n, "percent");
const short = (week: string) => formatPeriod("week", week, "short");
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const metricOf = (key: string): MetricDef => {
  const metric = getMetric(key);
  if (!metric) throw new Error(`"${key}" is not in the registry.`);
  return metric;
};

// The words every part of these sections uses for "not read yet".
const ARRIVES = "Arrives with the daily Apollo read.";

/**
 * Apollo beyond its three totals: the sequences, the prospects behind them,
 * and the tasks and calls waiting on someone. Numbers come from the scorecard
 * (the registry's Apollo metrics, Startup's scope); the two lists come from
 * `workTools.outbound`. `lists` is undefined while that loads.
 *
 * A missing number is never a zero here: a tile with no figure says "No value
 * yet" and why, and a section with nothing at all says, once, that it arrives
 * with the daily read.
 */
export function ApolloSections({
  tiles,
  now,
  lists,
}: {
  tiles: readonly Tile[];
  now: number;
  lists: ApolloLists | undefined;
}) {
  if (lists === undefined) {
    return (
      <div className="space-y-6" aria-busy>
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-card" />
        ))}
      </div>
    );
  }
  return (
    <>
      <Sequences list={lists.sequences} now={now} />
      <Prospects tiles={tiles} stages={lists.stages} now={now} />
      <TasksAndCalls tiles={tiles} now={now} />
    </>
  );
}

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className="text-base">
        {title}
      </h3>
      <p className="max-w-3xl text-xs leading-relaxed text-ink-2">{intro}</p>
      {children}
    </section>
  );
}

/** The one sentence a section says before Apollo has been read for it. */
const NotYet = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-ink-3">{children}</p>
);

/** A line that makes what is under it less sure. Always with its icon. */
const Stale = ({ children }: { children: ReactNode }) => (
  <div className="text-xs leading-relaxed text-ink-2">
    <Note caution>{children}</Note>
  </div>
);

// ── Sequences ───────────────────────────────────────────────────────────────

/** A counter, with its share of delivered once enough was delivered for one. */
function withRate(part: number, delivered: number) {
  const rate = rateOf(part, delivered);
  return (
    <>
      {count(part)}
      {rate !== null && <span className="text-ink-2"> ({percent(rate)})</span>}
    </>
  );
}

function Sequences({ list, now }: { list: ApolloLists["sequences"]; now: number }) {
  const { rows, readAt } = list;
  const age = readAt === null ? null : listAgeDays(readAt, now);
  const totals = sequenceTotals(rows);
  // Said only while some row, or the totals row, is shown without its rates.
  const someWithoutRate =
    rows.some((row) => row.delivered < MIN_DELIVERED_FOR_VERDICT) ||
    (rows.length > 1 && totals.delivered < MIN_DELIVERED_FOR_VERDICT);
  return (
    <Section
      id="apollo-sequences"
      title="Sequences"
      intro="Every sequence in Apollo, most recently used first, with its own counts to date."
    >
      {readAt === null ? (
        <NotYet>The sequence list arrives with the daily Apollo read.</NotYet>
      ) : (
        <>
          {age !== null && (
            <Stale>{`Out of date: the sequence list was last read ${days(age)} ago.`}</Stale>
          )}
          <Panel className="min-w-0">
            <DataTable caption="Apollo sequences" className="min-w-[46rem]">
              <DataHead>
                <DataHeader pinned>Sequence</DataHeader>
                <DataHeader>Status</DataHeader>
                <DataHeader numeric>Steps</DataHeader>
                <DataHeader numeric>Delivered</DataHeader>
                <DataHeader numeric>Opened</DataHeader>
                <DataHeader numeric>Replied</DataHeader>
                <DataHeader numeric>Bounced</DataHeader>
                <DataHeader>Last used</DataHeader>
              </DataHead>
              <DataBody>
                {rows.map((row) => {
                  const status = sequenceStatus(row);
                  const idle = idleDays(row, now);
                  return (
                    <DataRow key={row.sequenceId} tone={idle === null ? undefined : "warning"}>
                      <DataRowHeader pinned className="break-words">
                        {row.name}
                      </DataRowHeader>
                      <DataCell>
                        <StatusChip tone={status.tone}>{status.label}</StatusChip>
                      </DataCell>
                      <DataCell numeric>{count(row.steps)}</DataCell>
                      <DataCell numeric>{count(row.delivered)}</DataCell>
                      <DataCell numeric>{withRate(row.opened, row.delivered)}</DataCell>
                      <DataCell numeric>{withRate(row.replied, row.delivered)}</DataCell>
                      <DataCell numeric>{count(row.bounced)}</DataCell>
                      <DataCell className="whitespace-nowrap">
                        {row.lastUsedAt === undefined ? (
                          <Blank>Never used</Blank>
                        ) : (
                          <span className="font-num">{dayLabel(row.lastUsedAt, now)}</span>
                        )}
                        {idle !== null && (
                          <StatusChip tone="warning" className="ml-2">
                            {`Idle ${days(idle)}`}
                          </StatusChip>
                        )}
                      </DataCell>
                    </DataRow>
                  );
                })}
              </DataBody>
              {rows.length > 1 && (
                <DataFoot>
                  <DataRow plain>
                    <DataRowHeader pinned>All sequences</DataRowHeader>
                    <DataCell />
                    <DataCell />
                    <DataCell numeric>{count(totals.delivered)}</DataCell>
                    <DataCell numeric>{withRate(totals.opened, totals.delivered)}</DataCell>
                    <DataCell numeric>{withRate(totals.replied, totals.delivered)}</DataCell>
                    <DataCell numeric>{count(totals.bounced)}</DataCell>
                    <DataCell />
                  </DataRow>
                </DataFoot>
              )}
            </DataTable>
          </Panel>
          {someWithoutRate && (
            <p className="text-xs text-ink-2">
              {`Open and reply rates are given from ${MIN_DELIVERED_FOR_VERDICT} emails delivered; under that, the counts alone.`}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

// ── Shared by the two sections of numbers ───────────────────────────────────

const seriesOf = (tiles: readonly Tile[], key: string): Point[] =>
  tiles.find((tile) => tile.key === key && tile.scope === "us")?.series ?? [];

/** One of Apollo's daily levels as the page's own tile; nothing if the scorecard sent none. */
function Level({ tiles, metricKey, now }: { tiles: readonly Tile[]; metricKey: string; now: number }) {
  const metric = metricOf(metricKey);
  const tile = tiles.find((t) => t.key === metricKey && t.scope === "us");
  if (!tile) return null;
  // Two points are a change, which the badge already says.
  return <MetricTile metric={metric} tile={tile} now={now} minTrend={3} />;
}

/** The week a daily level was last read in, if that is past its limit; else null. */
function staleWeek(tiles: readonly Tile[], key: string, now: number): string | null {
  const newest = newestPoint(seriesOf(tiles, key));
  if (newest === null) return null;
  return metricFreshness(now, metricOf(key), "us", newest.periodStart) === "stale"
    ? newest.periodStart
    : null;
}

/**
 * A week's own count: last week as a figure, and the weeks on record as a
 * chart once there are enough of them to be one.
 *
 * State table for the figure (first matching row wins):
 *   nothing on record            → no value; "Arrives with the daily Apollo read."
 *   no row for last week         → no value; "No count for last week yet: the newest is for the week of …"
 *   a row for last week          → its value (0 is a real 0); "The week of …"
 */
function WeeklyFigure({
  label,
  series,
  now,
  noneIn,
}: {
  label: string;
  series: readonly Point[];
  now: number;
  /** Said when there are weeks enough for a chart and every one is zero. */
  noneIn?: (weeks: number) => string;
}) {
  const { weeks, lastWeek, newest, chart } = weeklyCounts(series, periodStart("week", now));
  if (newest === null) {
    return (
      <DerivedTile label={label} value={null}>
        <Note>{ARRIVES}</Note>
      </DerivedTile>
    );
  }
  if (lastWeek === null) {
    return (
      <DerivedTile label={label} value={null}>
        <Note caution>
          {`No count for last week yet: the newest is for the week of ${short(newest.periodStart)}.`}
        </Note>
      </DerivedTile>
    );
  }
  const allZero = !chart && weeks.length >= 3 && noneIn !== undefined;
  return (
    <DerivedTile
      label={label}
      value={count(lastWeek.value)}
      exact={formatExact(lastWeek.value, "count")}
    >
      <Note>{`The week of ${short(lastWeek.periodStart)}.`}</Note>
      {allZero && <Note>{noneIn(weeks.length)}</Note>}
    </DerivedTile>
  );
}

/** The weeks on record as bars, only where they make a chart (`weeklyCounts`). */
function WeeklyChart({
  title,
  label,
  series,
  now,
}: {
  title: string;
  label: string;
  series: readonly Point[];
  now: number;
}) {
  const { weeks, chart } = weeklyCounts(series, periodStart("week", now));
  if (!chart) return null;
  return (
    <Panel className="min-w-0">
      <MonthBars
        title={title}
        grain="week"
        mode="grouped"
        series={[{ id: "value", label, color: "var(--chart-1)" }]}
        rows={weeks.map((point) => ({
          periodStart: point.periodStart,
          values: { value: point.value },
        }))}
        format={count}
      />
    </Panel>
  );
}

// ── Prospects ───────────────────────────────────────────────────────────────

function StageTable({
  entity,
  stages,
}: {
  entity: StageCount["entity"];
  stages: readonly StageCount[];
}) {
  const rows = stageRows(stages, entity);
  const plural = entity === "contact" ? "Contacts" : "Accounts";
  if (rows.length === 0) {
    // Apollo's report lists only the stages someone is at.
    return (
      <p className="text-sm text-ink-3">{`Apollo's report lists no stage for ${plural.toLowerCase()}.`}</p>
    );
  }
  return (
    <DataTable caption={`${plural} by stage`} showCaption>
      <DataHead>
        <DataHeader>Stage</DataHeader>
        <DataHeader numeric>{plural}</DataHeader>
        <DataHeader numeric>Share</DataHeader>
      </DataHead>
      <DataBody>
        {rows.map((row) => (
          <DataRow key={row.stage}>
            <DataRowHeader className="break-words">{row.stage}</DataRowHeader>
            <DataCell numeric>{count(row.count)}</DataCell>
            <DataCell numeric>{row.share === null ? <Blank /> : percent(row.share)}</DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}

function Prospects({
  tiles,
  stages,
  now,
}: {
  tiles: readonly Tile[];
  stages: ApolloLists["stages"];
  now: number;
}) {
  const added = seriesOf(tiles, "apollo_contacts_added");
  const nothing =
    stages.readAt === null &&
    added.length === 0 &&
    seriesOf(tiles, "apollo_contacts").length === 0 &&
    seriesOf(tiles, "apollo_accounts").length === 0;
  const week = staleWeek(tiles, "apollo_contacts", now);
  const age = stages.readAt === null ? null : listAgeDays(stages.readAt, now);
  return (
    <Section
      id="apollo-prospects"
      title="Prospects"
      intro="Who is in Apollo to be reached: contacts, the accounts they belong to, and the stage each stands at. Counts only."
    >
      {nothing ? (
        <NotYet>Contacts, accounts and their stages arrive with the daily Apollo read.</NotYet>
      ) : (
        <>
          {week !== null && (
            <Stale>{`Out of date: contacts and accounts were last read in the week of ${short(week)}.`}</Stale>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Level tiles={tiles} metricKey="apollo_contacts" now={now} />
            <Level tiles={tiles} metricKey="apollo_accounts" now={now} />
            <WeeklyFigure label="Contacts added last week" series={added} now={now} />
          </div>
          {stages.readAt === null ? (
            <NotYet>Stages arrive with the daily Apollo read.</NotYet>
          ) : (
            <>
              {age !== null && (
                <Stale>{`Out of date: stages were last read ${days(age)} ago.`}</Stale>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel className="min-w-0">
                  <StageTable entity="contact" stages={stages.rows} />
                </Panel>
                <Panel className="min-w-0">
                  <StageTable entity="account" stages={stages.rows} />
                </Panel>
              </div>
            </>
          )}
          <WeeklyChart
            title="Contacts added by week"
            label="Contacts added"
            series={added}
            now={now}
          />
        </>
      )}
    </Section>
  );
}

// ── Tasks and calls ─────────────────────────────────────────────────────────

/**
 * Overdue tasks. State table (first matching row wins):
 *   not read yet        → no value; "Arrives with the daily Apollo read."
 *   above zero          → the count, a danger chip "Overdue", and whose they are
 *   zero                → 0; "No task is past its due date."
 * and, in either of the last two, a caution when the figure is out of date.
 */
function OverdueTile({ tiles, now }: { tiles: readonly Tile[]; now: number }) {
  const label = "Overdue tasks";
  const newest = newestPoint(seriesOf(tiles, "apollo_tasks_overdue"));
  if (newest === null) {
    return (
      <DerivedTile label={label} value={null}>
        <Note>{ARRIVES}</Note>
      </DerivedTile>
    );
  }
  const stale = staleWeek(tiles, "apollo_tasks_overdue", now);
  return (
    <DerivedTile label={label} value={count(newest.value)} exact={formatExact(newest.value, "count")}>
      {newest.value > 0 ? (
        <>
          <p>
            <StatusChip tone="danger">Overdue</StatusChip>
          </p>
          <Note>Overdue tasks belong to sequences waiting on a manual step.</Note>
        </>
      ) : (
        <Note>No task is past its due date.</Note>
      )}
      {stale !== null && (
        <Note caution>{`Out of date: Apollo was last read in the week of ${short(stale)}.`}</Note>
      )}
    </DerivedTile>
  );
}

function TasksAndCalls({ tiles, now }: { tiles: readonly Tile[]; now: number }) {
  const calls = seriesOf(tiles, "apollo_calls");
  const nothing =
    calls.length === 0 &&
    seriesOf(tiles, "apollo_tasks_open").length === 0 &&
    seriesOf(tiles, "apollo_tasks_overdue").length === 0;
  const week = staleWeek(tiles, "apollo_tasks_open", now);
  return (
    <Section
      id="apollo-tasks"
      title="Tasks and calls"
      intro="What Apollo is waiting on a person to do, and the calls logged there."
    >
      {nothing ? (
        <NotYet>Open and overdue tasks and calls arrive with the daily Apollo read.</NotYet>
      ) : (
        <>
          {week !== null && (
            <Stale>{`Out of date: tasks were last read in the week of ${short(week)}.`}</Stale>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Level tiles={tiles} metricKey="apollo_tasks_open" now={now} />
            <OverdueTile tiles={tiles} now={now} />
            <WeeklyFigure
              label="Calls last week"
              series={calls}
              now={now}
              noneIn={(weeks) => `No call was logged in the ${weeks} weeks on record.`}
            />
          </div>
          <WeeklyChart title="Calls by week" label="Calls" series={calls} now={now} />
        </>
      )}
    </Section>
  );
}
