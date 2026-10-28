// The partnerships pipeline's vocabulary and the numbers worked out from its
// cards: pure, so the browser and the owner's agent read the same words and
// the same rule for a partner that has gone quiet. Nothing here reads a
// clock: every function that depends on "now" or "today" takes it.

import { quietCards, type QuietCards } from "./attention/pipelineDerive";
import type { CompanyId } from "./company";

export const PARTNER_TYPES = ["channel", "integration", "referral", "strategic", "clinical"] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const PARTNER_TYPE_LABELS: Record<PartnerType, string> = {
  channel: "Channel or reseller",
  integration: "Integration or technology",
  referral: "Referral",
  strategic: "Strategic",
  clinical: "Clinical or design partner",
};

export const PARTNER_STAGES = [
  "identified",
  "contacted",
  "in_talks",
  "agreement",
  "live",
  "paused",
  "lost",
] as const;
export type PartnerStage = (typeof PARTNER_STAGES)[number];

export const PARTNER_STAGE_LABELS: Record<PartnerStage, string> = {
  identified: "Identified",
  contacted: "Contacted",
  in_talks: "In talks",
  agreement: "Agreement",
  live: "Live",
  paused: "Paused",
  lost: "Lost",
};

export const isPartnerStage = (value: unknown): value is PartnerStage =>
  PARTNER_STAGES.includes(value as PartnerStage);
export const isPartnerType = (value: unknown): value is PartnerType =>
  PARTNER_TYPES.includes(value as PartnerType);

/** What a partner's expected value counts: referrals a month, or revenue a month in the company's currency. */
export const PARTNER_VALUE_KINDS = ["referrals", "revenue"] as const;
export type PartnerValueKind = (typeof PARTNER_VALUE_KINDS)[number];

/**
 * Stages where a partner can go quiet: a conversation is under way. "Identified"
 * is left out (nobody was approached), and so are live, paused and lost.
 */
export const PARTNER_JUDGED_STAGES: readonly PartnerStage[] = ["contacted", "in_talks", "agreement"];

/** A partner in a judged stage with no activity for more than this many days has gone quiet. */
export const PARTNER_QUIET_DAYS = 14;

/** The quiet rule in words, for every text that states it (Today's line, the agent's tool). */
export const PARTNER_QUIET_WORDS = `no activity for more than ${PARTNER_QUIET_DAYS} days`;

export const MAX_PARTNER_LINKS = 5;
export const MAX_PARTNER_LINK_LABEL = 60;
export const MAX_PARTNER_OWNER = 60;
export const MAX_PARTNER_ROLE = 80;
/** Referrals a month: a count, held to what a person could enter. */
export const MAX_PARTNER_REFERRALS = 100_000;
export const MAX_PARTNERS_PER_COMPANY = 500;

/** A partner as the board sends it, and as the owner's agent reads it. */
export type PartnerCard = {
  id: string;
  company: CompanyId;
  name: string;
  type: PartnerType;
  stage: PartnerStage;
  /** Whoever on our side owns the relationship: a name, never an address. */
  owner: string | null;
  /** One person there, by name and role: no email address or phone number. */
  contact: string | null;
  contactRole: string | null;
  value: number | null;
  valueKind: PartnerValueKind | null;
  notes: string | null;
  nextStep: string | null;
  /** "YYYY-MM-DD", or null. */
  nextStepOn: string | null;
  lastActivityAt: number | null;
  links: { label: string; url: string }[];
  /** The agent's client name when its last change came through the owner's Claude; null for the app. */
  editedBy: string | null;
};

/**
 * The partners gone quiet: the pipelines' one rule (`quietCards`), over the
 * partners in a judged stage, at `PARTNER_QUIET_DAYS`. `of` counts the judged.
 */
export type QuietPartners = QuietCards;

export function quietPartners(cards: readonly PartnerCard[], now: number): QuietPartners {
  return quietCards(
    cards.filter((card) => PARTNER_JUDGED_STAGES.includes(card.stage)),
    now,
    PARTNER_QUIET_DAYS,
  );
}

/** Partners gone quiet whose next step was dated before `today` ("YYYY-MM-DD"). */
export function needsYouPartners(
  cards: readonly PartnerCard[],
  now: number,
  today: string,
): PartnerCard[] {
  const quiet = new Set(quietPartners(cards, now).quiet.map((row) => row.id));
  return cards.filter(
    (card) => quiet.has(card.id) && card.nextStepOn !== null && card.nextStepOn < today,
  );
}

export function partnerCounts(cards: readonly PartnerCard[]): Record<PartnerStage, number> {
  const counts = Object.fromEntries(PARTNER_STAGES.map((stage) => [stage, 0])) as Record<
    PartnerStage,
    number
  >;
  for (const card of cards) counts[card.stage]++;
  return counts;
}
