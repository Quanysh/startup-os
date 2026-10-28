"use client";

import { ClockAlertIcon } from "lucide-react";
import {
  PARTNER_JUDGED_STAGES,
  PARTNER_QUIET_DAYS,
  PARTNER_STAGE_LABELS,
  PARTNER_TYPE_LABELS,
  type PartnerCard,
  type PartnerStage,
} from "@convex/lib/partnerStages";
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
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { dayLabel } from "@/lib/format";
import { sortedForTable, nextStepState, valueText } from "@/lib/partnerships/view";
import { lastActivityLabel } from "@/lib/pipeline/table-view";
import { quietness } from "@/lib/pipeline/derive";

const STAGE_TONE: Record<PartnerStage, StatusTone> = {
  identified: "neutral",
  contacted: "info",
  in_talks: "info",
  agreement: "info",
  live: "success",
  paused: "warning",
  lost: "neutral",
};

/**
 * The partners as a table, by stage and name. A name opens the editor. The
 * table downloads as CSV (`DataTable`), as shown.
 */
export function PartnerTable({
  partners,
  company,
  now,
  today,
  onOpen,
}: {
  partners: readonly PartnerCard[];
  /** Who the partners are, for the table's file name. */
  company: string;
  now: number;
  today: string;
  onOpen: (id: string) => void;
}) {
  if (partners.length === 0) {
    return <p className="text-sm text-ink-2">No partners yet. Switch to the board to add one.</p>;
  }
  return (
    <DataTable label={`${company} partners`} download={`${company} partners`} className="min-w-[56rem]">
      <DataHead>
        <DataHeader pinned>Partner</DataHeader>
        <DataHeader>Type</DataHeader>
        <DataHeader>Stage</DataHeader>
        <DataHeader>Owner</DataHeader>
        <DataHeader>Contact</DataHeader>
        <DataHeader numeric>Expected</DataHeader>
        <DataHeader>Next step</DataHeader>
        <DataHeader>Due</DataHeader>
        <DataHeader>Last activity</DataHeader>
      </DataHead>
      <DataBody>
        {sortedForTable(partners).map((partner) => {
          const state = nextStepState(partner, today);
          const judged = (PARTNER_JUDGED_STAGES as readonly string[]).includes(partner.stage);
          const quiet = judged ? quietness(partner, now, PARTNER_QUIET_DAYS) : null;
          return (
            <DataRow key={partner.id} tone={state === "overdue" ? "warning" : undefined}>
              <DataRowHeader pinned exportValue={partner.name}>
                <button
                  type="button"
                  onClick={() => onOpen(partner.id)}
                  className="rounded text-left font-medium outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {partner.name}
                </button>
              </DataRowHeader>
              <DataCell>{PARTNER_TYPE_LABELS[partner.type]}</DataCell>
              <DataCell>
                <StatusChip tone={STAGE_TONE[partner.stage]}>{PARTNER_STAGE_LABELS[partner.stage]}</StatusChip>
              </DataCell>
              <DataCell>{partner.owner ?? <Blank />}</DataCell>
              <DataCell>
                {partner.contact === null ? (
                  <Blank />
                ) : (
                  [partner.contact, partner.contactRole].filter(Boolean).join(", ")
                )}
              </DataCell>
              <DataCell numeric>{valueText(partner) ?? <Blank />}</DataCell>
              <DataCell>{partner.nextStep ?? <Blank />}</DataCell>
              <DataCell exportValue={partner.nextStepOn ?? ""}>
                {partner.nextStepOn === null ? (
                  <Blank />
                ) : state === "overdue" ? (
                  <StatusChip tone="warning">{`Was due ${dayLabel(partner.nextStepOn, now)}`}</StatusChip>
                ) : (
                  dayLabel(partner.nextStepOn, now)
                )}
              </DataCell>
              <DataCell
                exportValue={
                  partner.lastActivityAt === null
                    ? ""
                    : `${lastActivityLabel(partner.lastActivityAt, now)}${quiet?.kind === "quiet" ? " (quiet)" : ""}`
                }
              >
                {partner.lastActivityAt === null ? (
                  <Blank />
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    {lastActivityLabel(partner.lastActivityAt, now)}
                    {quiet?.kind === "quiet" && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-ink">
                        <ClockAlertIcon aria-hidden className="size-3 text-watch" />
                        Quiet
                      </span>
                    )}
                  </span>
                )}
              </DataCell>
            </DataRow>
          );
        })}
      </DataBody>
    </DataTable>
  );
}
