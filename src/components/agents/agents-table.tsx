"use client";

import type { OverviewRow } from "@convex/lib/agentControl";
import { providerLabel } from "@convex/lib/agentControl";
import { STARTUP_OS_PROJECT } from "@convex/lib/agentStartupOs";
import type { RunsOn } from "@convex/lib/osAgents";

/** A Startup OS agent's budget, while its runs have no price: said, never silently ignored. */
const BUDGET_NOT_PRICED = "Not enforced: its runs are not priced.";
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
import { KindTag, StatusChip, StatusMark } from "@/components/ui/status-chip";
import { costNote, costWords, ms, percent, usd } from "@/lib/agents/view";
import { cn } from "@/lib/utils";
import { BudgetBar, ModelChip, RunsOnChip, Toggle } from "./parts";

export type AgentRow = OverviewRow & {
  project: string;
  name: string | null;
  phi: boolean | null;
  waiting: boolean;
  pending: boolean;
  /** v1.3: built here ("Built here"), and still a draft its project does not run. */
  builtHere?: boolean;
  draftOnly?: boolean;
  /** Startup OS's agents: where it runs ("Claude on the Mac" or "Gemini in Startup OS"); null for a project's. */
  runsOn?: RunsOn | null;
};

const num = (value: number) => value.toLocaleString("en-US");

/** The key an agent is known by on the page: its project and its id. */
export const agentKey = (row: { project: string; agentId: string }) => `${row.project}/${row.agentId}`;

/** An agent its project has reported nothing for: no calls, errors, latency or cost, and no budget to show. */
const silent = (row: AgentRow) =>
  row.calls7d === null &&
  row.errorRate7d === null &&
  row.p95Ms7d === null &&
  row.costToday.why === "nothing_reported" &&
  row.costMonth.why === "nothing_reported" &&
  row.budgetUsd === null;

/**
 * Every agent of the project (or of every project, with `projectNames`): its
 * switch, the model it runs on and its fallback, its prompt version, the
 * last seven days (calls, errors, worst p95), and its cost today and this
 * month against its budget. A figure that is not known says so.
 */
export function AgentsTable({
  rows,
  projectNames,
  selected,
  busy,
  onSelect,
  onToggle,
  label = "Agents",
}: {
  /** The table's name (and its download's). */
  label?: string;
  rows: readonly AgentRow[];
  /** Given when the table holds every project's agents: each project's name, by slug. */
  projectNames?: ReadonlyMap<string, string>;
  selected: string | null;
  busy: string | null;
  onSelect: (row: AgentRow) => void;
  onToggle: (row: AgentRow, on: boolean) => void;
}) {
  return (
    <DataTable label={label} download={label} className="min-w-[60rem]">
      <DataHead>
        <DataHeader pinned>Agent</DataHeader>
        {projectNames !== undefined && <DataHeader>Project</DataHeader>}
        <DataHeader narrow exportValue="On">On</DataHeader>
        <DataHeader>Model → fallback</DataHeader>
        <DataHeader narrow>Prompt</DataHeader>
        <DataHeader numeric>Calls, 7 days</DataHeader>
        <DataHeader numeric>Errors</DataHeader>
        <DataHeader numeric>p95</DataHeader>
        <DataHeader numeric>Today</DataHeader>
        <DataHeader numeric strong>
          This month
        </DataHeader>
      </DataHead>
      <DataBody>
        {rows.map((row) => {
          const key = agentKey(row);
          const on = row.enabled ?? true;
          const over = row.budgetShare !== null && row.budgetShare > 1;
          return (
            <DataRow key={key} tone={over ? "danger" : undefined} aria-current={key === selected || undefined}>
              <DataRowHeader pinned>
                <button
                  type="button"
                  onClick={() => onSelect(row)}
                  className="text-left font-medium text-ink underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {row.agentId}
                </button>
                {row.name !== null && <p className="mt-0.5 text-xs font-normal text-ink">{row.name}</p>}
                {(row.builtHere === true || (row.runsOn ?? null) !== null) && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {row.builtHere === true && <KindTag tone="violet">Built here</KindTag>}
                    {row.runsOn != null && <RunsOnChip runsOn={row.runsOn} />}
                  </p>
                )}
                {row.waiting ? (
                  <p className="mt-0.5 text-xs font-normal text-ink-2">Waiting for the project to report it</p>
                ) : (
                  row.lastSeenDay !== null && (
                    <p className="mt-0.5 text-xs font-normal text-ink-2">{`Last seen ${row.lastSeenDay}`}</p>
                  )
                )}
              </DataRowHeader>
              {projectNames !== undefined && <DataCell>{projectNames.get(row.project) ?? row.project}</DataCell>}
              <DataCell narrow exportValue={row.draftOnly === true ? "Draft" : on ? "On" : "Off"}>
                {row.draftOnly === true ? (
                  <StatusChip tone="neutral">Draft, not published</StatusChip>
                ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Toggle
                    on={on}
                    label={`${row.agentId} on`}
                    disabled={busy === key}
                    onChange={(next) => onToggle(row, next)}
                  />
                  {row.pending && (
                    <StatusChip tone="info" data-export-skip="">
                      Pending
                    </StatusChip>
                  )}
                </div>
                )}
                {!row.steered && row.draftOnly !== true && <p className="mt-1 text-xs text-ink-2">As its project set it</p>}
              </DataCell>
              <DataCell>
                {row.runsOn === "claude_mac" ? (
                  // Claude Code runs it on the Mac: the Gemini model it is
                  // kept with is used only once it is moved to Startup OS.
                  <span className="text-sm text-ink">Claude Code, on the owner&apos;s Mac</span>
                ) : row.primary === null ? (
                  <Blank />
                ) : (
                  <div className="flex flex-wrap items-center gap-1">
                    <ModelChip model={row.primary.model} provider={providerLabel(row.primary.provider)} />
                    <span aria-hidden className="text-ink-3">
                      →
                    </span>
                    {row.fallback === null ? (
                      <span className="text-xs text-ink-2">no fallback</span>
                    ) : (
                      <ModelChip model={row.fallback.model} provider={providerLabel(row.fallback.provider)} />
                    )}
                  </div>
                )}
                {row.primaryObserved && <p className="mt-1 text-xs text-ink-2">As last seen</p>}
              </DataCell>
              <DataCell narrow>{row.promptVersion ?? <Blank />}</DataCell>
              {silent(row) ? (
                // Nothing reported at all: one quiet line, not "None", "—"
                // and "None reported" in each of five columns.
                <DataCell colSpan={5} className="text-xs text-ink-3">
                  Nothing reported in seven days
                </DataCell>
              ) : (
                <>
                <DataCell numeric>{row.calls7d === null ? <Blank>None</Blank> : num(row.calls7d)}</DataCell>
                <DataCell numeric>
                  {row.errorRate7d === null ? <Blank /> : percent(row.errorRate7d)}
                  {row.schemaFailureRate7d !== null && row.schemaFailureRate7d > 0 && (
                    <p className="text-xs text-ink-2">{`${percent(row.schemaFailureRate7d)} schema`}</p>
                  )}
                </DataCell>
                <DataCell numeric>{row.p95Ms7d === null ? <Blank /> : ms(row.p95Ms7d)}</DataCell>
                <DataCell numeric title={costNote(row.costToday) ?? undefined}>
                  {row.costToday.usd === null ? <Blank>{costWords(row.costToday)}</Blank> : costWords(row.costToday)}
                </DataCell>
                <DataCell numeric strong title={costNote(row.costMonth) ?? undefined}>
                  {row.costMonth.usd === null ? <Blank>{costWords(row.costMonth)}</Blank> : costWords(row.costMonth)}
                  {row.budgetUsd !== null && (
                    <div className="flex flex-col items-end">
                      {row.budgetShare !== null && <BudgetBar share={row.budgetShare} />}
                      <p
                        className={cn(
                          "mt-0.5 inline-flex items-center gap-1 text-xs font-normal",
                          over ? "text-danger-ink" : "text-ink-2",
                        )}
                      >
                        {over && <StatusMark tone="danger" className="size-3.5" />}
                        {over ? `Over the ${usd(row.budgetUsd)} budget` : `of ${usd(row.budgetUsd)}`}
                      </p>
                      {row.project === STARTUP_OS_PROJECT && row.costMonth.usd === null && (
                        <p className="mt-0.5 max-w-56 text-right text-xs font-normal whitespace-normal text-ink-2">{BUDGET_NOT_PRICED}</p>
                      )}
                    </div>
                  )}
                </DataCell>
                </>
              )}
            </DataRow>
          );
        })}
      </DataBody>
    </DataTable>
  );
}
