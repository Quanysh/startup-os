"use client";

import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { fieldClass, quietButtonClass } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip } from "@/components/ui/status-chip";
import { STAGES, STAGE_LABELS, ageWords, isStage, sinceWords } from "@/lib/engineering/flow";
import {
  NO_FILTERS,
  ariaSort,
  isFiltered,
  nextSort,
  repoName,
  type Filters,
  type Item,
  type Owner,
  type Sort,
  type SortKey,
  type View,
} from "@/lib/engineering/view";
import { dayLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChecksChip, OwnerChip, STAGE_TONE, TitleLink } from "./pull-bits";

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const controlClass = cn(fieldClass, "h-9 w-auto min-w-0");

/** A filter's name over its control. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2">
      {label}
      {children}
    </label>
  );
}

/**
 * The filters over the table: owner, repository, stage, stuck only, and a
 * range of days on when a pull request was opened or last active. They hold
 * no state of their own: what they show is the view in the address, and a
 * change is reported for the page to put there.
 */
export function PullFilters({
  filters,
  owners,
  repos,
  onChange,
}: {
  filters: Filters;
  /** Everyone with a pull request on the page, by name. */
  owners: readonly Owner[];
  /** Every repository with one, "org/name". */
  repos: readonly string[];
  onChange: (next: Filters) => void;
}) {
  const set = (change: Partial<Filters>) => onChange({ ...filters, ...change });
  // An owner or a repository the address names and the page does not hold is
  // still what is selected: the control says so rather than showing "all".
  const strangeOwner = filters.owner !== null && !owners.some((o) => o.key === filters.owner);
  const strangeRepo = filters.repo !== null && !repos.includes(filters.repo);
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-x-3 gap-y-3">
      <Field label="Owner">
        <select
          value={filters.owner ?? ""}
          onChange={(e) => set({ owner: e.target.value === "" ? null : e.target.value })}
          className={controlClass}
        >
          <option value="">All owners</option>
          {owners.map((owner) => (
            <option key={owner.key} value={owner.key}>
              {owner.name}
            </option>
          ))}
          {strangeOwner && <option value={filters.owner!}>Nobody on this page</option>}
        </select>
      </Field>
      <Field label="Repository">
        <select
          value={filters.repo ?? ""}
          onChange={(e) => set({ repo: e.target.value === "" ? null : e.target.value })}
          className={controlClass}
        >
          <option value="">All repositories</option>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repoName(repo)}
            </option>
          ))}
          {strangeRepo && <option value={filters.repo!}>None on this page</option>}
        </select>
      </Field>
      <Field label="Stage">
        <select
          value={filters.stage ?? ""}
          onChange={(e) => set({ stage: isStage(e.target.value) ? e.target.value : null })}
          className={controlClass}
        >
          <option value="">All stages</option>
          {STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Date">
        <select
          value={filters.by}
          onChange={(e) => set({ by: e.target.value === "activity" ? "activity" : "opened" })}
          className={controlClass}
        >
          <option value="opened">Opened</option>
          <option value="activity">Last activity</option>
        </select>
      </Field>
      <Field label="From">
        <input
          type="date"
          value={filters.from ?? ""}
          max={filters.to ?? undefined}
          onChange={(e) => set({ from: e.target.value === "" ? null : e.target.value })}
          className={controlClass}
        />
      </Field>
      <Field label="To">
        <input
          type="date"
          value={filters.to ?? ""}
          min={filters.from ?? undefined}
          onChange={(e) => set({ to: e.target.value === "" ? null : e.target.value })}
          className={controlClass}
        />
      </Field>
      <label className="flex h-9 items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={filters.stuck}
          onChange={(e) => set({ stuck: e.target.checked })}
          className="size-4 shrink-0 accent-brand"
        />
        Stuck only
      </label>
      {isFiltered(filters) && (
        <button
          type="button"
          onClick={() => onChange({ ...NO_FILTERS, by: filters.by })}
          className={cn(quietButtonClass, "h-9")}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

/** A column's name as the button that sorts by it. The header cell carries `aria-sort`. */
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
  onSort: (next: Sort) => void;
  children: string;
}) {
  const state = ariaSort(sort, column);
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
        <Icon aria-hidden className={cn("size-3.5 shrink-0", state === "none" && "opacity-50")} />
      </button>
    </DataHeader>
  );
}

/**
 * Every pull request in a stage, one per row, in the order the view asks
 * for. Sorting is done in the browser on what is already here (`sortItems`,
 * by the page): a click on a header reports the next order and nothing is
 * asked of the server again.
 */
export function PullTable({
  items,
  view,
  now,
  onSort,
}: {
  /** Already filtered and sorted. */
  items: readonly Item[];
  view: View;
  now: number;
  onSort: (next: Sort) => void;
}) {
  const { sort } = view;
  return (
    <DataTable caption="Pull requests" className="min-w-[64rem]">
      <DataHead>
        <DataHeader pinned>Pull request</DataHeader>
        <SortHeader sort={sort} column="owner" onSort={onSort}>
          Owner
        </SortHeader>
        <SortHeader sort={sort} column="repo" onSort={onSort}>
          Repository
        </SortHeader>
        <SortHeader sort={sort} column="stage" onSort={onSort}>
          Stage
        </SortHeader>
        <SortHeader sort={sort} column="opened" onSort={onSort}>
          Opened
        </SortHeader>
        <SortHeader sort={sort} column="activity" onSort={onSort}>
          Last activity
        </SortHeader>
        <SortHeader sort={sort} column="age" onSort={onSort}>
          Age in stage
        </SortHeader>
        <DataHeader>Checks</DataHeader>
      </DataHead>
      <DataBody>
        {items.map(({ pull, placed, owner }) => {
          const stuck = placed.stuck.length > 0;
          return (
            <DataRow key={`${pull.repoId}#${pull.number}`} tone={stuck ? "danger" : undefined}>
              <DataRowHeader pinned className="max-w-[22rem] break-words">
                <TitleLink pull={pull} />
                <span className="mt-0.5 block font-num text-xs font-normal text-ink-2">{`#${pull.number}`}</span>
              </DataRowHeader>
              <DataCell>
                <OwnerChip owner={owner} />
              </DataCell>
              <DataCell className="break-all" title={pull.repoId}>
                {repoName(pull.repoId)}
              </DataCell>
              <DataCell>
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusChip tone={STAGE_TONE[placed.stage]}>{STAGE_LABELS[placed.stage]}</StatusChip>
                  {stuck && <StatusChip tone="danger">Stuck</StatusChip>}
                </span>
                {placed.stuck.map((why) => (
                  <span key={why.reason} className="mt-1 block text-xs text-ink-2">
                    {why.words}
                  </span>
                ))}
              </DataCell>
              <DataCell className="whitespace-nowrap">
                <span className="font-num">{dayLabel(utcDay(pull.createdAt), now)}</span>
              </DataCell>
              <DataCell className="whitespace-nowrap">
                <span className="font-num">{dayLabel(utcDay(pull.updatedAt), now)}</span>
              </DataCell>
              <DataCell className="whitespace-nowrap">
                <span className="font-num">{ageWords(placed.ageMs)}</span>
                <span className="mt-0.5 block text-xs text-ink-2">{sinceWords(placed.basis)}</span>
              </DataCell>
              <DataCell>
                {pull.state === "open" ? <ChecksChip checks={pull.checks} /> : <span className="text-ink-2">—</span>}
              </DataCell>
            </DataRow>
          );
        })}
      </DataBody>
    </DataTable>
  );
}
