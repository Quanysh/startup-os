"use client";

import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { EXTERNAL_OWNER_AGENTS } from "@convex/lib/botRules";
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
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag, StatusChip } from "@/components/ui/status-chip";
import { ariaSortOf, nextBotSort, type BotLine, type BotSort, type BotSortKey } from "@/lib/agents/bots-view";
import { cn } from "@/lib/utils";
import { COMPANY_WORDS, costText, msText, percentText, type BotWeekRow } from "./bot-week";
import { Toggle } from "./parts";

/** A row of the table: the bot's line, and its seven days (undefined while they load). */
export type BotTableRow = BotLine & { week: BotWeekRow | null | undefined };

const isExternal = (botId: string) => (EXTERNAL_OWNER_AGENTS as readonly string[]).includes(botId);

/** A column's name as the button that sorts by it. The header cell carries `aria-sort`. */
function SortHeader({
  sort,
  column,
  hideBelow,
  onSort,
  children,
}: {
  sort: BotSort;
  column: BotSortKey;
  hideBelow?: "sm" | "md" | "lg";
  onSort: (next: BotSort) => void;
  children: string;
}) {
  const state = ariaSortOf(sort, column);
  const Icon = state === "ascending" ? ArrowUpIcon : state === "descending" ? ArrowDownIcon : ArrowUpDownIcon;
  return (
    <DataHeader numeric={column !== "seen"} narrow={column === "seen"} hideBelow={hideBelow} aria-sort={state}>
      <button
        type="button"
        onClick={() => onSort(nextBotSort(sort, column))}
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

/** A week's figure in a cell: a placeholder while the week loads, said where nothing was reported. */
function WeekCell({
  week,
  show,
  none = "—",
}: {
  week: BotWeekRow | null | undefined;
  show: (week: BotWeekRow) => string | null;
  none?: string;
}) {
  if (week === undefined) return <Skeleton aria-hidden className="ml-auto h-4 w-10" />;
  const text = week === null ? null : show(week);
  return text === null ? <Blank>{none}</Blank> : <>{text}</>;
}

/**
 * Every bot on one table (Agents › Bots): who it is (its role, and marks for
 * a suggested, external or switched-off bot, one idle for seven days and one
 * refused today), a switch to turn it on or off at once, and its last seven
 * days: calls, approval, errors, bad arguments, p95, the day it was last seen
 * and this month's cost against its budget. The rows come in the view's
 * order; a sortable header reports the next order for the page to put in the
 * address. The bot's name is the button that opens it.
 */
export function BotsTable({
  rows,
  selected,
  sort,
  busy,
  onOpen,
  onSort,
  onToggle,
  buttonRef,
}: {
  rows: readonly BotTableRow[];
  /** The open bot's id. */
  selected: string | null;
  sort: BotSort;
  /** The bot whose switch is being changed. */
  busy: string | null;
  onOpen: (botId: string) => void;
  onSort: (next: BotSort) => void;
  onToggle: (botId: string, on: boolean) => void;
  /** Each name's button, so focus can come back to it when its bot is closed. */
  buttonRef: (botId: string, element: HTMLButtonElement | null) => void;
}) {
  return (
    <DataTable label="Bots" download="Bots" className="min-w-[34rem]">
      <DataHead>
        <DataHeader pinned>Bot</DataHeader>
        <DataHeader narrow exportValue="On">
          On
        </DataHeader>
        <DataHeader hideBelow="lg" narrow>
          Company
        </DataHeader>
        <SortHeader sort={sort} column="calls" onSort={onSort}>
          Calls, 7 days
        </SortHeader>
        <SortHeader sort={sort} column="approval" hideBelow="sm" onSort={onSort}>
          Approved
        </SortHeader>
        <SortHeader sort={sort} column="errors" onSort={onSort}>
          Errors
        </SortHeader>
        <DataHeader numeric hideBelow="lg">
          Bad arguments
        </DataHeader>
        <DataHeader numeric hideBelow="lg">
          p95
        </DataHeader>
        <SortHeader sort={sort} column="seen" hideBelow="md" onSort={onSort}>
          Last seen
        </SortHeader>
        <SortHeader sort={sort} column="cost" hideBelow="sm" onSort={onSort}>
          Cost this month
        </SortHeader>
      </DataHead>
      <DataBody>
        {rows.map((row) => (
          <DataRow
            key={row.botId}
            tone={row.refusalsToday > 0 ? "danger" : undefined}
            aria-current={row.botId === selected || undefined}
          >
            <DataRowHeader pinned exportValue={row.name} className="sm:min-w-[15rem]">
              <button
                ref={(element) => buttonRef(row.botId, element)}
                type="button"
                aria-expanded={row.botId === selected}
                onClick={() => onOpen(row.botId)}
                className={cn(
                  "text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 [overflow-wrap:anywhere]",
                  // The open bot's name is in the brand's blue and underlined: the panel beside or under it is its.
                  row.botId === selected ? "text-brand underline" : "text-ink",
                )}
              >
                {row.name}
              </button>
              <span className="mt-1 flex flex-wrap items-center gap-1 font-normal" data-export-skip="">
                {row.role !== "" && <KindTag tone="slate">{row.role}</KindTag>}
                {isExternal(row.botId) && <KindTag tone="violet">External</KindTag>}
                {row.suggested && <StatusChip tone="info">Suggested</StatusChip>}
                {!row.enabled && <StatusChip tone="neutral">Off</StatusChip>}
                {row.refusalsToday > 0 && <StatusChip tone="danger">{`${row.refusalsToday} refused today`}</StatusChip>}
                {row.idle && <StatusChip tone="warning">Idle 7 days</StatusChip>}
              </span>
            </DataRowHeader>
            <DataCell narrow exportValue={row.enabled ? "On" : "Off"}>
              <Toggle
                on={row.enabled}
                label={`${row.name} on`}
                disabled={busy === row.botId}
                onChange={(next) => onToggle(row.botId, next)}
              />
            </DataCell>
            <DataCell hideBelow="lg" narrow>
              <WeekCell week={row.week} none="Not set" show={(week) => (week.company === null ? null : COMPANY_WORDS[week.company])} />
            </DataCell>
            <DataCell numeric>
              <WeekCell week={row.week} none="None" show={(week) => (week.calls7d === null ? null : week.calls7d.toLocaleString("en-US"))} />
            </DataCell>
            <DataCell numeric hideBelow="sm">
              <WeekCell week={row.week} show={(week) => (week.approvalRate === null ? null : percentText(week.approvalRate))} />
            </DataCell>
            <DataCell numeric>
              <WeekCell week={row.week} show={(week) => (week.errorRate7d === null ? null : percentText(week.errorRate7d))} />
            </DataCell>
            <DataCell numeric hideBelow="lg">
              <WeekCell
                week={row.week}
                show={(week) => (week.schemaFailureRate7d === null ? null : percentText(week.schemaFailureRate7d))}
              />
            </DataCell>
            <DataCell numeric hideBelow="lg">
              <WeekCell week={row.week} show={(week) => (week.p95Ms7d === null ? null : msText(week.p95Ms7d))} />
            </DataCell>
            <DataCell narrow hideBelow="md" className="whitespace-nowrap">
              <WeekCell week={row.week} none="Never" show={(week) => week.lastSeenDay} />
            </DataCell>
            <DataCell numeric hideBelow="sm">
              <WeekCell week={row.week} show={(week) => costText(week)} />
            </DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}
