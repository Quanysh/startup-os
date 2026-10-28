"use client";

import { PUSH_FAILURE_WORDS, type ChangeStatus, type PushFailure } from "@convex/lib/agentControl";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { changeWords, desiredWords } from "@/lib/agents/view";
import { atWords } from "@/lib/source-freshness";
import { ChangeChip } from "./parts";

type Desired = Parameters<typeof desiredWords>[0];

export type ChangeRow = {
  id: string;
  project: string;
  launched: boolean;
  version: number;
  agentId: string;
  at: number;
  by: string;
  before: Desired | null;
  after: Desired;
  failure: PushFailure | null;
  status: ChangeStatus;
};

const statusTitle = (row: ChangeRow) =>
  row.status === "failed" && row.failure !== null
    ? PUSH_FAILURE_WORDS[row.failure]
    : row.status === "pending"
      ? "Waiting for the project to say it applied this version."
      : undefined;

/** What was changed here, newest first: when, which project and agent, what, who and whether it took. */
export function ChangeLog({
  rows,
  now,
  showAgent = true,
  projectNames,
}: {
  rows: readonly ChangeRow[];
  now: number;
  showAgent?: boolean;
  /** Given when the log holds every project's changes: each project's name, by slug. */
  projectNames?: ReadonlyMap<string, string>;
}) {
  return (
    <DataTable label="Changes" download="Agent changes" className="min-w-[44rem]">
      <DataHead>
        <DataHeader pinned>When</DataHeader>
        {projectNames !== undefined && <DataHeader>Project</DataHeader>}
        {showAgent && <DataHeader>Agent</DataHeader>}
        <DataHeader>Change</DataHeader>
        <DataHeader>By</DataHeader>
        <DataHeader numeric>Version</DataHeader>
        <DataHeader>State</DataHeader>
      </DataHead>
      <DataBody>
        {rows.map((row) => (
          <DataRow key={row.id} tone={row.status === "failed" ? "danger" : undefined}>
            <DataRowHeader pinned className="font-normal whitespace-nowrap">
              {atWords(row.at, now)}
            </DataRowHeader>
            {projectNames !== undefined && <DataCell>{projectNames.get(row.project) ?? row.project}</DataCell>}
            {showAgent && <DataCell>{row.agentId}</DataCell>}
            <DataCell>{row.launched ? `Launched: ${desiredWords(row.after)}` : changeWords(row.before, row.after)}</DataCell>
            <DataCell>{row.by}</DataCell>
            <DataCell numeric>{row.version}</DataCell>
            <DataCell>
              <ChangeChip status={row.status} title={statusTitle(row)} />
              {row.status === "failed" && row.failure !== null && (
                <p className="mt-1 text-xs text-ink-2">{PUSH_FAILURE_WORDS[row.failure]}</p>
              )}
            </DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}
