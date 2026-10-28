"use client";

import { useId, type ReactNode } from "react";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import Link from "next/link";
import { REPO_ACTIVE_DAYS } from "@convex/lib/limits";
import { periodStart } from "@convex/lib/periods";
import { Note } from "@/components/finance/notes";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { MonthBars } from "@/components/metrics/month-bars";
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
import { StatusChip } from "@/components/ui/status-chip";
import { dayLabel, formatExact, formatPeriod, formatValue } from "@/lib/format";
import { listAgeDays, weeklyCounts } from "@/lib/metrics/apollo";
import {
  STUCK_HREF,
  levelOf,
  mainStatus,
  stuckWords,
  repoTone,
  sortRepos,
  type EngineeringList,
  type Level,
  type RepoRow,
} from "@/lib/metrics/engineering";
import type { Tile } from "@/lib/metrics/scorecard";

const count = (n: number) => formatValue(n, "count");
const exact = (n: number) => formatExact(n, "count");
const short = (week: string) => formatPeriod("week", week, "short");
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const repositories = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;

// The words every part of this section uses for "not read yet".
const ARRIVES = "Arrives with the daily GitHub read.";
// The stored `prs_stuck` level is not shown: stuck is the list's count.
const LEVELS = ["prs_open", "repos_failing", "repos_tracked"] as const;

/**
 * The figures and the repositories of one company's engineering, from GitHub,
 * under the flow on the Engineering page: whether work ships (pull requests
 * merged by week), how much is open and waiting, and whether the main branch
 * builds; then the repositories behind those numbers.
 *
 * Numbers come from the scorecard (the registry's GitHub metrics, the
 * company's own scope); the list comes from `workTools.engineering`, which
 * sends only the caller's companies' repositories. `lists` is undefined while
 * that loads.
 *
 * Counts per company and per repository, never per person. A missing number
 * is never a zero: a tile with no figure says "No value yet" and why, and a
 * section with nothing at all says, once, that it arrives with the daily read.
 */
export function EngineeringFigures({
  tiles,
  now,
  lists,
  company,
  stuck,
  named = false,
}: {
  tiles: readonly Tile[];
  now: number;
  lists: EngineeringList | undefined;
  company: CompanyId;
  /** This company's stuck pull requests (`stuckCount`); null where the list was never read. */
  stuck: number | null;
  /** Say whose section it is: for a page that shows more than one company's. */
  named?: boolean;
}) {
  const headingId = useId();
  const seriesOf = (key: string) =>
    tiles.find((tile) => tile.key === key && tile.scope === company)?.series ?? [];
  const level = (key: (typeof LEVELS)[number]) => levelOf(tiles, key, company, now);

  const body = () => {
    if (lists === undefined) {
      return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-card" />
          ))}
        </div>
      );
    }
    const rows = sortRepos(lists.rows.filter((row) => row.company === company));
    const merged = seriesOf("prs_merged");
    const nothing =
      lists.readAt === null &&
      merged.length === 0 &&
      seriesOf("prs_opened").length === 0 &&
      LEVELS.every((key) => seriesOf(key).length === 0);
    if (nothing) {
      return (
        <p className="text-sm text-ink-3">
          Pull requests and build results arrive with the daily GitHub read.
        </p>
      );
    }
    // One week names how old the levels are: they are read together.
    const staleWeek = LEVELS.map(level).find((l) => l?.stale)?.periodStart ?? null;
    const weeks = weeklyCounts(merged, periodStart("week", now));
    return (
      <>
        {staleWeek !== null && (
          <Stale>{`Out of date: GitHub was last read in the week of ${short(staleWeek)}.`}</Stale>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MergedTile merged={merged} opened={seriesOf("prs_opened")} now={now} />
          <LevelTile label="Open" level={level("prs_open")}>
            <Note>Open pull requests, drafts included.</Note>
          </LevelTile>
          <StuckTile stuck={stuck} />
          <FailingTile
            failing={level("repos_failing")}
            tracked={level("repos_tracked")}
            rows={lists.readAt === null ? null : rows}
          />
        </div>
        {weeks.chart && (
          <Panel className="min-w-0">
            <MonthBars
              title="Pull requests merged by week"
              grain="week"
              mode="grouped"
              series={[{ id: "merged", label: "Merged", color: "var(--chart-1)" }]}
              rows={weeks.weeks.map((point) => ({
                periodStart: point.periodStart,
                values: { merged: point.value },
              }))}
              format={count}
            />
          </Panel>
        )}
        <Repositories rows={rows} readAt={lists.readAt} company={company} now={now} />
      </>
    );
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-base">
        {named ? `Figures and repositories · ${COMPANIES[company].name}` : "Figures and repositories"}
      </h2>
      {body()}
      <p className="max-w-3xl text-xs leading-relaxed text-ink-2">
        {`Read from GitHub once a day. These figures count pull requests by their states and dates, and repositories by their latest build: none of them is a number per person. Pull requests opened by bots are left out, and only repositories pushed to in the last ${REPO_ACTIVE_DAYS} days are listed. Weeks run Monday to Sunday, UTC.`}
      </p>
    </section>
  );
}

/** A line that makes what is under it less sure. Always with its icon. */
const Stale = ({ children }: { children: ReactNode }) => (
  <div className="text-xs leading-relaxed text-ink-2">
    <Note caution>{children}</Note>
  </div>
);

/** A figure not read yet: no value, and how it arrives. Never a zero. */
function NotYet({ label }: { label: string }) {
  return (
    <DerivedTile label={label} value={null}>
      <Note>{ARRIVES}</Note>
    </DerivedTile>
  );
}

/**
 * Pull requests merged in the last finished week. State table (first
 * matching row wins):
 *   no finished week on record   → no value; "Arrives with the daily GitHub read."
 *   no row for last week         → no value; "No count for last week yet: the newest is for the week of …"
 *   a row for last week          → its value (0 is a real 0); "The week of …", and how many were opened
 */
function MergedTile({
  merged,
  opened,
  now,
}: {
  merged: Tile["series"];
  opened: Tile["series"];
  now: number;
}) {
  const label = "Merged last week";
  const { lastWeek, newest } = weeklyCounts(merged, periodStart("week", now));
  if (newest === null) return <NotYet label={label} />;
  if (lastWeek === null) {
    return (
      <DerivedTile label={label} value={null}>
        <Note caution>
          {`No count for last week yet: the newest is for the week of ${short(newest.periodStart)}.`}
        </Note>
      </DerivedTile>
    );
  }
  const openedThen = opened.find((point) => point.periodStart === lastWeek.periodStart);
  return (
    <DerivedTile label={label} value={count(lastWeek.value)} exact={exact(lastWeek.value)}>
      <Note>{`The week of ${short(lastWeek.periodStart)}.`}</Note>
      {openedThen !== undefined && <Note>{`${count(openedThen.value)} opened that week.`}</Note>}
    </DerivedTile>
  );
}

/** A level as last read, with whatever the caller says under it. */
function LevelTile({
  label,
  level,
  children,
}: {
  label: string;
  level: Level | null;
  children?: ReactNode;
}) {
  if (level === null) return <NotYet label={label} />;
  return (
    <DerivedTile label={label} value={count(level.value)} exact={exact(level.value)}>
      {children}
    </DerivedTile>
  );
}

/**
 * Pull requests stuck: `stuckCount` over the list, by the five rules the flow
 * shows (the stored `prs_stuck` figure is not displayed). State table (first
 * matching row wins):
 *   list not read yet  → no value; "Arrives with the daily GitHub read."
 *   above zero         → the count, a danger chip "Stuck", and "N pull requests stuck" leading to them
 *   zero               → 0; "No pull request is stuck."
 */
function StuckTile({ stuck }: { stuck: number | null }) {
  if (stuck === null) return <NotYet label="Stuck" />;
  return (
    <DerivedTile label="Stuck" value={count(stuck)} exact={exact(stuck)}>
      {stuck > 0 ? (
        <>
          <p>
            <StatusChip tone="danger">Stuck</StatusChip>
          </p>
          <Note>
            <Link href={STUCK_HREF} className="underline underline-offset-2 hover:text-brand">
              {stuckWords(stuck)}
            </Link>
          </Note>
        </>
      ) : (
        <Note>No pull request is stuck.</Note>
      )}
    </DerivedTile>
  );
}

/**
 * Repositories whose main branch fails. State table (first matching row wins):
 *   not read yet                              → no value; "Arrives with the daily GitHub read."
 *   out of date                               → the count as last read: no chip
 *   above zero                                → the count and a danger chip "Failing"
 *   zero, every listed main passing           → 0 and a success chip "All passing"
 *   zero otherwise (some running, some with
 *   no checks, or the list not read)          → 0 and a success chip "None failing"
 * and, wherever the tracked count is known, of how many repositories.
 */
function FailingTile({
  failing,
  tracked,
  rows,
}: {
  failing: Level | null;
  tracked: Level | null;
  /** The company's repositories, or null while the list has not been read. */
  rows: readonly RepoRow[] | null;
}) {
  const current = failing !== null && !failing.stale;
  const unsure = rows === null ? 0 : rows.filter((row) => row.main === "pending" || row.main === "none").length;
  const allPassing = rows !== null && rows.length > 0 && rows.every((row) => row.main === "passing");
  return (
    <LevelTile label="Failing main" level={failing}>
      {current && failing.value > 0 && (
        <p>
          <StatusChip tone="danger">Failing</StatusChip>
        </p>
      )}
      {current && failing.value === 0 && (
        <p>
          <StatusChip tone="success">{allPassing ? "All passing" : "None failing"}</StatusChip>
        </p>
      )}
      {tracked !== null && (
        <Note>
          {current && failing.value === 0 && unsure > 0
            ? `Of ${repositories(tracked.value)} tracked; ${unsure} ${unsure === 1 ? "is" : "are"} running or ${unsure === 1 ? "has" : "have"} no checks.`
            : `Of ${repositories(tracked.value)} tracked.`}
        </Note>
      )}
    </LevelTile>
  );
}

/**
 * The repositories behind the figures. State table (first matching row wins):
 *   the list not read yet              → "The repository list arrives with the daily GitHub read."
 *   read, none of this company's       → "No repository of …'s was pushed to in the last 90 days."
 *   otherwise                          → the table, with its age said once it is past its limit
 */
function Repositories({
  rows,
  readAt,
  company,
  now,
}: {
  rows: readonly RepoRow[];
  readAt: number | null;
  company: CompanyId;
  now: number;
}) {
  if (readAt === null) {
    return <p className="text-sm text-ink-3">The repository list arrives with the daily GitHub read.</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-3">
        {`No repository of ${COMPANIES[company].name}'s was pushed to in the last ${REPO_ACTIVE_DAYS} days.`}
      </p>
    );
  }
  const age = listAgeDays(readAt, now);
  return (
    <>
      {age !== null && (
        <Stale>{`Out of date: the repository list was last read ${days(age)} ago.`}</Stale>
      )}
      <Panel className="min-w-0">
        <DataTable caption="Repositories" className="min-w-[38rem]">
          <DataHead>
            <DataHeader pinned>Repository</DataHeader>
            <DataHeader numeric>Merged last week</DataHeader>
            <DataHeader numeric>Open</DataHeader>
            <DataHeader numeric>Waiting</DataHeader>
            <DataHeader>Main</DataHeader>
            <DataHeader>Last push</DataHeader>
          </DataHead>
          <DataBody>
            {rows.map((row) => {
              const main = mainStatus(row.main);
              return (
                <DataRow key={row.repoId} tone={repoTone(row)}>
                  <DataRowHeader pinned className="break-words" title={row.repoId}>
                    {row.name}
                  </DataRowHeader>
                  <DataCell numeric>{count(row.mergedLastWeek)}</DataCell>
                  <DataCell numeric>{count(row.open)}</DataCell>
                  <DataCell numeric>
                    {count(row.stuck)}
                    {row.stuck > 0 && (
                      <StatusChip tone="warning" className="ml-2">
                        Waiting
                      </StatusChip>
                    )}
                  </DataCell>
                  <DataCell>
                    <StatusChip tone={main.tone}>{main.label}</StatusChip>
                  </DataCell>
                  <DataCell className="whitespace-nowrap">
                    <span className="font-num">{dayLabel(row.pushedAt, now)}</span>
                  </DataCell>
                </DataRow>
              );
            })}
          </DataBody>
        </DataTable>
      </Panel>
    </>
  );
}
