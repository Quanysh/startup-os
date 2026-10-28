import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import {
  AGENT_ID_PATTERN,
  CHANGES_SHOWN,
  PROMPT_VERSION_PATTERN,
  READ_DAYS,
  addDays,
  changeStatus,
  choiceProblem,
  configBody,
  desiredProblem,
  isKnownProvider,
  modelsOf,
  overviewOf,
  seriesOf,
  steeringMissing,
  type Control,
  type ModelPair,
  type OverviewRow,
  type UsageDay,
} from "./lib/agentControl";
import {
  adoptLegacy,
  agentPhi,
  builderPolicyOf,
  allUsageSince,
  asControl,
  catalogOf,
  configRow,
  controlOf,
  controlsOf,
  declaredIn,
  declaredOf,
  ensureLegacyProject,
  hasUsage,
  lastSeen,
  policyOf,
  projectOf,
  projectRow,
  providersOf,
  publishedVersionOf,
  slugsOf,
  storeRows,
  usageSince,
  type CatalogEntry,
  type ProjectPolicy,
  type ProviderView,
} from "./lib/agentData";
import { featureOn, requireFeature } from "./lib/featureGates";
import {
  AGENT_NAME_PATTERN,
  INTERNAL_PROJECT,
  LAUNCH_WORDS,
  LEGACY_PROJECT,
  MAX_AGENTS_PER_PROJECT,
  PROJECT_WORDS,
  providerPolicyProblem,
  type AgentKind,
} from "./lib/agentProjects";
import type { AgentId } from "./lib/agents";
import { agentsOff, setAgent as switchAgent } from "./lib/agentStore";
import { OS_AGENT_WORDS, isOsAgent, macActForbidden, runsOnOf, type RunsOn } from "./lib/osAgents";
import { NOT_ALLOWED, isOwner, memberMutation, memberQuery, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { knows, teamDirectory } from "./lib/teamDirectory";
import { pushFailureValidator, pushOutcomeValidator, runsOnValidator } from "./schema";
import { setSourceStatus } from "./snapshots";

// Each project's AI agents: what they did (daily totals, reported by the
// project on Protocol v1, convex/agentProjects.ts, or by Vertical Startup on the
// legacy `vertical_agents` source), the health of the providers they run on, and
// the switches that steer them. The maths and the rules are in
// convex/lib/agentControl.ts and convex/lib/agentProjects.ts; the tables are
// read and written through convex/lib/agentData.ts. Everything here is the
// `agents` area's, and it is not split by company.
//
// `project` is a project's slug. Where a function takes it as optional, left
// out it is Vertical Startup (LEGACY_PROJECT), as every call was before projects.
//
// No patient data: a usage row is ids and numbers, a provider row a state and
// a time, and what is sent back is configuration.

/** Words for a change that cannot be made. Fixed: no id or value a caller sent is quoted. */
export const NO_SUCH_AGENT = "There is no agent by that id.";
export const PAIR_TOGETHER = "Choose a provider and a model together.";
export const NOT_A_DATE = "today is not a date";
export const BUILT_LAUNCH = "That agent is built here: it goes live when it is published, from its Builder tab.";
export const BUILT_MODEL =
  "An agent built here changes its model in its definition: start a draft, test it and publish it.";

const usageRow = v.object({
  product: v.optional(v.string()),
  agentId: v.string(),
  promptVersion: v.string(),
  provider: v.string(),
  model: v.string(),
  day: v.string(),
  calls: v.number(),
  errors: v.number(),
  schemaFailures: v.number(),
  fallbacks: v.number(),
  refusals: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  costUsd: v.optional(v.union(v.number(), v.null())),
  p50Ms: v.optional(v.union(v.number(), v.null())),
  p95Ms: v.optional(v.union(v.number(), v.null())),
});

const providerRow = v.object({
  provider: v.string(),
  model: v.string(),
  state: v.union(v.literal("up"), v.literal("degraded"), v.literal("down")),
  checkedAt: v.string(),
  lastErrorClass: v.optional(
    v.union(
      v.literal("timeout"),
      v.literal("auth"),
      v.literal("rate_limit"),
      v.literal("server"),
      v.literal("network"),
      v.literal("schema"),
      v.null(),
    ),
  ),
});

const appliedRow = v.object({ version: v.number(), appliedAt: v.union(v.string(), v.null()) });

/** What the internal functions of Protocol v1 hand in (convex/agentProjects.ts). */
export const usageValidators = { usageRow, providerRow, appliedRow };

/**
 * One push from Vertical Startup on the legacy `vertical_agents` source, already
 * checked by the endpoint (convex/lib/agentShape.ts): rows stored as the
 * legacy project's, a batch of rows from before projects stamped as its, the
 * run log and the source's status, in one transaction.
 */
export const apply = internalMutation({
  args: {
    source: v.string(),
    batchId: v.optional(v.string()),
    observedAt: v.optional(v.string()),
    startedAt: v.number(),
    usage: v.array(usageRow),
    providers: v.array(providerRow),
    // `appliedAt` is null where nothing was ever applied (version 0).
    applied: v.optional(appliedRow),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const project = await ensureLegacyProject(ctx, now);
    await adoptLegacy(ctx);
    const counts = await storeRows(
      ctx,
      LEGACY_PROJECT,
      { usage: args.usage, providers: args.providers, applied: args.applied },
      now,
    );
    await ctx.db.patch(project._id, { lastUsageAt: now });

    await ctx.db.insert("syncRuns", {
      source: args.source,
      batchId: args.batchId,
      observedAt: args.observedAt,
      startedAt: args.startedAt,
      finishedAt: now,
      status: "ok",
      ...counts,
    });
    await setSourceStatus(ctx, args.source, { state: "ok", at: now });
    return counts;
  },
});

// ── Reads ────────────────────────────────────────────────────────────────────

function requireDay(today: string) {
  if (!isCanonicalPeriodStart("day", today)) throw new ConvexError(NOT_A_DATE);
}

/** Whether legacy steering (the signed push to Vertical Startup) is connected, and what is missing. Never a value. */
function steering() {
  // Switched off (convex/lib/features.ts): not connected, and nothing to set.
  if (!featureOn("verticalStartupAgents")) return { connected: false, missing: [] as string[] };
  const missing = steeringMissing(process.env);
  return { connected: missing.length === 0, missing };
}

/** The pairs a model may be changed to: up, on a provider the OS knows, and allowed to this project and agent. */
function choicesOf(providers: readonly ProviderView[], policy: ProjectPolicy, phi: boolean): ModelPair[] {
  return providers
    .filter(
      (row) =>
        row.state === "up" && isKnownProvider(row.provider) && providerPolicyProblem(row.provider, policy, phi) === null,
    )
    .map((row) => ({ provider: row.provider, model: row.model }));
}

export type AgentRow = OverviewRow & {
  project: string;
  /** What it is called: its launch name here, or what its project calls it. */
  name: string | null;
  /** Whether its project says it handles patient data; null where it has not said. */
  phi: boolean | null;
  kind: AgentKind | null;
  /** Launched here and not yet reported by its project: "Waiting for the project to report it". */
  waiting: boolean;
  /** A change made here that the project has not applied yet. */
  pending: boolean;
  /** The published harness version it runs ("h7"); null: the code's own harness. */
  harnessVersion: string | null;
  /** v1.3: built here, not in its project's code ("Built here"). */
  builtHere: boolean;
  /** Built here and never published: a draft, not in its project's config yet. */
  draftOnly: boolean;
  /** Startup OS's agents: where it runs (one of the four by the owner's choice; any other in Startup OS). Null for a project's. */
  runsOn: RunsOn | null;
  /** One of Startup OS's own four (convex/lib/osAgents.ts): the owner's alone. */
  osAgent: boolean;
};

/**
 * The config version a project has applied. Startup OS is its own project and
 * reads its controls as they are saved, so every change of its is applied:
 * nothing of it waits on a project to poll (it read "Pending" for ever).
 */
async function appliedOf(ctx: QueryCtx, slug: string): Promise<number | null> {
  if (slug === INTERNAL_PROJECT) return Number.MAX_SAFE_INTEGER;
  return (await configRow(ctx, slug))?.appliedVersion ?? null;
}

/** One project's rows for the day asked. */
function rowsOf(
  project: string,
  usage: readonly UsageDay[],
  controls: readonly Doc<"agentControls">[],
  catalog: readonly CatalogEntry[],
  applied: number | null,
  today: string,
  built: ReadonlySet<string> = new Set(),
): AgentRow[] {
  const byId = new Map(catalog.map((entry) => [entry.agentId, entry]));
  return overviewOf(usage, controls.map(asControl), today, [...built]).map((row) => {
    const control = controls.find((c) => c.agentId === row.agentId);
    const entry = byId.get(row.agentId);
    const builtHere = built.has(row.agentId);
    return {
      ...row,
      project,
      name: control?.name ?? entry?.name ?? null,
      phi: entry?.phi ?? null,
      kind: entry?.kind ?? (builtHere ? "declarative" : null),
      // An agent built here is not waiting on its project's code: the package runs it from its definition.
      waiting: !builtHere && entry === undefined && !usage.some((day) => day.agentId === row.agentId),
      pending: row.version !== null && (applied === null || applied < row.version),
      harnessVersion: control?.harnessVersion ?? null,
      builtHere,
      draftOnly: builtHere && control === undefined,
      runsOn: runsOnOf(project, row.agentId, control?.runsOn),
      osAgent: isOsAgent(project, row.agentId),
    };
  });
}

/** One of the four's row with its switch as `agentSettings` has it: that row is the switch. */
const withSwitch = (row: AgentRow, off: readonly string[]): AgentRow =>
  row.osAgent && row.enabled !== null ? { ...row, enabled: !off.includes(row.agentId) } : row;

/**
 * Refuse anyone but the owner for one of Startup OS's own four agents, in the
 * words of a missing permission: they are the owner's, as their card is.
 */
export function requireOsAgentOwner(member: Member, project: string, agentId: string) {
  if (isOsAgent(project, agentId) && !isOwner(member)) throw new ConvexError(NOT_ALLOWED);
}

/** The projects a read covers: one, or every one that has a row or data. */
async function projectsIn(ctx: QueryCtx, project: string | undefined): Promise<string[]> {
  // Startup OS's own project lists only the agents built to run in it (v1.3).
  if (project !== undefined) return [project];
  const slugs = new Set((await ctx.db.query("agentProjects").collect()).map((row) => row.slug));
  if ((await declaredIn(ctx, INTERNAL_PROJECT)).length > 0) slugs.add(INTERNAL_PROJECT);
  // The legacy project's rows may arrive before its row does (a deploy, then no push yet).
  if (featureOn("verticalStartupAgents") && !slugs.has(LEGACY_PROJECT) && (await hasUsage(ctx, LEGACY_PROJECT))) {
    slugs.add(LEGACY_PROJECT);
  }
  return [...slugs].sort();
}

/**
 * Every agent's row for the day asked, in one project or (none given) every
 * one, the providers, and whether legacy steering is connected. What the page
 * shows and what the owner's `agents` tool is told: one function.
 */
export async function agentsFor(ctx: QueryCtx, today: string, project?: string) {
  requireDay(today);
  const from = addDays(today, -READ_DAYS);
  const slugs = await projectsIn(ctx, project);
  const all = project === undefined ? await allUsageSince(ctx, from) : null;
  const agents: AgentRow[] = [];
  for (const slug of slugs) {
    const usage = all !== null ? (all.get(slug) ?? []) : await usageSince(ctx, slug, from);
    const applied = await appliedOf(ctx, slug);
    const built = new Set((await declaredIn(ctx, slug)).map((row) => row.agentId));
    const off = slug === INTERNAL_PROJECT ? await agentsOff(ctx) : [];
    agents.push(
      ...rowsOf(slug, usage, await controlsOf(ctx, slug), await catalogOf(ctx, slug), applied, today, built).map((row) =>
        withSwitch(row, off),
      ),
    );
  }
  const providers =
    project === undefined ? await providersOf(ctx) : slugs.length === 0 ? [] : await providersOf(ctx, project);
  let pushed = agents.length > 0 || providers.length > 0;
  for (const slug of slugs) {
    if (pushed) break;
    pushed = (await hasUsage(ctx, slug)) || ((await configRow(ctx, slug))?.appliedVersion ?? null) !== null;
  }
  return {
    agents,
    providers,
    steering: steering(),
    /** Whether anything was ever reported in the projects read. */
    pushed,
  };
}

export const overview = memberQuery("agents")({
  args: { today: v.string(), project: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const read = await agentsFor(ctx, args.today, args.project);
    // Startup OS's own four are the owner's, as their card is.
    return isOwner(ctx.member) ? read : { ...read, agents: read.agents.filter((row) => !row.osAgent) };
  },
});

export const providers = memberQuery("agents")({
  args: { project: v.optional(v.string()) },
  handler: async (ctx, args) => providersOf(ctx, args.project),
});

/** Who made a change, as this caller may be told: "You", a name, or "A teammate". */
export async function whoOf(ctx: QueryCtx, member: Member, by: Id<"users">, cache: Map<string, string>) {
  if (by === member.user._id) return "You";
  const hit = cache.get(by);
  if (hit !== undefined) return hit;
  const user = await ctx.db.get(by);
  const email = user?.email?.toLowerCase();
  const person = email === undefined ? undefined : (await teamDirectory(ctx.db)).get(email);
  const words = person !== undefined && knows(member, person) && user?.name ? user.name : "A teammate";
  cache.set(by, words);
  return words;
}

export type Desired = Doc<"agentControlChanges">["after"];

const newestFirst = (a: Doc<"agentControlChanges">, b: Doc<"agentControlChanges">) => b.at - a.at;

async function changeRows(ctx: QueryCtx, project?: string, agentId?: string) {
  if (project === undefined) {
    return await ctx.db.query("agentControlChanges").withIndex("by_at").order("desc").take(CHANGES_SHOWN);
  }
  const rows: Doc<"agentControlChanges">[] = [];
  for (const slug of slugsOf(project)) {
    rows.push(
      ...(agentId === undefined
        ? await ctx.db
            .query("agentControlChanges")
            .withIndex("by_project_and_at", (q) => q.eq("project", slug))
            .order("desc")
            .take(CHANGES_SHOWN)
        : await ctx.db
            .query("agentControlChanges")
            .withIndex("by_project_agentId_and_at", (q) => q.eq("project", slug).eq("agentId", agentId))
            .order("desc")
            .take(CHANGES_SHOWN)),
    );
  }
  return rows.sort(newestFirst).slice(0, CHANGES_SHOWN);
}

async function changesFor(ctx: QueryCtx, member: Member, project?: string, agentId?: string) {
  // Startup OS's own four are the owner's: nobody else is told of their changes.
  const rows = (await changeRows(ctx, project, agentId)).filter(
    (row) => isOwner(member) || !isOsAgent(projectOf(row), row.agentId),
  );
  const applied = new Map<string, number | null>();
  const cache = new Map<string, string>();
  const out = [];
  for (const row of rows) {
    const slug = projectOf(row);
    if (!applied.has(slug)) applied.set(slug, await appliedOf(ctx, slug));
    out.push({
      id: row._id,
      project: slug,
      version: row.version,
      agentId: row.agentId,
      at: row.at,
      by: await whoOf(ctx, member, row.by, cache),
      before: row.before as Desired | null,
      after: row.after,
      launched: row.launched === true,
      push: row.push,
      pushedAt: row.pushedAt ?? null,
      failure: row.failure ?? null,
      status: changeStatus(row, applied.get(slug)!),
    });
  }
  return out;
}

/** The latest changes: one project's (one agent's, with `agentId`), or every project's with neither. */
export const changes = memberQuery("agents")({
  args: { project: v.optional(v.string()), agentId: v.optional(v.string()) },
  handler: async (ctx, args) =>
    changesFor(ctx, ctx.member, args.project ?? (args.agentId === undefined ? undefined : LEGACY_PROJECT), args.agentId),
});

/**
 * One agent in its project: its thirty days, the models it ran on, its
 * desired state, the model it is on now, what it may be moved to, and its
 * changes. Null for an agent the project has never reported or launched.
 */
export const agent = memberQuery("agents")({
  args: { agentId: v.string(), today: v.string(), project: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireDay(args.today);
    const project = args.project ?? LEGACY_PROJECT;
    requireOsAgentOwner(ctx.member, project, args.agentId);
    const builtHere = (await declaredOf(ctx, project, args.agentId)) !== null;
    const policy = builtHere ? await builderPolicyOf(ctx, project) : await policyOf(ctx, project);
    if (policy === null) return null;
    const control = await controlOf(ctx, project, args.agentId);
    const seen = await lastSeen(ctx, project, args.agentId);
    if (control === null && seen === null && !builtHere) return null;
    const usage = (await usageSince(ctx, project, addDays(args.today, -READ_DAYS))).filter(
      (row) => row.agentId === args.agentId,
    );
    const entry = (await catalogOf(ctx, project)).find((row) => row.agentId === args.agentId) ?? null;
    const phi = await agentPhi(ctx, project, args.agentId, control?.harnessVersion);
    return {
      project,
      projectName: policy.name,
      holdsPatientData: policy.holdsPatientData,
      allowedProviders: policy.allowedProviders,
      agentId: args.agentId,
      name: control?.name ?? entry?.name ?? null,
      phi: entry?.phi ?? null,
      kind: entry?.kind ?? (builtHere ? ("declarative" as const) : null),
      waiting: !builtHere && entry === null && seen === null,
      /** v1.3: built here. Its model is its definition's; `current` is null until it is published or has run. */
      builtHere,
      series: seriesOf(usage, args.agentId, args.today),
      models: modelsOf(usage, args.agentId, args.today),
      desired: control === null ? null : asControl(control),
      current:
        control !== null
          ? { provider: control.provider, model: control.model }
          : seen !== null
            ? { provider: seen.provider, model: seen.model }
            : null,
      promptVersion: seen?.promptVersion ?? null,
      /** Startup OS's agents: where it runs; one of the four by the owner's choice. Null for a project's. */
      runsOn: runsOnOf(project, args.agentId, control?.runsOn),
      /** One of Startup OS's own four: where it runs is the owner's to choose. */
      osAgent: isOsAgent(project, args.agentId),
      choices: choicesOf(await providersOf(ctx, project), policy, phi),
      changes: await changesFor(ctx, ctx.member, project, args.agentId),
    };
  },
});

// ── Steering ─────────────────────────────────────────────────────────────────

export const desiredOf = (c: Control): Desired => ({
  enabled: c.enabled,
  provider: c.provider,
  model: c.model,
  ...(c.fallbackProvider !== null && c.fallbackModel !== null
    ? { fallbackProvider: c.fallbackProvider, fallbackModel: c.fallbackModel }
    : {}),
  ...(c.monthlyBudgetUsd !== null ? { monthlyBudgetUsd: c.monthlyBudgetUsd } : {}),
  ...(c.promptVersionPin != null ? { promptVersionPin: c.promptVersionPin } : {}),
  ...(c.harnessVersion != null ? { harnessVersion: c.harnessVersion } : {}),
  ...(c.runsOn != null ? { runsOn: c.runsOn } : {}),
});

const sameDesired = (a: Desired, b: Desired) =>
  a.enabled === b.enabled &&
  a.provider === b.provider &&
  a.model === b.model &&
  a.fallbackProvider === b.fallbackProvider &&
  a.fallbackModel === b.fallbackModel &&
  a.monthlyBudgetUsd === b.monthlyBudgetUsd &&
  a.promptVersionPin === b.promptVersionPin &&
  a.harnessVersion === b.harnessVersion &&
  a.runsOn === b.runsOn;

/**
 * The version a new config goes out as: above every version made here,
 * applied there, or held there when Vertical Startup last called ours stale.
 */
const nextVersion = (config: Doc<"agentConfig"> | null) =>
  Math.max(config?.latestVersion ?? 0, config?.appliedVersion ?? 0, config?.remoteVersion ?? 0) + 1;

/**
 * How a change reaches its project. Every project fetches its config
 * (`pull`). Vertical Startup is also pushed it, the legacy way, while legacy
 * steering is connected or it has no token to fetch with (then the push
 * records "not connected", as it always did).
 */
async function deliveryOf(ctx: QueryCtx, project: string): Promise<"queued" | "pull"> {
  if (project !== LEGACY_PROJECT || !featureOn("verticalStartupAgents")) return "pull";
  if (steering().connected) return "queued";
  const row = await projectRow(ctx, project);
  return row?.tokenHash !== undefined && row.status === "active" ? "pull" : "queued";
}

/** A pair, and its fallback, held to the project's providers: up, known and allowed, or what it has. */
export function pairProblems(
  next: Control,
  current: Control | null,
  providers: readonly ProviderView[],
  policy: ProjectPolicy,
  phi: boolean,
): string | null {
  const check = (pair: ModelPair, had: ModelPair | null) => {
    const same = had !== null && had.provider === pair.provider && had.model === pair.model;
    if (same) return null;
    return choiceProblem(pair, providers, had) ?? providerPolicyProblem(pair.provider, policy, phi);
  };
  const primary = check(next, current);
  if (primary !== null) return primary;
  if (next.fallbackProvider !== null && next.fallbackModel !== null) {
    const had =
      current !== null && current.fallbackProvider !== null && current.fallbackModel !== null
        ? { provider: current.fallbackProvider, model: current.fallbackModel }
        : null;
    const problem = check({ provider: next.fallbackProvider, model: next.fallbackModel }, had);
    if (problem !== null) return problem;
  }
  return desiredProblem(next);
}

/**
 * Write a new desired state as a new version of its project's config: the
 * control, the change (who, when, before and after) and how it goes out.
 */
export async function commit(
  ctx: MutationCtx,
  member: Member,
  project: string,
  stored: Doc<"agentControls"> | null,
  before: Desired | null,
  next: Control,
  launched: boolean,
) {
  const now = Date.now();
  const config = await configRow(ctx, project);
  const version = nextVersion(config);
  if (config === null) await ctx.db.insert("agentConfig", { project, latestVersion: version });
  else await ctx.db.patch(config._id, { project, latestVersion: version });

  const row = {
    project,
    agentId: next.agentId,
    ...(next.name != null ? { name: next.name } : {}),
    enabled: next.enabled,
    provider: next.provider,
    model: next.model,
    fallbackProvider: next.fallbackProvider ?? undefined,
    fallbackModel: next.fallbackModel ?? undefined,
    monthlyBudgetUsd: next.monthlyBudgetUsd ?? undefined,
    promptVersionPin: next.promptVersionPin ?? undefined,
    harnessVersion: next.harnessVersion ?? undefined,
    runsOn: next.runsOn ?? undefined,
    version,
    updatedAt: now,
    updatedBy: member.user._id,
  };
  if (stored === null) await ctx.db.insert("agentControls", row);
  else await ctx.db.replace(stored._id, row);

  const push = await deliveryOf(ctx, project);
  await ctx.db.insert("agentControlChanges", {
    project,
    version,
    agentId: next.agentId,
    by: member.user._id,
    at: now,
    before,
    after: desiredOf(next),
    ...(launched ? { launched: true } : {}),
    push,
  });
  if (push === "queued") await ctx.scheduler.runAfter(0, internal.agentPush.push, {});
  return version;
}

/** A project that may be steered from here, or a refusal in fixed words. */
export async function steerable(ctx: QueryCtx, project: string): Promise<ProjectPolicy> {
  if (project === INTERNAL_PROJECT) throw new ConvexError(PROJECT_WORDS.internal);
  const policy = await policyOf(ctx, project);
  if (policy === null) throw new ConvexError(PROJECT_WORDS.noSuch);
  return policy;
}

const fallbackArg = v.optional(v.union(v.object({ provider: v.string(), model: v.string() }), v.null()));

function requirePin(pin: string | null | undefined) {
  if (pin != null && !PROMPT_VERSION_PATTERN.test(pin)) throw new ConvexError(LAUNCH_WORDS.promptVersion);
}

/** What `change` takes: only what is given changes. */
export type AgentChange = {
  project?: string;
  agentId: string;
  enabled?: boolean;
  provider?: string;
  model?: string;
  fallback?: { provider: string; model: string } | null;
  monthlyBudgetUsd?: number | null;
  promptVersionPin?: string | null;
  runsOn?: Doc<"agentControls">["runsOn"];
};

/**
 * Change one agent's desired state: what `change` runs, and what the
 * Assistant's switch for one of the four runs (`assistant.setAgent`), so every
 * flip is a new version with its change row (who, when, before and after).
 */
export async function changeAgent(ctx: MutationCtx, member: Member, args: AgentChange) {
  const project = args.project ?? LEGACY_PROJECT;
  const os = isOsAgent(project, args.agentId);
  // The four are the owner's: only the owner throws their switch, or moves them.
  requireOsAgentOwner(member, project, args.agentId);
  if (args.runsOn !== undefined && !os) throw new ConvexError(OS_AGENT_WORDS.notOsAgent);
  // To the Mac only with no tool that would change something at once there (nothing on the Mac waits for an approval).
  if (args.runsOn === "claude_mac" && ((await publishedVersionOf(ctx, project, args.agentId))?.tools ?? []).some(macActForbidden)) {
    throw new ConvexError(OS_AGENT_WORDS.macActTool);
  }
  const builtHere = (await declaredOf(ctx, project, args.agentId)) !== null;
  // An agent built to run in Startup OS is steered like a project's; nothing else of Startup OS's is.
  const policy = builtHere && project === INTERNAL_PROJECT ? (await builderPolicyOf(ctx, project))! : await steerable(ctx, project);
  if (builtHere && (args.provider !== undefined || args.model !== undefined || args.fallback !== undefined)) {
    throw new ConvexError(BUILT_MODEL);
  }
  const stored = await controlOf(ctx, project, args.agentId);
  const seen = stored === null ? await lastSeen(ctx, project, args.agentId) : null;
  if (stored === null && seen === null) throw new ConvexError(NO_SUCH_AGENT);
  if ((args.provider === undefined) !== (args.model === undefined)) throw new ConvexError(PAIR_TOGETHER);
  requirePin(args.promptVersionPin);

  const current: Control =
    stored !== null
      ? asControl(stored)
      : {
          agentId: args.agentId,
          enabled: true,
          provider: seen!.provider,
          model: seen!.model,
          fallbackProvider: null,
          fallbackModel: null,
          monthlyBudgetUsd: null,
          promptVersionPin: null,
          version: 0,
        };
  if (os) {
    // The switch is agentSettings'; where it runs is its control's, the Mac when none is kept.
    current.enabled = !(await agentsOff(ctx)).includes(args.agentId as AgentId);
    current.runsOn = runsOnOf(project, args.agentId, current.runsOn);
  }
  const next: Control = {
    ...current,
    ...(args.runsOn === undefined ? {} : { runsOn: args.runsOn }),
    ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
    ...(args.provider === undefined || args.model === undefined
      ? {}
      : { provider: args.provider, model: args.model }),
    ...(args.fallback === undefined
      ? {}
      : {
          fallbackProvider: args.fallback?.provider ?? null,
          fallbackModel: args.fallback?.model ?? null,
        }),
    ...(args.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: args.monthlyBudgetUsd }),
    ...(args.promptVersionPin === undefined ? {} : { promptVersionPin: args.promptVersionPin }),
  };

  const phi = await agentPhi(ctx, project, args.agentId, stored?.harnessVersion);
  const problem = pairProblems(next, current, await providersOf(ctx, project), policy, phi);
  if (problem !== null) throw new ConvexError(problem);

  const before = desiredOf(current);
  const after = desiredOf(next);
  // Nothing differs from what it has (or, never steered, from what it runs).
  if (sameDesired(before, after)) return { changed: false as const };

  // One of the four: its switch is agentSettings, thrown here as on the Assistant page.
  if (os && before.enabled !== after.enabled) await switchAgent(ctx, args.agentId as AgentId, after.enabled, Date.now());
  const version = await commit(ctx, member, project, stored, stored === null ? null : before, next, false);
  return { changed: true as const, version };
}

/**
 * Change one agent's desired state in its project: its switch, its model,
 * its fallback, its budget or its pinned prompt version. Only what is given
 * changes. A model must be one the project last saw up, on a provider the OS
 * knows and the project may use (for patient data, where it holds it), or
 * the one it has. The change is a new version of the project's config: the
 * project fetches it, and Vertical Startup is also pushed it the legacy way. It is
 * pending until the project says it applied that version or a later one.
 */
export const change = memberMutation("agents")({
  args: {
    project: v.optional(v.string()),
    agentId: v.string(),
    enabled: v.optional(v.boolean()),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    /** null: no fallback. */
    fallback: fallbackArg,
    /** null: no budget. */
    monthlyBudgetUsd: v.optional(v.union(v.number(), v.null())),
    /** null: no pin. */
    promptVersionPin: v.optional(v.union(v.string(), v.null())),
    /** One of Startup OS's own four: where it runs, the Mac or Startup OS (the owner's). */
    runsOn: v.optional(runsOnValidator),
  },
  handler: (ctx, args) => changeAgent(ctx, ctx.member, args),
});

/**
 * Launch an agent in a project: one from the project's catalogue (what it
 * says it can run), or an id its code will report, which waits until it
 * does. Named, on a model the project last saw up on a provider it may use,
 * with a fallback, a budget and its switch. A new version of the project's
 * config, pending until the project applies it.
 */
export const launch = memberMutation("agents")({
  args: {
    project: v.string(),
    agentId: v.string(),
    name: v.optional(v.string()),
    enabled: v.boolean(),
    provider: v.string(),
    model: v.string(),
    fallback: fallbackArg,
    monthlyBudgetUsd: v.optional(v.union(v.number(), v.null())),
    promptVersionPin: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const policy = await steerable(ctx, args.project);
    if (!AGENT_ID_PATTERN.test(args.agentId)) throw new ConvexError(LAUNCH_WORDS.agentId);
    const name = args.name?.trim() ?? "";
    if (name !== "" && !AGENT_NAME_PATTERN.test(name)) throw new ConvexError(LAUNCH_WORDS.name);
    requirePin(args.promptVersionPin);
    if ((await controlOf(ctx, args.project, args.agentId)) !== null) throw new ConvexError(LAUNCH_WORDS.launched);
    if ((await declaredOf(ctx, args.project, args.agentId)) !== null) throw new ConvexError(BUILT_LAUNCH);
    if ((await controlsOf(ctx, args.project)).length >= MAX_AGENTS_PER_PROJECT) {
      throw new ConvexError(LAUNCH_WORDS.launched);
    }

    const next: Control = {
      agentId: args.agentId,
      name: name === "" ? null : name,
      enabled: args.enabled,
      provider: args.provider,
      model: args.model,
      fallbackProvider: args.fallback?.provider ?? null,
      fallbackModel: args.fallback?.model ?? null,
      monthlyBudgetUsd: args.monthlyBudgetUsd ?? null,
      promptVersionPin: args.promptVersionPin ?? null,
      version: 0,
    };
    const phi = await agentPhi(ctx, args.project, args.agentId, null);
    const problem = pairProblems(next, null, await providersOf(ctx, args.project), policy, phi);
    if (problem !== null) throw new ConvexError(problem);

    const version = await commit(ctx, ctx.member, args.project, null, null, next, true);
    return { version };
  },
});

// ── The legacy push (Vertical Startup, until it moves to the package) ─────────────

/** Changes to Vertical Startup not yet sent (queued, failed, not connected) that are not applied. */
async function unsent(ctx: QueryCtx, applied: number | null) {
  const rows = [];
  for (const slug of slugsOf(LEGACY_PROJECT)) {
    for (const push of ["queued", "failed", "not_connected"] as const) {
      rows.push(
        ...(await ctx.db
          .query("agentControlChanges")
          .withIndex("by_project_push_and_version", (q) => q.eq("project", slug).eq("push", push))
          .collect()),
      );
    }
  }
  return rows.filter((row) => changeStatus(row, applied) !== "applied");
}

/**
 * Send Vertical Startup's latest config again, when a change made here was not
 * sent or not taken. Where Vertical Startup last said it holds a newer version,
 * the waiting changes go out again in a new version above it.
 */
export const resend = memberMutation("agents")({
  args: {},
  handler: async (ctx) => {
    requireFeature("verticalStartupAgents");
    const config = await configRow(ctx, LEGACY_PROJECT);
    if (config === null || config.latestVersion === 0) return { queued: false };
    const waiting = await unsent(ctx, config.appliedVersion ?? null);
    if (waiting.length === 0) return { queued: false };
    const behind = (config.remoteVersion ?? 0) >= config.latestVersion;
    const version = behind ? nextVersion(config) : config.latestVersion;
    for (const row of waiting) {
      // A change keeps its version unless it must go out in a new one.
      await ctx.db.patch(row._id, {
        ...(behind ? { version } : {}),
        push: "queued",
        failure: undefined,
        pushedAt: undefined,
      });
      if (!behind) continue;
      const control = await controlOf(ctx, LEGACY_PROJECT, row.agentId);
      if (control !== null) await ctx.db.patch(control._id, { version });
    }
    if (behind) await ctx.db.patch(config._id, { latestVersion: version });
    await ctx.scheduler.runAfter(0, internal.agentPush.push, {});
    return { queued: true };
  },
});

/** What the legacy push sends: Vertical Startup's latest version and every agent steered there. Null with none. */
export const pushState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const config = await configRow(ctx, LEGACY_PROJECT);
    const steered = (await controlsOf(ctx, LEGACY_PROJECT)).map(asControl);
    if (config === null || config.latestVersion === 0 || steered.length === 0) return null;
    return configBody(config.latestVersion, steered);
  },
});

/**
 * How a push of `version` went, on every change to Vertical Startup it carried
 * that is not yet applied. A change already sent keeps "sent". An applied
 * version in the answer moves the applied version forward, never back. A
 * stale answer keeps the version Vertical Startup holds, so the next one goes out
 * above it.
 */
export const recordPush = internalMutation({
  args: {
    version: v.number(),
    outcome: pushOutcomeValidator,
    failure: v.optional(pushFailureValidator),
    appliedVersion: v.optional(v.number()),
    remoteVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const config = await configRow(ctx, LEGACY_PROJECT);
    const applied = config?.appliedVersion ?? 0;
    for (const slug of slugsOf(LEGACY_PROJECT)) {
      const carried = await ctx.db
        .query("agentControlChanges")
        .withIndex("by_project_and_version", (q) =>
          q.eq("project", slug).gt("version", applied).lte("version", args.version),
        )
        .collect();
      for (const row of carried) {
        // Sent already, or fetched by the project itself: the push says nothing of it.
        if (row.push === "sent" || row.push === "pull") continue;
        await ctx.db.patch(row._id, {
          push: args.outcome,
          pushedAt: now,
          failure: args.outcome === "sent" ? undefined : args.failure,
        });
      }
    }
    if (config === null) return;
    if (args.appliedVersion !== undefined && args.appliedVersion > applied) {
      await ctx.db.patch(config._id, { appliedVersion: args.appliedVersion, appliedAt: now });
    }
    if (args.remoteVersion !== undefined && args.remoteVersion > (config.remoteVersion ?? 0)) {
      await ctx.db.patch(config._id, { remoteVersion: args.remoteVersion });
    }
  },
});
