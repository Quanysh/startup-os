// What a project may send about its agents: daily totals per agent and
// model, each provider's health, and the config version it applied
// (convex/lib/agentControl.ts). Two doors take it: Protocol v1's POST
// /agents/v1/usage (`projectUsageBody`, docs/agents-protocol.md), and the
// legacy `vertical_agents` source on POST /ingest/v1 (`agentUsageRow`,
// docs/ingest.md), which carries `product` and no catalogue.
//
// Every row is a strict object of ids and numbers. An id is short and
// charset-limited; nothing is free text; an unknown field refuses the whole
// push. So no patient, no note, no prompt and no answer can arrive this way,
// by design and by test. The rows travel alone: nothing else rides with them.

import { z } from "zod";
import {
  AGENT_ID_PATTERN,
  AGENT_PRODUCTS,
  CLOCK_SKEW_MS,
  ERROR_CLASSES,
  MAX_CALLS_PER_DAY,
  MAX_CONFIG_VERSION,
  MAX_COST_USD_PER_DAY,
  MAX_LATENCY_MS,
  MAX_PROVIDER_ROWS,
  MAX_TOKENS_PER_DAY,
  MAX_USAGE_AGE_DAYS,
  MODEL_PATTERN,
  PROMPT_VERSION_PATTERN,
  PROVIDER_STATES,
  SLUG_PATTERN,
  USAGE_DAY_LEAD_MS,
  addDays,
  dayOf,
} from "./agentControl";
import {
  MAX_CATALOG_TOOLS,
  MAX_RUNS_PER_PUSH,
  catalogProblems,
  catalogToolWire,
  runSummaryWire,
  runsProblems,
} from "./agentBuilder";
import { defaultsProblems, harnessDefaultsWire } from "./agentHarness";
import { AGENT_KINDS, AGENT_NAME_PATTERN, MAX_AGENTS_KNOWN } from "./agentProjects";
import { isCanonicalPeriodStart } from "./periods";

/** The most usage rows in one Protocol v1 report (the ingest envelope has its own cap). */
export const MAX_USAGE_ROWS = 1000;
/** A batch's id: short and charset-limited, like every id here. */
export const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,99}$/;

const count = (max: number) => z.number().int().nonnegative().max(max);
const latency = z.number().nonnegative().max(MAX_LATENCY_MS);

/** A usage row's fields, which the `vertical_agents` source and Protocol v1 both send. */
const usageFields = {
  agentId: z.string().regex(AGENT_ID_PATTERN),
  promptVersion: z.string().regex(PROMPT_VERSION_PATTERN),
  // Any slug: a provider the OS does not know yet is stored and shown,
  // and cannot be chosen in a change (choiceProblem).
  provider: z.string().regex(SLUG_PATTERN),
  model: z.string().regex(MODEL_PATTERN),
  day: z.string().refine((value) => isCanonicalPeriodStart("day", value), "is not a real date (YYYY-MM-DD)"),
  calls: count(MAX_CALLS_PER_DAY),
  errors: count(MAX_CALLS_PER_DAY),
  schemaFailures: count(MAX_CALLS_PER_DAY),
  fallbacks: count(MAX_CALLS_PER_DAY),
  refusals: count(MAX_CALLS_PER_DAY),
  inputTokens: count(MAX_TOKENS_PER_DAY),
  outputTokens: count(MAX_TOKENS_PER_DAY),
  /** null or left out: not priced (a self-hosted model). Never read as $0. */
  costUsd: z.number().nonnegative().max(MAX_COST_USD_PER_DAY).nullable().optional(),
  /** null or left out on a day with no timed call. */
  p50Ms: latency.nullable().optional(),
  p95Ms: latency.nullable().optional(),
};

type UsageCounts = {
  calls: number;
  errors: number;
  schemaFailures: number;
  fallbacks: number;
  refusals: number;
  p50Ms?: number | null;
  p95Ms?: number | null;
};

/** No part of a day's calls is more than its calls, and p50 is at most p95. */
function checkCounts(row: UsageCounts, ctx: z.RefinementCtx) {
  for (const field of ["errors", "schemaFailures", "fallbacks", "refusals"] as const) {
    if (row[field] > row.calls) {
      ctx.addIssue({ code: "custom", path: [field], message: "is more than the day's calls." });
    }
  }
  if (row.p50Ms != null && row.p95Ms != null && row.p50Ms > row.p95Ms) {
    ctx.addIssue({ code: "custom", path: ["p50Ms"], message: "is more than p95Ms." });
  }
}

/** A row on the `vertical_agents` source (legacy): `product` names Vertical Startup. */
export const agentUsageRow = z
  .strictObject({ product: z.enum(AGENT_PRODUCTS), ...usageFields })
  .superRefine(checkCounts);

/** A row in Protocol v1: no `product`, since the token says which project it is. */
export const projectUsageRow = z.strictObject(usageFields).superRefine(checkCounts);

export const providerRow = z.strictObject({
  provider: z.string().regex(SLUG_PATTERN),
  model: z.string().regex(MODEL_PATTERN),
  state: z.enum(PROVIDER_STATES),
  checkedAt: z.iso.datetime(),
  lastErrorClass: z.enum(ERROR_CLASSES).nullable().optional(),
});

export const configAppliedRow = z.strictObject({
  version: z.number().int().nonnegative().max(MAX_CONFIG_VERSION),
  /** null where nothing was ever applied: `{ "version": 0, "appliedAt": null }`. */
  appliedAt: z.iso.datetime().nullable(),
});

export const agentUsageList = z.array(agentUsageRow);
export const providerList = z.array(providerRow).max(MAX_PROVIDER_ROWS);

export type AgentUsageIngestRow = z.infer<typeof agentUsageRow>;
export type ProjectUsageRow = z.infer<typeof projectUsageRow>;
export type ProviderIngestRow = z.infer<typeof providerRow>;
export type ConfigAppliedIngest = z.infer<typeof configAppliedRow>;

/** The three keys of an agents push. */
export const AGENT_KEYS = ["agentUsage", "providers", "agentConfigApplied"] as const;

export const AGENTS_ALONE = "An agents push carries nothing else.";
export const AGENTS_EMPTY =
  "Send agentUsage, providers or agentConfigApplied with something in it. An empty list alone is a failed read.";

// ── Protocol v1: POST /agents/v1/usage ───────────────────────────────────────

/** An agent the project can run, as its code declares it. */
export const agentKnownRow = z.strictObject({
  agentId: z.string().regex(AGENT_ID_PATTERN),
  name: z.string().regex(AGENT_NAME_PATTERN),
  /** Whether it handles patient data. */
  phi: z.boolean(),
  kind: z.enum(AGENT_KINDS),
  /** v1.1: the code's harness defaults (convex/lib/agentHarness.ts). Left out: the stored ones are kept. */
  harness: harnessDefaultsWire.optional(),
});
export type AgentKnownRow = z.infer<typeof agentKnownRow>;

/**
 * One usage report from a connected project. Every key is required (a list
 * may be empty); every row is strict; nothing names the project, which the
 * token decides.
 */
export const projectUsageBody = z.strictObject({
  batchId: z.string().regex(BATCH_ID_PATTERN),
  observedAt: z.iso.datetime(),
  agentUsage: z.array(projectUsageRow).max(MAX_USAGE_ROWS),
  providers: providerList,
  agentsKnown: z.array(agentKnownRow).max(MAX_AGENTS_KNOWN),
  configApplied: configAppliedRow,
  /** v1.3: the tools the project can execute. Left out: the stored catalogue is kept. */
  toolsCatalog: z.array(catalogToolWire).max(MAX_CATALOG_TOOLS).optional(),
  /** v1.3: run summaries since the last report: ids, states and numbers. */
  runs: z.array(runSummaryWire).max(MAX_RUNS_PER_PUSH).optional(),
});
export type ProjectUsageBody = z.infer<typeof projectUsageBody>;

const usageKey = (row: ProjectUsageRow) =>
  [row.agentId, row.promptVersion, row.provider, row.model, row.day].join("|");

type Issue = { path: string; message: string };

/**
 * What a push cannot say about itself, because it needs the time it arrived:
 * no day ahead of the sender's (UTC+14 at most) or older than
 * MAX_USAGE_AGE_DAYS, no check or apply time in the future, and no row twice.
 * Paths and words written here: nothing the sender wrote is quoted.
 */
export function agentPushProblems(
  push: {
    agentUsage?: readonly ProjectUsageRow[];
    providers?: readonly ProviderIngestRow[];
    agentConfigApplied?: ConfigAppliedIngest;
  },
  now: number,
  appliedPath = "agentConfigApplied",
): Issue[] {
  const issues: Issue[] = [];
  const latest = dayOf(now + USAGE_DAY_LEAD_MS);
  const earliest = addDays(dayOf(now), -MAX_USAGE_AGE_DAYS);
  const seen = new Set<string>();
  (push.agentUsage ?? []).forEach((row, i) => {
    if (row.day > latest) issues.push({ path: `agentUsage.${i}.day`, message: "is in the future." });
    if (row.day < earliest) {
      issues.push({ path: `agentUsage.${i}.day`, message: `is more than ${MAX_USAGE_AGE_DAYS} days old.` });
    }
    const key = usageKey(row);
    if (seen.has(key)) {
      issues.push({ path: `agentUsage.${i}`, message: "repeats an earlier row's agent, prompt, provider, model and day." });
    }
    seen.add(key);
  });
  const pairs = new Set<string>();
  (push.providers ?? []).forEach((row, i) => {
    if (Date.parse(row.checkedAt) > now + CLOCK_SKEW_MS) {
      issues.push({ path: `providers.${i}.checkedAt`, message: "is in the future." });
    }
    const key = `${row.provider}|${row.model}`;
    if (pairs.has(key)) issues.push({ path: `providers.${i}`, message: "repeats an earlier row's provider and model." });
    pairs.add(key);
  });
  const applied = push.agentConfigApplied;
  if (applied !== undefined && applied.appliedAt !== null && Date.parse(applied.appliedAt) > now + CLOCK_SKEW_MS) {
    issues.push({ path: `${appliedPath}.appliedAt`, message: "is in the future." });
  }
  return issues;
}

/** The same rules for a Protocol v1 report, and: no agent known twice, no report from the future. */
export function projectPushProblems(body: ProjectUsageBody, now: number): Issue[] {
  const issues = agentPushProblems(
    { agentUsage: body.agentUsage, providers: body.providers, agentConfigApplied: body.configApplied },
    now,
    "configApplied",
  );
  if (Date.parse(body.observedAt) > now + CLOCK_SKEW_MS) issues.push({ path: "observedAt", message: "is in the future." });
  const ids = new Set<string>();
  body.agentsKnown.forEach((row, i) => {
    if (ids.has(row.agentId)) issues.push({ path: `agentsKnown.${i}`, message: "repeats an earlier row's agentId." });
    ids.add(row.agentId);
    if (row.harness !== undefined) issues.push(...defaultsProblems(row.harness, `agentsKnown.${i}.harness`));
  });
  if (body.toolsCatalog !== undefined) issues.push(...catalogProblems(body.toolsCatalog));
  if (body.runs !== undefined) issues.push(...runsProblems(body.runs, now));
  return issues;
}
