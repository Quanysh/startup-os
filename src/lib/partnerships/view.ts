// What the partnerships page shows of a partner: the board's columns, a value
// in words, and a next step judged against today. Pure.

import {
  PARTNER_STAGES,
  type PartnerCard,
  type PartnerStage,
} from "@convex/lib/partnerStages";
import { SCOPE_CURRENCY } from "@convex/lib/metricRegistry";
import type { BoardColumn } from "@/components/board/board";
import { formatValue } from "@/lib/format";

/** The board's columns: a title and a hint for each stage. Every one is arranged by hand. */
export const PARTNER_COLUMNS = [
  { id: "identified", title: "Identified", hint: "On the list, not yet approached" },
  { id: "contacted", title: "Contacted", hint: "Reached out, no conversation yet" },
  { id: "in_talks", title: "In talks", hint: "In a real conversation" },
  { id: "agreement", title: "Agreement", hint: "Terms or a contract on the table" },
  { id: "live", title: "Live", hint: "Working together" },
  { id: "paused", title: "Paused", hint: "On hold, for now" },
  { id: "lost", title: "Lost", hint: "Not going ahead" },
] as const satisfies readonly (BoardColumn & { id: PartnerStage })[];

/** "12 referrals/mo" or "$2,500/mo"; null where no value is held. */
export function valueText(partner: Pick<PartnerCard, "company" | "value" | "valueKind">): string | null {
  if (partner.value === null || partner.valueKind === null) return null;
  if (partner.valueKind === "referrals") {
    return `${partner.value} ${partner.value === 1 ? "referral" : "referrals"}/mo`;
  }
  return `${formatValue(partner.value, "currency", SCOPE_CURRENCY[partner.company]!)}/mo`;
}

export type NextStepState = "none" | "upcoming" | "today" | "overdue";

/**
 * Whether a partner's next step is dated, and against today ("YYYY-MM-DD").
 * A live, paused or lost partner is never overdue: nothing is being chased.
 */
export function nextStepState(partner: Pick<PartnerCard, "stage" | "nextStepOn">, today: string): NextStepState {
  if (partner.nextStepOn === null) return "none";
  if (partner.nextStepOn === today) return "today";
  const chased = partner.stage === "identified" || partner.stage === "contacted" || partner.stage === "in_talks" || partner.stage === "agreement";
  return partner.nextStepOn < today && chased ? "overdue" : "upcoming";
}

export type Layout = "board" | "table";

export const readLayout = (params: URLSearchParams): Layout =>
  params.get("view") === "table" ? "table" : "board";
export const writeLayout = (layout: Layout): string => (layout === "table" ? "view=table" : "");

/** The table's rows: by stage in pipeline order, then by name. */
export function sortedForTable(cards: readonly PartnerCard[]): PartnerCard[] {
  return [...cards].sort(
    (a, b) =>
      PARTNER_STAGES.indexOf(a.stage) - PARTNER_STAGES.indexOf(b.stage) || a.name.localeCompare(b.name),
  );
}
