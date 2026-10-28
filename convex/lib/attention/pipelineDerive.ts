// The numbers the pipeline pages show, worked out from the boards at read
// time. Nothing here is stored, and nothing here reads a clock: every
// function that depends on "now" takes it as an argument.
//
// The rule from the finance page holds here too: a missing number is not a
// zero. A deal with no amount is left out of the value and counted as left
// out; a closed deal with no close date is left out of the win rate and
// counted; a card with no activity date is neither quiet nor active.

import { UNMAPPED, type DealStage, type InvestorStage } from "../pipelineStages";

/** Deals still in play: what pipeline value and staleness are judged over. */
export const OPEN_DEAL_STAGES: readonly DealStage[] = ["lead", "qualified", "demo", "proposal"];

/**
 * Investors in a live conversation. "To contact" is left out: nobody has
 * gone quiet who was never approached.
 */
export const ACTIVE_INVESTOR_STAGES: readonly InvestorStage[] = [
  "contacted",
  "meeting",
  "diligence",
];

const DAY = 24 * 60 * 60 * 1000;

/** An open deal with no activity for more than this many days has gone quiet. */
export const DEAL_STALE_DAYS = 14;
/** The same for an investor in a live conversation. */
export const INVESTOR_STALE_DAYS = 14;
/** Win rate looks at deals closed in this many days up to now. */
export const WIN_RATE_WINDOW_DAYS = 180;
/** Fewer closed deals than this is too few to hold against a benchmark. */
export const WIN_RATE_MIN_CLOSED = 10;
/** A mirrored board not read for more than this many days may be behind. */
export const MIRROR_STALE_DAYS = 3;

/** What these functions need of a card. Both boards' cards have it. */
export type PipelineCard = {
  id: string;
  name: string;
  stage: string;
  amount: number | null;
  lastActivityAt: number | null;
  closedAt: number | null;
  nextStep: string | null;
};

export type PipelineBoard = Readonly<Record<string, readonly PipelineCard[]>>;

/** A card as either board query returns it: what the board components draw. */
export type BoardCard = PipelineCard & {
  mirrored: boolean;
  source: string;
  contact: string | null;
  sourceStage: string | null;
  notes: string | null;
};

const inStages = (board: PipelineBoard, stages: readonly string[]) =>
  stages.flatMap((stage) => board[stage] ?? []);

/** Whole days from `at` to `now`; never negative. */
export function daysSince(now: number, at: number): number {
  return Math.max(0, Math.floor((now - at) / DAY));
}

export type Quietness =
  | { kind: "undated" }
  | { kind: "active"; days: number }
  | { kind: "quiet"; days: number };

/** Whether a card has gone quiet: more than `limitDays` whole days with no activity. */
export function quietness(
  card: Pick<PipelineCard, "lastActivityAt">,
  now: number,
  limitDays: number,
): Quietness {
  if (card.lastActivityAt === null) return { kind: "undated" };
  const days = daysSince(now, card.lastActivityAt);
  return { kind: days > limitDays ? "quiet" : "active", days };
}

export type QuietCards = {
  /** How many cards were judged. */
  of: number;
  /** The quiet ones, longest silence first. */
  quiet: { id: string; name: string; days: number }[];
  /** Cards with no activity date, which can be called neither quiet nor active. */
  undated: number;
};

export function quietCards(
  cards: readonly Pick<PipelineCard, "id" | "name" | "lastActivityAt">[],
  now: number,
  limitDays: number,
): QuietCards {
  const quiet: QuietCards["quiet"] = [];
  let undated = 0;
  for (const card of cards) {
    const state = quietness(card, now, limitDays);
    if (state.kind === "undated") undated++;
    else if (state.kind === "quiet") quiet.push({ id: card.id, name: card.name, days: state.days });
  }
  quiet.sort((a, b) => b.days - a.days);
  return { of: cards.length, quiet, undated };
}

// ── Sales ──────────────────────────────────────────────────────────────────

export type PipelineValue = {
  /** Open deals: every stage before won and lost. */
  open: number;
  /** The sum of the monthly fees of the open deals that have one; null when none has. */
  value: number | null;
  /** Open deals with no amount, which the value leaves out. */
  withoutAmount: number;
  /** Deals in a stage the OS does not know, which are in no number at all. */
  unsorted: number;
};

/**
 * Open pipeline, unweighted: the plain sum of expected monthly fees. No
 * stage probabilities are applied, because at this volume they would be
 * invented; the company's own win rate is shown beside it instead.
 */
export function pipelineValue(board: PipelineBoard): PipelineValue {
  const open = inStages(board, OPEN_DEAL_STAGES);
  const priced = open.filter((deal) => deal.amount !== null);
  return {
    open: open.length,
    value: priced.length === 0 ? null : priced.reduce((sum, deal) => sum + deal.amount!, 0),
    withoutAmount: open.length - priced.length,
    unsorted: board[UNMAPPED]?.length ?? 0,
  };
}

export type WinRate =
  | { kind: "none"; undated: number }
  | {
      kind: "value";
      /** Won ÷ (won + lost), 0 to 1. */
      rate: number;
      won: number;
      lost: number;
      /** Closed deals with no close date, which cannot be placed in the window. */
      undated: number;
    };

/**
 * Won ÷ (won + lost), over deals closed in the `windowDays` up to `now`.
 * With nothing closed in the window there is no rate: not 0%.
 */
export function winRate(
  board: PipelineBoard,
  now: number,
  windowDays: number = WIN_RATE_WINDOW_DAYS,
): WinRate {
  const from = now - windowDays * DAY;
  let undated = 0;
  const count = (stage: string) => {
    let n = 0;
    for (const deal of board[stage] ?? []) {
      if (deal.closedAt === null) undated++;
      else if (deal.closedAt >= from) n++;
    }
    return n;
  };
  const won = count("won");
  const lost = count("lost");
  if (won + lost === 0) return { kind: "none", undated };
  return { kind: "value", rate: won / (won + lost), won, lost, undated };
}

export type Coverage =
  | { kind: "none" }
  | { kind: "no_wins"; closed: number }
  | {
      kind: "value";
      /** Open pipeline needed per unit of new business: 1 ÷ win rate. */
      multiple: number;
      closed: number;
    };

/** Pipeline coverage needed, from the company's own win rate. */
export function coverageNeeded(rate: WinRate): Coverage {
  if (rate.kind === "none") return { kind: "none" };
  const closed = rate.won + rate.lost;
  if (rate.won === 0) return { kind: "no_wins", closed };
  return { kind: "value", multiple: 1 / rate.rate, closed };
}

/** Open deals that have gone quiet. */
export function quietDeals(board: PipelineBoard, now: number): QuietCards {
  return quietCards(inStages(board, OPEN_DEAL_STAGES), now, DEAL_STALE_DAYS);
}

// ── Fundraising ────────────────────────────────────────────────────────────

export type InvestorSummary = {
  /** Investors in a live conversation: contacted, meeting or diligence. */
  active: number;
  /** Still to contact. */
  targets: number;
  committed: {
    count: number;
    /** The sum of the committed cheques that have an amount; null when none has. */
    value: number | null;
    withoutAmount: number;
  };
  quiet: QuietCards;
  /** Active investors with nothing planned. */
  noNextStep: { id: string; name: string }[];
  unsorted: number;
};

export function investorSummary(board: PipelineBoard, now: number): InvestorSummary {
  const active = inStages(board, ACTIVE_INVESTOR_STAGES);
  const committed = board.committed ?? [];
  const priced = committed.filter((investor) => investor.amount !== null);
  return {
    active: active.length,
    targets: board.target?.length ?? 0,
    committed: {
      count: committed.length,
      value: priced.length === 0 ? null : priced.reduce((sum, i) => sum + i.amount!, 0),
      withoutAmount: committed.length - priced.length,
    },
    quiet: quietCards(active, now, INVESTOR_STALE_DAYS),
    noNextStep: active
      .filter((investor) => (investor.nextStep ?? "").trim() === "")
      .map(({ id, name }) => ({ id, name })),
    unsorted: board[UNMAPPED]?.length ?? 0,
  };
}
