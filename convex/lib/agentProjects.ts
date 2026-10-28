// The projects whose AI agents Startup OS steers (the `agents` area, /agents).
// A project is a product of ours with agents of its own: Vertical Startup, Policy
// Startup, Globex, and Startup OS itself. **The agents run inside each project**,
// and patient data never leaves it: Startup OS stores configuration and daily
// totals only.
//
// A connected project holds a token (`rap_…`, shown once, stored as its
// SHA-256) and speaks Protocol v1 (docs/agents-protocol.md):
//
//   GET  /agents/v1/config   what it should run: each agent's switch, model,
//                            fallback and budget, at a version
//   POST /agents/v1/usage    daily totals, provider health, the agents it can
//                            run, and the config version it applied
//
// Vertical Startup also still reports on the older `vertical_agents` ingest source and
// is steered by the signed push (convex/agentPush.ts): that path is legacy and
// maps to the project `vertical-startup` (LEGACY_PROJECT) until Vertical Startup moves
// to the package.
//
// Pure: the UI imports it. Every refusal is fixed words: none quotes a value.

import {
  KNOWN_PROVIDERS,
  PROVIDER_INFO,
  isKnownProvider,
  providerLabel,
  type Control,
  type KnownProvider,
} from "./agentControl";
import type { ConfigDefinition } from "./agentBuilder";
import type { ConfigHarness } from "./agentHarness";
import { PRODUCT } from "./identity";
import { base64Url } from "./personalRules";

// ── Projects ─────────────────────────────────────────────────────────────────

/** The project the `vertical_agents` source and the signed push speak for. */
export const LEGACY_PROJECT = "vertical-startup";
export const LEGACY_PROJECT_NAME = "Vertical Startup";

/** Startup OS's own agents: an internal project, never token-connected (convex/lib/agents.ts). */
// Stored on rows as the project's id: the product's slug, fixed for a deployment's life.
export const INTERNAL_PROJECT = PRODUCT.slug;
export const INTERNAL_PROJECT_NAME = PRODUCT.name;
export const INTERNAL_PROJECT_NOTE =
  "Its own four agents run on the owner's Mac through Claude, or here on Gemini, as the owner chooses for each; not priced.";

/** A project's slug: "startup-atlas". Lowercase letters, digits and hyphens. */
export const PROJECT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
/** A project's name, as people call it: "Startup Atlas". */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .&'()-]{0,59}$/;
/** What a project calls one of its agents: "Note coding, select step". */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,:()&'/+_-]{0,59}$/;

export const REGIONS = ["US", "KZ"] as const;
export type Region = (typeof REGIONS)[number];

/** active: it may call (with a token once one is issued); disconnected: its token was taken away. */
export const PROJECT_STATUSES = ["active", "disconnected"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** What a project does when it cannot reach Startup OS: run nothing (closed) or keep its last config (open). */
export type FailMode = "closed" | "open";

/** "closed" for a project that holds patient data, "open" otherwise. */
export const failModeOf = (holdsPatientData: boolean): FailMode => (holdsPatientData ? "closed" : "open");

export const AGENT_KINDS = ["code", "declarative"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** The providers real patient data may go to. Extend by marking a provider in PROVIDER_INFO. */
export const PATIENT_DATA_PROVIDERS: readonly KnownProvider[] = KNOWN_PROVIDERS.filter(
  (provider) => PROVIDER_INFO[provider].patientData,
);

/** The providers a project may be given: every known one, or only those for patient data. */
export const providersFor = (holdsPatientData: boolean): KnownProvider[] =>
  KNOWN_PROVIDERS.filter((provider) => !holdsPatientData || PROVIDER_INFO[provider].patientData);

/**
 * The projects the owner named first, to fill the form, with whether each
 * holds patient data: Vertical Startup reads clinical notes and Globex reads
 * medical images; Startup Atlas searches payer policies and holds none. The
 * form still lets it be changed.
 */
export const SUGGESTED_PROJECTS: readonly { name: string; slug: string; region: Region; holdsPatientData: boolean }[] = [
  { name: LEGACY_PROJECT_NAME, slug: LEGACY_PROJECT, region: "US", holdsPatientData: true },
  { name: "Startup Atlas", slug: "startup-atlas", region: "US", holdsPatientData: false },
  { name: "Globex", slug: "globex", region: "KZ", holdsPatientData: true },
];

// ── Words ────────────────────────────────────────────────────────────────────

export const PROJECT_WORDS = {
  slug: "A project's id is 2 to 40 lowercase letters, digits and hyphens, starting with a letter.",
  name: "A project's name is 1 to 60 letters, digits, spaces and . & ' ( ) -.",
  reserved: `That id is ${PRODUCT.name}'s own project. Choose another.`,
  taken: "A project with that id is already connected.",
  noSuch: "There is no project by that id.",
  internal: `${PRODUCT.name}'s own agents are not connected with a token.`,
  providers: "Choose at least one provider the OS knows.",
  patientProviders: "A project that holds patient data may only use providers for patient data (Vertex AI).",
  tokenNotMade: "The token could not be made. Try again.",
} as const;

export const LAUNCH_WORDS = {
  agentId: "An agent's id is 1 to 64 lowercase letters, digits, dots, hyphens and underscores.",
  name: "An agent's name is 1 to 60 letters, digits, spaces and simple punctuation.",
  launched: "That agent is already launched in this project. Change it from its row.",
  promptVersion: "A prompt version is up to 40 letters, digits, dots, plus signs, hyphens and underscores.",
  notAllowed: "That provider is not one this project may use.",
  patientData: "This project holds patient data: choose a provider for patient data (Vertex AI).",
  phiAgent: "This agent handles patient data: choose a provider for patient data (Vertex AI).",
} as const;

/** Why a list of providers cannot be a project's, or null. */
export function allowedProvidersProblem(list: readonly string[], holdsPatientData: boolean): string | null {
  if (list.length === 0 || !list.every(isKnownProvider) || new Set(list).size !== list.length) {
    return PROJECT_WORDS.providers;
  }
  if (holdsPatientData && list.some((provider) => !PROVIDER_INFO[provider as KnownProvider].patientData)) {
    return PROJECT_WORDS.patientProviders;
  }
  return null;
}

/**
 * Whether a project may steer an agent to a provider: one of its own, and
 * one for patient data where the project holds it or the agent handles it.
 */
export function providerPolicyProblem(
  provider: string,
  project: { allowedProviders: readonly string[]; holdsPatientData: boolean },
  agentPhi: boolean,
): string | null {
  if (!project.allowedProviders.includes(provider)) return LAUNCH_WORDS.notAllowed;
  const forPatients = isKnownProvider(provider) && PROVIDER_INFO[provider].patientData;
  if (project.holdsPatientData && !forPatients) return LAUNCH_WORDS.patientData;
  if (agentPhi && !forPatients) return LAUNCH_WORDS.phiAgent;
  return null;
}

/** "Vertex AI" or "Vertex AI and Google AI Studio". */
export const providerList = (providers: readonly string[]) =>
  providers.map(providerLabel).join(providers.length === 2 ? " and " : ", ");

// ── The token ────────────────────────────────────────────────────────────────

/**
 * What a project token begins with. Unlike every other token here (`sos_`
 * personal, `sosa_` the owner's agent): a route tells them apart by this
 * prefix before hashing anything.
 */
export const PROJECT_TOKEN_PREFIX = "rap_";
export const PROJECT_TOKEN_BYTES = 32;

export const isProjectToken = (given: string): boolean =>
  given.startsWith(PROJECT_TOKEN_PREFIX) && given.length <= 200;

/** A token made of these bytes. */
export const projectTokenFrom = (bytes: Uint8Array): string => `${PROJECT_TOKEN_PREFIX}${base64Url(bytes)}`;

// ── Protocol v1 (v1.1: harnesses and test jobs) ──────────────────────────────

export const PROTOCOL_VERSION = 1;
/**
 * v1.1 added harness defaults to the usage report, `harness` to the config,
 * and test jobs; v1.2 variants, sections and conversations; v1.3 agents built
 * here (`kind: "declarative"` with a `definition`), the tool catalogue and
 * run summaries.
 */
export const PROTOCOL_MINOR = 3;
export const CONFIG_PATH = "/agents/v1/config";
export const USAGE_PATH = "/agents/v1/usage";
export const JOBS_PATH = "/agents/v1/jobs";

/** The package's two variables, as the project sets them. Names only are ever shown. */
export const AGENTS_URL_ENV = "STARTUP_AGENTS_URL";
export const AGENTS_TOKEN_ENV = "STARTUP_AGENTS_TOKEN";

/** Calls a project token may make in a window (every route together), like the owner's agent endpoint. */
export const MAX_PROJECT_CALLS_PER_WINDOW = 120;
/**
 * The largest usage body, in bytes: v1.1 raised it from 512 KiB, since
 * harness defaults ride in it, and v1.2 from 4 MiB, since one may be 512 KB.
 * Under the 20 MiB an HTTP action may read; each harness is stored apart.
 */
export const MAX_USAGE_BYTES = 16 * 1024 * 1024;
/** The most agents one push may say the project can run. */
export const MAX_AGENTS_KNOWN = 200;
/** The most agents launched in one project. */
export const MAX_AGENTS_PER_PROJECT = 200;

/** The words an HTTP refusal carries, by its error name. Fixed: nothing sent is quoted. */
export const API_WORDS = {
  unauthorized: "Send Authorization: Bearer with this project's token.",
  too_many_requests: `At most ${MAX_PROJECT_CALLS_PER_WINDOW} calls in 10 minutes. Try again later.`,
  payload_too_large: "The body is larger than this route takes: a usage report 16 MiB, results 14 MiB.",
  invalid_json: "The body is not JSON.",
  invalid_body: "The body does not follow Agents Protocol v1.1.",
  not_found: "There is no such job for this project.",
  job_closed: "That job is closed: its results are in, or it was given up on.",
  write_failed: "It could not be stored. Send it again.",
} as const;

/** One agent in GET /agents/v1/config. `kind` and `definition` (v1.3) only for an agent built here. */
export type ProjectAgentConfig = {
  agentId: string;
  name: string;
  enabled: boolean;
  provider: string;
  model: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  monthlyBudgetUsd?: number;
  promptVersionPin?: string;
  /** v1.1: its published harness version, only the parts that differ from the code's. */
  harness?: ConfigHarness;
  /** v1.3: an agent built here, run by the package from `definition` (its harness inside it). */
  kind?: "declarative";
  definition?: ConfigDefinition;
};

export type ProjectConfig = {
  project: string;
  version: number;
  agents: ProjectAgentConfig[];
  failMode: FailMode;
};

/**
 * What a project is told to run: every agent launched or changed here, in id
 * order, at the project's latest version. An agent never steered here is not
 * in it, and the project keeps its own settings for it. `names` is what the
 * project's own catalogue calls each agent, for one launched without a name.
 */
export function projectConfigBody(
  project: { slug: string; holdsPatientData: boolean },
  version: number,
  controls: readonly Control[],
  names: ReadonlyMap<string, string>,
  harnesses: ReadonlyMap<string, ConfigHarness> = new Map(),
  definitions: ReadonlyMap<string, ConfigDefinition> = new Map(),
): ProjectConfig {
  return {
    project: project.slug,
    version,
    agents: [...controls]
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map((c) => ({
        agentId: c.agentId,
        name: c.name ?? names.get(c.agentId) ?? c.agentId,
        enabled: c.enabled,
        provider: c.provider,
        model: c.model,
        ...(c.fallbackProvider !== null && c.fallbackModel !== null
          ? { fallbackProvider: c.fallbackProvider, fallbackModel: c.fallbackModel }
          : {}),
        ...(c.monthlyBudgetUsd !== null ? { monthlyBudgetUsd: c.monthlyBudgetUsd } : {}),
        ...(c.promptVersionPin != null ? { promptVersionPin: c.promptVersionPin } : {}),
        ...(harnesses.has(c.agentId) ? { harness: harnesses.get(c.agentId)! } : {}),
        ...(definitions.has(c.agentId) ? { kind: "declarative" as const, definition: definitions.get(c.agentId)! } : {}),
      })),
    failMode: failModeOf(project.holdsPatientData),
  };
}

/**
 * The setup text shown once with a new token: the two variables the package
 * reads. `siteUrl` is this deployment's HTTP origin (`*.convex.site`), with
 * nothing after it; null where the site's configuration gives none.
 */
export function setupText(siteUrl: string | null, token: string | null): string {
  return [
    `${AGENTS_URL_ENV}=${siteUrl ?? "<this deployment's .convex.site origin>"}`,
    `${AGENTS_TOKEN_ENV}=${token ?? "<the token shown once>"}`,
  ].join("\n");
}

/** Whether an If-None-Match header names this version: `"7"`, `W/"7"`, or a list holding one. */
export function matchesVersion(header: string | null, version: number): boolean {
  if (header === null) return false;
  const tag = `"${version}"`;
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === tag);
}
