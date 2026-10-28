// Each project's AI agents, watched and steered from the OS (the `agents`
// area, /agents; the projects are ./agentProjects.ts). The agents run inside
// their project, and patient data never leaves it. What arrives is daily
// totals per agent, prompt version, provider and model (`agentUsage`), each
// provider's latest health (`providers`) and which config version the
// project last applied: on Protocol v1 (POST /agents/v1/usage, a project's
// own token), or, for Vertical Startup until it moves to the package, on the
// legacy `vertical_agents` source's token. What leaves is configuration only:
// each steered agent's on/off switch, model, fallback and monthly budget,
// fetched by the project (GET /agents/v1/config) or, legacy, signed and
// posted to Vertical Startup (convex/agentPush.ts).
//
// Not to be confused with `./agents.ts`, the owner's own agents (the brief,
// proposals): those read the OS and are the internal project `startup-os`.
//
// Pure: the maths of the page and of the owner's `agents` tool, the rules a
// change is held to, and the shape of what is sent. No function here reads a
// clock: each takes `today`, a UTC calendar day, from its caller.

import { GPU } from "./features";

/** The products whose agents report here. The token fixes the source, the source the product. */
export const AGENT_PRODUCTS = ["vertical_startup"] as const;
export type AgentProduct = (typeof AGENT_PRODUCTS)[number];

/**
 * The providers the OS knows. Usage on another slug-shaped provider is
 * stored and shown (Vertical Startup may add one before the OS is told), but a
 * change can only choose one of these.
 */
export const KNOWN_PROVIDERS = ["ai_studio", "vertex", "astana_gpu"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export const isKnownProvider = (value: string): value is KnownProvider =>
  (KNOWN_PROVIDERS as readonly string[]).includes(value);

/** What each provider is called, and whether real patient data may go to it. */
export const PROVIDER_INFO: Record<KnownProvider, { label: string; patientData: boolean }> = {
  ai_studio: { label: "Google AI Studio", patientData: false },
  vertex: { label: "Vertex AI", patientData: true },
  astana_gpu: { label: GPU.label, patientData: false },
};

export const providerLabel = (provider: string): string =>
  isKnownProvider(provider) ? PROVIDER_INFO[provider].label : provider;

export const PATIENT_DATA_NOTE =
  `Only Vertex AI is for real patient data. Google AI Studio and the ${GPU.label} are not.`;

/** A provider's own health, as Vertical Startup last checked it. */
export const PROVIDER_STATES = ["up", "degraded", "down"] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

/** Why a provider's last call failed, as a class: never its message. */
export const ERROR_CLASSES = ["timeout", "auth", "rate_limit", "server", "network", "schema"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

// Ids are short and charset-limited: no free text can travel in one.
/** A product or a provider: "vertical_startup", "astana_gpu". */
export const SLUG_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** An agent: "note-coding.select". */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A prompt version: "v1+2e092415", "3", "2026-10-01.b". */
export const PROMPT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/;
/** A model: "gemini-2.5-pro", "Qwen/Qwen2.5-72B-Instruct". */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

// Plausibility: a value past one of these is a fault, not a busy day.
export const MAX_CALLS_PER_DAY = 10_000_000;
export const MAX_TOKENS_PER_DAY = 1_000_000_000_000;
export const MAX_COST_USD_PER_DAY = 100_000;
export const MAX_LATENCY_MS = 3_600_000;
export const MAX_CONFIG_VERSION = 1_000_000_000;
export const MAX_BUDGET_USD = 1_000_000;
export const MAX_PROVIDER_ROWS = 100;
/** A usage day older than this is refused: Vertical Startup sends recent days. */
export const MAX_USAGE_AGE_DAYS = 400;
/**
 * How far past the OS's UTC "now" a day may run: Vertical Startup may count days
 * in a time zone ahead of UTC (up to UTC+14).
 */
export const USAGE_DAY_LEAD_MS = 14 * 60 * 60 * 1000;
/** How far in the future a reported time may be: clocks drift. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** What the page reads: the series, the comparison and month to date. */
export const SERIES_DAYS = 30;
/** Days of usage a read covers: the series, and a whole month to date. */
export const READ_DAYS = 35;
/** The latest changes a log returns. */
export const CHANGES_SHOWN = 30;

// The steering connection, as Convex env names. Names only are ever shown.
export const VERTICAL_STARTUP_URL = "VERTICAL_STARTUP_URL";
export const VERTICAL_AGENT_CONFIG_SECRET = "VERTICAL_AGENT_CONFIG_SECRET";
/** The source's ingest token, for the page's one sentence before any push. */
export const AGENTS_INGEST_TOKEN = "INGEST_TOKEN_VERTICAL_AGENTS";
/** Shorter than this is a placeholder or a typo, not a secret. */
export const MIN_STEERING_SECRET_LENGTH = 32;
/** Where on Vertical Startup a config is posted. */
export const AGENT_CONFIG_PATH = "/api/admin/agent-config";

// ── Days ─────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** A UTC calendar day `n` days from `day`. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC day of a time. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The first day of `day`'s month. */
export const monthStartOf = (day: string): string => `${day.slice(0, 7)}-01`;

// ── Shapes ───────────────────────────────────────────────────────────────────

/** One stored row of usage: one agent, prompt version, provider and model, on one day. */
export type UsageDay = {
  agentId: string;
  promptVersion: string;
  provider: string;
  model: string;
  day: string;
  calls: number;
  errors: number;
  schemaFailures: number;
  fallbacks: number;
  refusals: number;
  inputTokens: number;
  outputTokens: number;
  /** null: not priced (a self-hosted model), never $0. */
  costUsd: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};

/** An agent's desired state, as the OS last set it. */
export type Control = {
  agentId: string;
  enabled: boolean;
  provider: string;
  model: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  monthlyBudgetUsd: number | null;
  /** What it is called here, where it was launched from the OS. */
  name?: string | null;
  /** A prompt version the project is asked to hold it to. */
  promptVersionPin?: string | null;
  /** The published harness version it runs ("h7"); null: the code's own harness. */
  harnessVersion?: string | null;
  /** One of Startup OS's own four (convex/lib/osAgents.ts): where it runs; null or absent for any other agent. */
  runsOn?: "claude_mac" | "gemini" | null;
  /** The config version this state was last changed in. */
  version: number;
};

export type ModelPair = { provider: string; model: string };

/** A sum of money, or why there is none. */
export type Cost =
  | { usd: number; why: null }
  /** nothing_reported: no row in the period. unpriced: a row with no price, so the total is not known. */
  | { usd: null; why: "nothing_reported" | "unpriced" };

export type OverviewRow = {
  agentId: string;
  /** Whether the OS holds a desired state for it (it has been changed here). */
  steered: boolean;
  /** The desired switch; null for an agent never steered (it runs as Vertical Startup set it). */
  enabled: boolean | null;
  /** The desired model, or, never steered, the one it was last seen on. */
  primary: ModelPair | null;
  primaryObserved: boolean;
  fallback: ModelPair | null;
  /** The prompt version on its newest day. */
  promptVersion: string | null;
  /** null: nothing reported in the seven days (not "0"). */
  calls7d: number | null;
  errorRate7d: number | null;
  schemaFailureRate7d: number | null;
  fallbackRate7d: number | null;
  /** The worst day's p95 among the seven days that have one. */
  p95Ms7d: number | null;
  costToday: Cost;
  costMonth: Cost;
  budgetUsd: number | null;
  /** Month to date over the budget; null where either is not known. */
  budgetShare: number | null;
  /** The newest day it reported, "YYYY-MM-DD". */
  lastSeenDay: string | null;
  version: number | null;
};

export type SeriesDay = {
  day: string;
  /** null: nothing reported that day. */
  calls: number | null;
  errorRate: number | null;
  schemaFailureRate: number | null;
  costUsd: number | null;
  p95Ms: number | null;
};

export type ModelRow = ModelPair & {
  days: number;
  calls: number;
  errorRate: number | null;
  schemaFailureRate: number | null;
  p95Ms: number | null;
  costUsd: number | null;
  costPerCallUsd: number | null;
};

// ── Maths ────────────────────────────────────────────────────────────────────

/** Money summed without float dust (0.25 + 0.05 is 0.3). */
const money = (value: number) => Math.round(value * 1e6) / 1e6;

/** A share of the calls made; none made, no share (never 0%). */
export const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

const sum = (rows: readonly UsageDay[], pick: (row: UsageDay) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

/** The worst p95 among the rows that have one. */
const worstP95 = (rows: readonly UsageDay[]): number | null => {
  const known = rows.flatMap((row) => (row.p95Ms === null ? [] : [row.p95Ms]));
  return known.length === 0 ? null : Math.max(...known);
};

/** What the rows cost: unknown if one has no price, nothing if there are none. */
export function costOf(rows: readonly UsageDay[]): Cost {
  if (rows.length === 0) return { usd: null, why: "nothing_reported" };
  if (rows.some((row) => row.costUsd === null)) return { usd: null, why: "unpriced" };
  return { usd: money(sum(rows, (row) => row.costUsd!)), why: null };
}

const pairKey = (pair: ModelPair) => `${pair.provider}\u0000${pair.model}`;

/** The busiest row of an agent's newest day: the model and prompt it was last seen on. */
export function newestBusiest(rows: readonly UsageDay[]): UsageDay | null {
  if (rows.length === 0) return null;
  const newest = rows.reduce((day, row) => (row.day > day ? row.day : day), rows[0]!.day);
  return rows
    .filter((row) => row.day === newest)
    .reduce((best, row) =>
      row.calls > best.calls || (row.calls === best.calls && pairKey(row) < pairKey(best)) ? row : best,
    );
}

const fallbackOf = (control: Control): ModelPair | null =>
  control.fallbackProvider !== null && control.fallbackModel !== null
    ? { provider: control.fallbackProvider, model: control.fallbackModel }
    : null;

/**
 * One row per agent seen in the usage or steered here, in id order. `rows`
 * is the usage read for the page (READ_DAYS back from `today`).
 */
export function overviewOf(
  rows: readonly UsageDay[],
  controls: readonly Control[],
  today: string,
  /** Agents to list though nothing ran or was steered yet: those built here, as drafts. */
  also: readonly string[] = [],
): OverviewRow[] {
  const ids = [...new Set([...rows.map((row) => row.agentId), ...controls.map((c) => c.agentId), ...also])].sort();
  const weekFrom = addDays(today, -6);
  const monthFrom = monthStartOf(today);
  return ids.map((agentId) => {
    const own = rows.filter((row) => row.agentId === agentId && row.day <= today);
    const week = own.filter((row) => row.day >= weekFrom);
    const calls = sum(week, (row) => row.calls);
    const control = controls.find((c) => c.agentId === agentId) ?? null;
    const seen = newestBusiest(own);
    const costMonth = costOf(own.filter((row) => row.day >= monthFrom));
    const budgetUsd = control?.monthlyBudgetUsd ?? null;
    return {
      agentId,
      steered: control !== null,
      enabled: control?.enabled ?? null,
      primary:
        control !== null
          ? { provider: control.provider, model: control.model }
          : seen === null
            ? null
            : { provider: seen.provider, model: seen.model },
      primaryObserved: control === null && seen !== null,
      fallback: control === null ? null : fallbackOf(control),
      promptVersion: seen?.promptVersion ?? null,
      calls7d: week.length === 0 ? null : calls,
      errorRate7d: rate(sum(week, (row) => row.errors), calls),
      schemaFailureRate7d: rate(sum(week, (row) => row.schemaFailures), calls),
      fallbackRate7d: rate(sum(week, (row) => row.fallbacks), calls),
      p95Ms7d: worstP95(week),
      costToday: costOf(own.filter((row) => row.day === today)),
      costMonth,
      budgetUsd,
      budgetShare: budgetUsd === null || costMonth.usd === null ? null : costMonth.usd / budgetUsd,
      lastSeenDay: seen?.day ?? null,
      version: control?.version ?? null,
    };
  });
}

/** One agent's last thirty days, a day at a time, summed over its models. */
export function seriesOf(rows: readonly UsageDay[], agentId: string, today: string): SeriesDay[] {
  const own = rows.filter((row) => row.agentId === agentId);
  return Array.from({ length: SERIES_DAYS }, (_, i) => {
    const day = addDays(today, i - (SERIES_DAYS - 1));
    const that = own.filter((row) => row.day === day);
    if (that.length === 0) {
      return { day, calls: null, errorRate: null, schemaFailureRate: null, costUsd: null, p95Ms: null };
    }
    const calls = sum(that, (row) => row.calls);
    return {
      day,
      calls,
      errorRate: rate(sum(that, (row) => row.errors), calls),
      schemaFailureRate: rate(sum(that, (row) => row.schemaFailures), calls),
      costUsd: costOf(that).usd,
      p95Ms: worstP95(that),
    };
  });
}

/** Each provider and model an agent ran on in thirty days, busiest first. */
export function modelsOf(rows: readonly UsageDay[], agentId: string, today: string): ModelRow[] {
  const from = addDays(today, -(SERIES_DAYS - 1));
  const own = rows.filter((row) => row.agentId === agentId && row.day >= from && row.day <= today);
  const groups = new Map<string, UsageDay[]>();
  for (const row of own) groups.set(pairKey(row), [...(groups.get(pairKey(row)) ?? []), row]);
  return [...groups.values()]
    .map((group) => {
      const calls = sum(group, (row) => row.calls);
      const cost = costOf(group).usd;
      return {
        provider: group[0]!.provider,
        model: group[0]!.model,
        days: new Set(group.map((row) => row.day)).size,
        calls,
        errorRate: rate(sum(group, (row) => row.errors), calls),
        schemaFailureRate: rate(sum(group, (row) => row.schemaFailures), calls),
        p95Ms: worstP95(group),
        costUsd: cost,
        costPerCallUsd: cost === null || calls === 0 ? null : cost / calls,
      };
    })
    .sort((a, b) => b.calls - a.calls || pairKey(a).localeCompare(pairKey(b)));
}

// ── Changes ──────────────────────────────────────────────────────────────────

/**
 * How a change reaches its project. pull: nothing is pushed, the project
 * fetches its config (Protocol v1, GET /agents/v1/config). The rest are the
 * legacy push to Vertical Startup's: queued: waiting to be sent; sent: Vertical Startup
 * answered 2xx; failed: it could not be reached, refused it or answered
 * nonsense; not_connected: the steering variables are not set.
 */
export const PUSH_OUTCOMES = ["queued", "sent", "failed", "not_connected", "pull"] as const;
export type PushOutcome = (typeof PUSH_OUTCOMES)[number];

/**
 * Why a push failed, as a key the page words: never what Vertical Startup said.
 * The status codes are Vertical Startup's endpoint's (failureOfStatus).
 */
export const PUSH_FAILURES = [
  "not_connected",
  "unreachable",
  "rejected",
  "unauthorized",
  "too_large",
  "not_set_up_there",
  "storage_failed",
  "refused",
  "bad_answer",
  "stale",
] as const;
export type PushFailure = (typeof PUSH_FAILURES)[number];

export const PUSH_FAILURE_WORDS: Record<PushFailure, string> = {
  not_connected: "Steering is not connected.",
  unreachable: "Vertical Startup could not be reached.",
  rejected: "Vertical Startup rejected the config: an agent or provider it does not know, or a malformed body.",
  unauthorized: "Vertical Startup did not accept the signature or its time. Check that both sides have the same secret.",
  too_large: "The config was too large for Vertical Startup.",
  not_set_up_there: "Steering is not set up on Vertical Startup's side.",
  storage_failed: "Vertical Startup could not store the config. Send it again.",
  refused: "Vertical Startup refused the change.",
  bad_answer: "Vertical Startup's answer was not understood.",
  stale: "Vertical Startup holds a newer config version. Send it again to apply this one.",
};

/** A non-2xx answer from Vertical Startup's endpoint, as a key. */
export function failureOfStatus(status: number): PushFailure {
  switch (status) {
    case 400:
      return "rejected";
    case 401:
      return "unauthorized";
    case 413:
      return "too_large";
    case 502:
      return "storage_failed";
    case 503:
      return "not_set_up_there";
    default:
      return "refused";
  }
}

export type ChangeStatus = "pending" | "applied" | "failed";

/**
 * Applied once Vertical Startup has applied this version or a later one (a later
 * config carries every agent's state); failed while the push that carried it
 * failed and nothing later was applied; pending otherwise.
 */
export function changeStatus(
  change: { version: number; push: PushOutcome; failure?: PushFailure | null },
  appliedVersion: number | null,
): ChangeStatus {
  // Vertical Startup held a newer version than this one: whatever version it
  // reports since says nothing about this change until it is sent again.
  if (change.failure === "stale") return "failed";
  if (appliedVersion !== null && appliedVersion >= change.version) return "applied";
  if (change.push === "failed" || change.push === "not_connected") return "failed";
  return "pending";
}

export const CHOOSE_UP = "Choose a model that is up.";

/**
 * Whether an agent may be moved to a model: one seen up on a provider the
 * OS knows, or the one it already has.
 */
export function choiceProblem(
  pair: ModelPair,
  providers: readonly (ModelPair & { state: ProviderState })[],
  current: ModelPair | null,
): string | null {
  if (current !== null && pairKey(current) === pairKey(pair)) return null;
  const up = providers.some(
    (row) => row.state === "up" && isKnownProvider(row.provider) && pairKey(row) === pairKey(pair),
  );
  return up ? null : CHOOSE_UP;
}

export const BUDGET_WORDS = "A monthly budget is more than $0 and at most $1,000,000.";

/** What a whole desired state must be, whatever changed. */
export function desiredProblem(next: Control): string | null {
  if ((next.fallbackProvider === null) !== (next.fallbackModel === null)) {
    return "A fallback needs a provider and a model.";
  }
  const fallback = fallbackOf(next);
  if (fallback !== null && pairKey(fallback) === pairKey(next)) {
    return "The fallback must differ from the model.";
  }
  const budget = next.monthlyBudgetUsd;
  if (budget !== null && !(Number.isFinite(budget) && budget > 0 && budget <= MAX_BUDGET_USD)) {
    return BUDGET_WORDS;
  }
  return null;
}

/** One agent as Vertical Startup is sent it. */
export type AgentConfig = {
  agentId: string;
  enabled: boolean;
  provider: string;
  model: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  monthlyBudgetUsd?: number;
};

/** The whole config at a version: every agent the OS steers, in id order. */
export function configBody(
  version: number,
  controls: readonly Control[],
): { version: number; agents: AgentConfig[] } {
  return {
    version,
    agents: [...controls]
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map((c) => ({
        agentId: c.agentId,
        enabled: c.enabled,
        provider: c.provider,
        model: c.model,
        ...(c.fallbackProvider !== null && c.fallbackModel !== null
          ? { fallbackProvider: c.fallbackProvider, fallbackModel: c.fallbackModel }
          : {}),
        ...(c.monthlyBudgetUsd !== null ? { monthlyBudgetUsd: c.monthlyBudgetUsd } : {}),
      })),
  };
}

/**
 * What Vertical Startup's 2xx answer says: the version it holds now, and `stale`
 * when the version sent was not newer than that one. Null for anything else.
 */
export function pushAnswerOf(raw: unknown): { appliedVersion: number; stale: boolean } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { appliedVersion, stale } = raw as { appliedVersion?: unknown; stale?: unknown };
  const valid =
    typeof appliedVersion === "number" &&
    Number.isInteger(appliedVersion) &&
    appliedVersion >= 0 &&
    appliedVersion <= MAX_CONFIG_VERSION;
  return valid ? { appliedVersion, stale: stale === true } : null;
}

/**
 * How a 2xx answer settles a push of `version`. Applied there at this
 * version or a later one we made: sent, with that version. Stale and holding
 * a version past ours: Vertical Startup has a newer config than the OS knows of,
 * so ours was not applied; the next send goes out above `remoteVersion`.
 * Stale at exactly ours: this version was applied before (a repeat), so sent.
 */
export function settleAnswer(
  answer: { appliedVersion: number; stale: boolean },
  version: number,
):
  | { outcome: "sent"; appliedVersion: number }
  | { outcome: "failed"; failure: "stale"; remoteVersion: number } {
  if (answer.stale && answer.appliedVersion > version) {
    return { outcome: "failed", failure: "stale", remoteVersion: answer.appliedVersion };
  }
  return { outcome: "sent", appliedVersion: answer.appliedVersion };
}

// ── The connection ───────────────────────────────────────────────────────────

/**
 * Where a config is posted, or null. The secret's signature goes to this
 * address, so it must be exactly an https origin: a typo must not send it
 * somewhere else. Nothing of the variable is ever echoed.
 */
export function steeringEndpoint(raw: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    return null;
  }
  const exact =
    url.protocol === "https:" &&
    url.hostname !== "" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === "/" &&
    !(raw ?? "").includes("?") &&
    !(raw ?? "").includes("#");
  return exact ? `${url.origin}${AGENT_CONFIG_PATH}` : null;
}

/** The steering variables that are unset or unusable, by name. */
export function steeringMissing(env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  if (steeringEndpoint(env[VERTICAL_STARTUP_URL]) === null) missing.push(VERTICAL_STARTUP_URL);
  if ((env[VERTICAL_AGENT_CONFIG_SECRET] ?? "").length < MIN_STEERING_SECRET_LENGTH) {
    missing.push(VERTICAL_AGENT_CONFIG_SECRET);
  }
  return missing;
}
