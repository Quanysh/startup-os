// The stages of the two pipelines, and the mapping from another system's own
// stage names onto them. It lives under convex/ because the ingest endpoint
// normalises a pushed stage before storing it, and Convex cannot import from
// src/. The boards' titles and hints are UI and live in src/lib/pipeline.

export const PIPELINES = ["deals", "investors"] as const;
export type Pipeline = (typeof PIPELINES)[number];

export const DEAL_STAGES = ["lead", "qualified", "demo", "proposal", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const INVESTOR_STAGES = [
  "target",
  "contacted",
  "meeting",
  "diligence",
  "committed",
  "passed",
] as const;
export type InvestorStage = (typeof INVESTOR_STAGES)[number];

/**
 * Where a mirrored row goes when its source's stage name is not one the OS
 * knows. It is shown, in a column of its own, and left out of every number:
 * guessing a stage would put a deal in the wrong sum.
 */
export const UNMAPPED = "unmapped";

export const STAGES: Record<Pipeline, readonly string[]> = {
  deals: DEAL_STAGES,
  investors: INVESTOR_STAGES,
};

/** Stages where a record has reached its end. They sort by close date, not by hand. */
export const CLOSED_STAGES: Record<Pipeline, readonly string[]> = {
  deals: ["won", "lost"],
  investors: ["committed", "passed"],
};

export function isStage(pipeline: Pipeline, value: string): boolean {
  return STAGES[pipeline].includes(value);
}

export function isClosedStage(pipeline: Pipeline, stage: string): boolean {
  return CLOSED_STAGES[pipeline].includes(stage);
}

/** A column a card is not arranged in by hand: a closed stage, or "unmapped". */
export function keepsOwnOrder(pipeline: Pipeline, stage: string): boolean {
  return stage === UNMAPPED || isClosedStage(pipeline, stage);
}

/**
 * A stage name reduced to what is compared: lower case, "ё" as "е", and
 * every run of anything that is not a letter or a digit as one space. So
 * "Closed - Won", "closed won" and " CLOSED_WON " are the same name.
 */
export function stageKey(label: string): string {
  return label
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Other systems' stage names, by stageKey. English and Russian, from the
// default pipelines of Kommo (amoCRM) and Bitrix24 for deals, and the usual
// names of a fundraising pipeline for investors. The owner's real pipelines
// are checked against these when the connectors are first read
// (docs/ingest.md); a name missing here shows as "Unsorted", never as a guess.
const ALIASES: Record<Pipeline, Record<string, string>> = {
  deals: {
    new: "lead",
    "incoming leads": "lead",
    "initial contact": "lead",
    "новая": "lead",
    "неразобранное": "lead",
    "первичный контакт": "lead",
    "in progress": "qualified",
    discussions: "qualified",
    negotiations: "qualified",
    "в работе": "qualified",
    "переговоры": "qualified",
    presentation: "demo",
    "демо": "demo",
    "демонстрация": "demo",
    "презентация": "demo",
    "decision making": "proposal",
    "contract discussion": "proposal",
    "принимают решение": "proposal",
    "согласование договора": "proposal",
    "коммерческое предложение": "proposal",
    "подготовка документов": "proposal",
    "счет на предоплату": "proposal",
    "финальный счет": "proposal",
    "closed won": "won",
    "успешно реализовано": "won",
    "сделка успешна": "won",
    "closed lost": "lost",
    "закрыто и не реализовано": "lost",
    "сделка провалена": "lost",
    // The Kazakhstan CRM's own funnels. A demo period and onboarding both come
    // before a deal counts as won there (won means paying).
    "новый лид": "lead",
    "первый контакт": "lead",
    "дозвон": "lead",
    "квалификация": "qualified",
    "встреча": "qualified",
    "демо период": "demo",
    "предложение": "proposal",
    "договор": "proposal",
    "онбординг": "proposal",
    "сделка выиграна": "won",
    "сделка проиграна": "lost",
  },
  investors: {
    researching: "target",
    research: "target",
    "to contact": "target",
    "not contacted": "target",
    "reached out": "contacted",
    "intro requested": "contacted",
    outreach: "contacted",
    "first meeting": "meeting",
    "second meeting": "meeting",
    "partner meeting": "meeting",
    pitched: "meeting",
    "due diligence": "diligence",
    "light diligence": "diligence",
    "term sheet": "diligence",
    invested: "committed",
    closed: "committed",
    declined: "passed",
    "not interested": "passed",
  },
};

/** For tests: every alias this build knows, as [pipeline, name, stage]. */
export function stageAliases(): [Pipeline, string, string][] {
  return PIPELINES.flatMap((pipeline) =>
    Object.entries(ALIASES[pipeline]).map(
      ([name, stage]) => [pipeline, name, stage] as [Pipeline, string, string],
    ),
  );
}

/**
 * The OS's stage for a stage name from another system, or UNMAPPED when the
 * name is not known. A stage's own id always maps to itself.
 */
export function normalizeStage(pipeline: Pipeline, label: string): string {
  const key = stageKey(label);
  if (isStage(pipeline, key)) return key;
  return ALIASES[pipeline][key] ?? UNMAPPED;
}
