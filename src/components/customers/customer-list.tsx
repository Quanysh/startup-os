"use client";

import { CircleCheckIcon, CirclePauseIcon, CircleSlashIcon, type LucideIcon } from "lucide-react";
import {
  CUSTOMER_STATUS_LABELS,
  MARKET_LABELS,
  type CustomerStatus,
  type Market,
} from "@convex/lib/customerShape";
import { GatedLink } from "@/components/gated-link";
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
import { STATUS_INK, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import {
  baaText,
  dateText,
  feeText,
  nextTouchText,
  owedText,
  type Assessed,
} from "@/lib/customers/view";
import { cn } from "@/lib/utils";
import { HealthChip } from "./health-badge";

// Where a clinic stands with us. Outlined, so that in a row the health verdict
// (a filled chip) is read first. Churned is a fact about the past, not a call
// to act: it wears no alarm.
const STATUS: Record<CustomerStatus, { tone: StatusTone; icon: LucideIcon }> = {
  active: { tone: "success", icon: CircleCheckIcon },
  paused: { tone: "warning", icon: CirclePauseIcon },
  churned: { tone: "neutral", icon: CircleSlashIcon },
};

/**
 * The one-line reason a clinic's health reads as it does: its worst signal.
 * A verdict that rests on fewer than all its signals says how many are not on
 * record, so a "Good" from one signal is not read as a "Good" from three.
 */
function headline({ health }: Assessed): string {
  if (health.level === "not_assessed") return health.why;
  if (health.level === "unknown") return "Nothing on record to judge by.";
  const reason = health.reasons.find((r) => r.level === health.level)?.text ?? "";
  const missing = health.unknown.length;
  if (missing === 0) return reason;
  return `${reason} · ${missing} of ${health.reasons.length} signals not on record`;
}

/**
 * Where a deal is opened: a US deal has a page of its own; a Kazakhstan one
 * is a card on the Sales board. The id is in the address, never the name.
 */
export const dealHref = (dealId: string, market: Market) =>
  market === "us" ? `/sales/deals/${encodeURIComponent(dealId)}` : "/sales";

const TAG =
  "inline-flex h-5 items-center rounded-full border border-line px-1.5 text-[11px] font-medium leading-none text-ink-2";

/**
 * A clinic won on the Sales board, or one Sales linked to its deal. The tag
 * opens the deal for a viewer with Sales; anyone else reads it as words.
 */
function FromSales({ dealId, market }: { dealId: string; market: Market }) {
  return (
    <GatedLink
      href={dealHref(dealId, market)}
      className={cn(TAG, "outline-none transition hover:border-ink-3 hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50")}
      otherwise={<span className={TAG}>From Sales</span>}
    >
      From Sales
    </GatedLink>
  );
}

const DATE = "font-num whitespace-nowrap text-ink-2";
// An amount the register does not hold is words, not a figure: it reads as
// words, in the same column.
const words = (notAFigure: boolean) => cn(notAFigure && "font-sans text-ink-2");

/**
 * The clinics, one row each. A value the register does not hold reads "Not
 * on record" or "Unknown": never a zero and never a blank.
 *
 * The clinic's name opens its drawer, which holds everything the row does and
 * the rest (its last use, its market, the note). On a phone the fee and the
 * contract date are left to the drawer, and the name stays pinned while the
 * other columns scroll.
 */
export function CustomerList({
  rows,
  now,
  showBaa,
  onOpen,
}: {
  rows: readonly Assessed[];
  now: number;
  /** A BAA is US law: the column is left out when only Kazakhstan's clinics are in view. */
  showBaa: boolean;
  onOpen: (id: Assessed["clinic"]["id"]) => void;
}) {
  return (
    <Panel aria-label="Clinics">
      <DataTable caption="Clinics" className="min-w-[44rem] md:min-w-[62rem]">
        <DataHead>
          <DataHeader pinned>Clinic</DataHeader>
          <DataHeader>Status</DataHeader>
          <DataHeader>Health</DataHeader>
          <DataHeader numeric hideBelow="md">
            Monthly fee
          </DataHeader>
          <DataHeader>Last payment</DataHeader>
          <DataHeader numeric>Owed</DataHeader>
          <DataHeader hideBelow="md">Contract</DataHeader>
          {showBaa && <DataHeader>BAA</DataHeader>}
          <DataHeader>Next touch</DataHeader>
        </DataHead>
        <DataBody>
          {rows.map((row) => {
            const { clinic, health } = row;
            return (
              <DataRow key={clinic.id} tone={health.level === "at_risk" ? "danger" : undefined}>
                <DataRowHeader pinned className="font-normal">
                  <button
                    type="button"
                    onClick={() => onOpen(clinic.id)}
                    className="rounded-inner text-left font-medium text-ink underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {clinic.name}
                  </button>
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-2">
                    <span>
                      {MARKET_LABELS[clinic.market]}
                      {clinic.archived && " · No longer in the register"}
                    </span>
                    {clinic.dealId !== null && <FromSales dealId={clinic.dealId} market={clinic.market} />}
                  </span>
                </DataRowHeader>
                <DataCell className="whitespace-nowrap">
                  <StatusChip
                    variant="outline"
                    tone={STATUS[clinic.status].tone}
                    icon={STATUS[clinic.status].icon}
                  >
                    {CUSTOMER_STATUS_LABELS[clinic.status]}
                  </StatusChip>
                </DataCell>
                <DataCell className="min-w-[14rem]">
                  <HealthChip level={health.level} />
                  <p className="mt-1 max-w-xs text-xs text-ink-2">{headline(row)}</p>
                </DataCell>
                <DataCell numeric hideBelow="md" className={words(clinic.monthlyFee === null)}>
                  {feeText(clinic)}
                </DataCell>
                <DataCell className={DATE}>{dateText(clinic.lastPaymentDate, now)}</DataCell>
                <DataCell
                  numeric
                  className={cn(
                    words(clinic.amountOwed === null || clinic.amountOwed === 0),
                    // Money a clinic owes is the one figure here that is bad news.
                    clinic.amountOwed !== null &&
                      clinic.amountOwed > 0 &&
                      cn("font-medium", STATUS_INK.danger),
                  )}
                >
                  {owedText(clinic)}
                </DataCell>
                <DataCell hideBelow="md" className={DATE}>
                  {dateText(clinic.contractDate, now)}
                </DataCell>
                {showBaa && <DataCell className={DATE}>{baaText(clinic, now)}</DataCell>}
                <DataCell className={DATE}>{nextTouchText(clinic, now)}</DataCell>
              </DataRow>
            );
          })}
        </DataBody>
      </DataTable>
    </Panel>
  );
}
