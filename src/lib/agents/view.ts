// The Agents page's words and states, worked out in the browser against a
// ticking clock (`useNow()`): nothing here is read inside a query.

import {
  AGENTS_INGEST_TOKEN,
  KNOWN_PROVIDERS,
  VERTICAL_AGENT_CONFIG_SECRET,
  VERTICAL_STARTUP_URL,
  PROVIDER_INFO,
  isKnownProvider,
  providerLabel,
  type ChangeStatus,
  type Cost,
  type ProviderState,
} from "@convex/lib/agentControl";
import { AGENTS_TOKEN_ENV, AGENTS_URL_ENV, type FailMode, type Region } from "@convex/lib/agentProjects";
import { PRODUCT } from "@convex/lib/identity";
import { DEFAULT_RUNS_ON, RUNS_ON_WORDS, type RunsOn } from "@convex/lib/osAgents";
import type { Cadence } from "@convex/lib/cadence";
import { agoWords, classify, type FreshnessState } from "@/lib/source-freshness";

/** "$0.12", "$12.34", "$1,234". */
export function usd(value: number): string {
  if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

/** "820 ms", "9.8 s". */
export function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** "4.2%", "0%", "<0.1%". */
export function percent(rate: number): string {
  if (rate === 0) return "0%";
  if (rate < 0.001) return "<0.1%";
  return `${(rate * 100).toFixed(1)}%`;
}

/** A cost's words: the sum, or why there is none. */
export function costWords(cost: Cost): string {
  if (cost.usd !== null) return usd(cost.usd);
  return cost.why === "unpriced" ? "Not priced" : "None reported";
}

/** What a cost's missing figure means, for its title. */
export function costNote(cost: Cost): string | null {
  if (cost.why === "unpriced") return "A model it ran on has no price (self-hosted), so the total is not known.";
  if (cost.why === "nothing_reported") return "Nothing reported for this period yet.";
  return null;
}

/** "gemini-2.5-pro on Vertex AI". */
export const pairWords = (pair: { provider: string; model: string }) =>
  `${pair.model} on ${providerLabel(pair.provider)}`;

export const STATUS_WORDS: Record<ChangeStatus, string> = {
  pending: "Pending",
  applied: "Applied",
  failed: "Not sent",
};

/** A provider is expected to be checked each day, with Vertical Startup's push. */
const PROVIDER_CHECK: Cadence = { kind: "pushed", everyDays: 1 };

export type ProviderReading = {
  /** The freshness state the page header uses, so tones and words agree. */
  state: FreshnessState;
  words: string;
};

/**
 * A provider's state as the page shows it: down is failed, degraded is late,
 * up is on time until its check is older than a day's push, never seen is
 * "Not connected".
 */
export function providerReading(
  row: { state: ProviderState; checkedAt: number } | null,
  now: number,
): ProviderReading {
  if (row === null) return { state: "never", words: "Not connected" };
  if (row.state === "down") return { state: "failed", words: "Down" };
  if (row.state === "degraded") return { state: "late", words: "Degraded" };
  const state = classify({ cadence: PROVIDER_CHECK, lastOkAt: row.checkedAt, failureKey: null }, now);
  return state === "fresh" ? { state, words: "Up" } : { state, words: "Up, not checked lately" };
}

/** The providers' panel: the three the OS knows, then any other Vertical Startup reported. */
export function providerGroups<Row extends { provider: string; model: string }>(rows: readonly Row[]) {
  const others = [...new Set(rows.map((row) => row.provider).filter((p) => !isKnownProvider(p)))].sort();
  return [...KNOWN_PROVIDERS, ...others].map((provider) => ({
    provider,
    label: providerLabel(provider),
    known: isKnownProvider(provider),
    patientData: isKnownProvider(provider) ? PROVIDER_INFO[provider].patientData : false,
    models: rows.filter((row) => row.provider === provider),
  }));
}

/** Before any project is connected or has reported: one line per step. */
export const EMPTY_STEPS = [
  "Connect a project: it gets a token, shown once.",
  `Install the agents package in that project and set ${AGENTS_URL_ENV} and ${AGENTS_TOKEN_ENV}.`,
  "Its agents report here once a day; launch and steer them from this page.",
] as const;

/** Vertical Startup's older way in, said on its own project until it moves to the package. */
export const LEGACY_SENTENCE = `Vertical Startup still reports on the older ${AGENTS_INGEST_TOKEN} push, and is steered by a signed push to ${VERTICAL_STARTUP_URL} with ${VERTICAL_AGENT_CONFIG_SECRET}, until it moves to the package. A token below connects it the new way.`;

/** Said when Vertical Startup's legacy steering is not connected: the names of what is missing, never a value. */
export function notConnectedWords(missing: readonly string[]): string {
  return `Steering is not connected: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set in the Convex env. Changes are recorded, and are not sent.`;
}

export const REGION_WORDS: Record<Region, string> = { US: "United States", KZ: "Kazakhstan" };

export const FAIL_MODE_WORDS: Record<FailMode, string> = {
  closed: `Fails closed: its agents stop when it cannot reach ${PRODUCT.name}.`,
  open: `Fails open: its agents keep their last config when it cannot reach ${PRODUCT.name}.`,
};

/** A project's connection, in a few words and a freshness state for its chip. */
export function connectionReading(
  card: { connected: boolean; status: "active" | "disconnected"; legacy: boolean; lastSeenAt: number | null; lastUsageAt: number | null },
  now: number,
): ProviderReading {
  if (card.status === "disconnected") return { state: "failed", words: "Disconnected" };
  if (!card.connected) {
    return card.legacy && card.lastUsageAt !== null
      ? { state: "typed", words: `Legacy push, ${agoWords(now, card.lastUsageAt)}` }
      : { state: "never", words: "No token yet" };
  }
  if (card.lastSeenAt === null) return { state: "never", words: "Waiting for its first call" };
  const state = classify({ cadence: PROVIDER_CHECK, lastOkAt: card.lastSeenAt, failureKey: null }, now);
  return { state, words: `Last seen ${agoWords(now, card.lastSeenAt)}` };
}

/** A desired state in a few words, for the change log. */
export function desiredWords(state: {
  enabled: boolean;
  provider: string;
  model: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  monthlyBudgetUsd?: number;
  promptVersionPin?: string;
  harnessVersion?: string;
  runsOn?: RunsOn;
}): string {
  const parts = [state.enabled ? "On" : "Off", pairWords(state)];
  if (state.runsOn !== undefined) parts.push(`runs on ${RUNS_ON_WORDS[state.runsOn]}`);
  if (state.fallbackProvider !== undefined && state.fallbackModel !== undefined) {
    parts.push(`fallback ${pairWords({ provider: state.fallbackProvider, model: state.fallbackModel })}`);
  }
  if (state.monthlyBudgetUsd !== undefined) parts.push(`budget ${usd(state.monthlyBudgetUsd)} a month`);
  if (state.promptVersionPin !== undefined) parts.push(`prompt pinned to ${state.promptVersionPin}`);
  if (state.harnessVersion !== undefined) parts.push(`harness ${state.harnessVersion}`);
  return parts.join(", ");
}

/** What changed between two states, in words: only the parts that differ. */
export function changeWords(
  before: Parameters<typeof desiredWords>[0] | null,
  after: Parameters<typeof desiredWords>[0],
): string {
  if (before === null) return `Steered from here: ${desiredWords(after)}`;
  const said: string[] = [];
  if (before.enabled !== after.enabled) said.push(after.enabled ? "Switched on" : "Switched off");
  if (before.provider !== after.provider || before.model !== after.model) {
    said.push(`Model ${pairWords(before)} → ${pairWords(after)}`);
  }
  const fb = (s: typeof after) =>
    s.fallbackProvider !== undefined && s.fallbackModel !== undefined
      ? pairWords({ provider: s.fallbackProvider, model: s.fallbackModel })
      : "none";
  if (fb(before) !== fb(after)) said.push(`Fallback ${fb(before)} → ${fb(after)}`);
  if (before.monthlyBudgetUsd !== after.monthlyBudgetUsd) {
    const b = (v: number | undefined) => (v === undefined ? "none" : usd(v));
    said.push(`Budget ${b(before.monthlyBudgetUsd)} → ${b(after.monthlyBudgetUsd)}`);
  }
  if (before.promptVersionPin !== after.promptVersionPin) {
    said.push(`Prompt pin ${before.promptVersionPin ?? "none"} → ${after.promptVersionPin ?? "none"}`);
  }
  if (before.harnessVersion !== after.harnessVersion) {
    said.push(`Harness ${before.harnessVersion ?? "the project's built-in"} → ${after.harnessVersion ?? "the project's built-in"}`);
  }
  if (before.runsOn !== after.runsOn) {
    const where = (value: RunsOn | undefined) => (value === undefined ? RUNS_ON_WORDS[DEFAULT_RUNS_ON] : RUNS_ON_WORDS[value]);
    said.push(`Runs on ${where(before.runsOn)} → ${where(after.runsOn)}`);
  }
  return said.join("; ");
}
