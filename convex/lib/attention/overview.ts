// The whole "Needs attention" list for one view of the company, worst first:
// the numbers and their sources, then every rule (`ATTENTION_RULES`):
// engineering, the pipelines, the partners, the clinics, the obligations, the
// handoffs and the agreements. One list of rule functions, which the owner's
// agent (convex/lib/mcpTools.ts, `overviewItems`) and Today's "Needs you"
// (src/components/home/use-needs.ts, `ruleItems`, with the figures it may be
// told of) both call, so a rule added here reaches both. Pure: `now` and
// `today` are arguments.

import type { CustomerRow } from "../customerShape";
import { agreementAttention, type AgreementRow } from "../evidence";
import type { ObligationRow } from "../obligationShape";
import { complianceAttention } from "./compliance";
import { customerAttention } from "./customers";
import { handoffAttention, type HandoffStale } from "./handoffs";
import { engineeringAttention, type PullsInView } from "./engineering";
import type { PartnerCard } from "../partnerStages";
import { partnerAttention } from "./partners";
import { pipelineAttention } from "./pipeline";
import type { PipelineBoard } from "./pipelineDerive";
import {
  attentionItems,
  sortAttention,
  type AttentionItem,
  type SourceStates,
  type Tile,
} from "./scorecard";

export type OverviewInput = {
  tiles: readonly Tile[];
  sources: SourceStates;
  /** A board that is not in view is passed empty: it adds nothing. */
  usDeals: PipelineBoard;
  kzDeals: PipelineBoard;
  investors: PipelineBoard;
  /** The partners of the companies in view; left out where there are none to judge. */
  partners?: readonly PartnerCard[];
  customers: readonly CustomerRow[];
  lastPushAt: number | null;
  obligations: readonly ObligationRow[];
  /** Vendor agreements for the companies in view; left out where there are none. */
  agreements?: readonly AgreementRow[];
  /** The pull request list for the companies in view; null where it was not sent. */
  pulls: PullsInView | null;
  /** The open handoffs in view, when they were read. */
  handoffs?: readonly HandoffStale[] | undefined;
};

type Rule = { name: string; items: (input: OverviewInput, now: number, today: string) => AttentionItem[] };

/** Every rule of the list but the figures, in order. Add a producer here and both callers have it. */
export const ATTENTION_RULES: readonly Rule[] = [
  // A failing main branch from the tiles, and stuck pull requests from the list.
  { name: "engineering", items: (input, now) => engineeringAttention(input.tiles, input.pulls, now) },
  {
    name: "pipeline",
    items: (input, now) =>
      pipelineAttention({ usDeals: input.usDeals, kzDeals: input.kzDeals, investors: input.investors }, now),
  },
  // Partners gone quiet with a next step overdue, by count: none is named.
  { name: "partners", items: (input, now, today) => partnerAttention(input.partners ?? [], now, today) },
  // Counts only: no clinic or obligation is named.
  { name: "customers", items: (input, now) => customerAttention(input.customers, input.lastPushAt, now) },
  { name: "compliance", items: (input, now, today) => complianceAttention(input.obligations, today, now) },
  { name: "handoffs", items: (input, now) => handoffAttention(input.handoffs, now) },
  // Vendor agreements ending within 60 days, counted: no vendor is named.
  { name: "agreements", items: (input, now, today) => agreementAttention(input.agreements ?? [], today, now) },
];

/** Every rule's items, unsorted (`ATTENTION_RULES`). */
export const ruleItems = (input: OverviewInput, now: number, today: string): AttentionItem[] =>
  ATTENTION_RULES.flatMap((rule) => rule.items(input, now, today));

/** `now` is the caller's clock, and `today` the calendar day it is for them ("YYYY-MM-DD"). */
export function overviewItems(input: OverviewInput, now: number, today: string): AttentionItem[] {
  return sortAttention([...attentionItems(input.tiles, input.sources, now), ...ruleItems(input, now, today)]);
}
