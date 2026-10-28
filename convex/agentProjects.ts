import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { usageValidators } from "./agentControl";
import { READ_DAYS, addDays, costOf, isKnownProvider, type Cost } from "./lib/agentControl";
import {
  RUN_RETENTION_DAYS,
  definitionOut,
  pendingApprovalsOf,
  retainedRun,
  type ConfigDefinition,
} from "./lib/agentBuilder";
import { configHarnessOf, versionNumberOf, type ConfigHarness } from "./lib/agentHarness";
import {
  adoptLegacy,
  asControl,
  catalogOf,
  configRow,
  controlsOf,
  declaredIn,
  ensureLegacyProject,
  harnessDefaultsOf,
  harnessVersionOf,
  hasUsage,
  LEGACY_DEFAULTS,
  partsOf,
  projectRow,
  providersOf,
  storeHarnessDefaults,
  storeRows,
  usageSince,
} from "./lib/agentData";
import {
  AGENT_KINDS,
  INTERNAL_PROJECT,
  INTERNAL_PROJECT_NAME,
  INTERNAL_PROJECT_NOTE,
  LEGACY_PROJECT,
  MAX_PROJECT_CALLS_PER_WINDOW,
  PROJECT_NAME_PATTERN,
  PROJECT_SLUG_PATTERN,
  PROJECT_WORDS,
  REGIONS,
  allowedProvidersProblem,
  failModeOf,
  projectConfigBody,
  providerPolicyProblem,
  type ProjectConfig,
} from "./lib/agentProjects";
import { nextWindow } from "./lib/agentRules";
import { AGENT_IDS, AGENT_LINES, AGENT_NAMES } from "./lib/agents";
import { agentsOff } from "./lib/agentStore";
import { featureOn } from "./lib/featureGates";
import { runsOnOf } from "./lib/osAgents";
import { memberMutation, memberQuery, ownerQuery } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { hashToken } from "./lib/personalRules";
import { mintProjectToken, projectHolding } from "./lib/projectToken";
import { harnessDefaultsValidator } from "./schema";

// The projects whose agents Startup OS steers (convex/lib/agentProjects.ts):
// connecting one (its token, shown once), rotating and taking away its token,
// the cards on /agents, Startup OS's own agents, and the internal half of
// Protocol v1 (convex/agentsApi.ts, docs/agents-protocol.md).
//
// The `agents` area's, not split by company, like the agents themselves.
// Startup OS's own agents are the owner's (the Assistant's): their card is
// read by the owner alone. A token is returned once, by `connect` and
// `rotateToken`, and never again: only its SHA-256 is stored, and nothing
// here logs.

const regionValidator = v.union(...REGIONS.map((region) => v.literal(region)));

const NOT_A_DATE = "today is not a date";

function requireDay(today: string) {
  if (!isCanonicalPeriodStart("day", today)) throw new ConvexError(NOT_A_DATE);
}

/** A project as its card shows it. Never its token's hash. */
async function cardOf(ctx: QueryCtx, row: Doc<"agentProjects"> | null, slug: string, today: string) {
  const policy =
    row === null
      ? LEGACY_DEFAULTS
      : {
          slug: row.slug,
          name: row.name,
          region: row.region,
          holdsPatientData: row.holdsPatientData,
          allowedProviders: row.allowedProviders,
        };
  const usage = await usageSince(ctx, slug, addDays(today, -READ_DAYS));
  const controls = await controlsOf(ctx, slug);
  const catalog = await catalogOf(ctx, slug);
  const config = await configRow(ctx, slug);
  const day = usage.filter((u) => u.day === today);
  const ids = new Set([...usage.map((u) => u.agentId), ...controls.map((c) => c.agentId), ...catalog.map((c) => c.agentId)]);
  const costToday: Cost = costOf(day);
  return {
    ...policy,
    status: row?.status ?? ("active" as const),
    /** A token is issued and the project is active: it may call. */
    connected: row?.tokenHash !== undefined && row.status === "active",
    // Its older way in, only while that is switched on (convex/lib/features.ts).
    legacy: slug === LEGACY_PROJECT && featureOn("verticalStartupAgents"),
    tokenCreatedAt: row?.tokenCreatedAt ?? null,
    lastSeenAt: row?.lastSeenAt ?? null,
    lastUsageAt: row?.lastUsageAt ?? null,
    createdAt: row?.createdAt ?? null,
    failMode: failModeOf(policy.holdsPatientData),
    agentsCount: ids.size,
    knownCount: catalog.length,
    callsToday: day.length === 0 ? null : day.reduce((sum, u) => sum + u.calls, 0),
    /** null: nothing reported today, never 0. */
    errorsToday: day.length === 0 ? null : day.reduce((sum, u) => sum + u.errors, 0),
    costToday,
    latestVersion: config?.latestVersion ?? 0,
    appliedVersion: config?.appliedVersion ?? null,
    /** It says it runs an agent that handles patient data, and it is not marked as holding any. */
    phiMismatch: !policy.holdsPatientData && catalog.some((entry) => entry.phi),
  };
}

/** Every project connected (and Vertical Startup's, once it has reported), with today's figures. */
export const list = memberQuery("agents")({
  args: { today: v.string() },
  handler: async (ctx, args) => {
    requireDay(args.today);
    const rows = await ctx.db.query("agentProjects").collect();
    const cards = [];
    for (const row of rows) cards.push(await cardOf(ctx, row, row.slug, args.today));
    // Vertical Startup's before it connects: only while its older way in is switched on.
    if (featureOn("verticalStartupAgents") && !rows.some((row) => row.slug === LEGACY_PROJECT) && (await hasUsage(ctx, LEGACY_PROJECT))) {
      cards.push(await cardOf(ctx, null, LEGACY_PROJECT, args.today));
    }
    return cards.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * What "Launch agent" may offer in a project: the agents it says it can
 * run (and whether each is launched), and the models it last saw up on a
 * provider it may use, each with whether it is for patient data.
 */
export const launchOptions = memberQuery("agents")({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    if (args.project === INTERNAL_PROJECT) return null;
    const row = await projectRow(ctx, args.project);
    if (row === null && args.project !== LEGACY_PROJECT) return null;
    const policy = row ?? LEGACY_DEFAULTS;
    const launched = new Set((await controlsOf(ctx, args.project)).map((c) => c.agentId));
    // v1.3: an agent built here is in the catalogue once its project runs it, and is published, not launched.
    const built = new Set((await declaredIn(ctx, args.project)).map((row) => row.agentId));
    const pairs = (await providersOf(ctx, args.project))
      .filter(
        (p) => p.state === "up" && isKnownProvider(p.provider) && providerPolicyProblem(p.provider, policy, false) === null,
      )
      .map((p) => ({
        provider: p.provider,
        model: p.model,
        patientData: providerPolicyProblem(p.provider, policy, true) === null,
      }));
    return {
      holdsPatientData: policy.holdsPatientData,
      allowedProviders: policy.allowedProviders,
      catalog: (await catalogOf(ctx, args.project)).filter((entry) => !built.has(entry.agentId)).map((entry) => ({
        ...entry,
        launched: launched.has(entry.agentId),
      })),
      pairs,
    };
  },
});

function requireProjectFields(args: {
  name: string;
  slug: string;
  holdsPatientData: boolean;
  allowedProviders: string[];
}) {
  if (!PROJECT_SLUG_PATTERN.test(args.slug)) throw new ConvexError(PROJECT_WORDS.slug);
  if (args.slug === INTERNAL_PROJECT) throw new ConvexError(PROJECT_WORDS.reserved);
  if (!PROJECT_NAME_PATTERN.test(args.name.trim())) throw new ConvexError(PROJECT_WORDS.name);
  const problem = allowedProvidersProblem(args.allowedProviders, args.holdsPatientData);
  if (problem !== null) throw new ConvexError(problem);
}

/**
 * Connect a project: its name, id, region, whether it holds patient data
 * (which fixes its fail mode and that it may use providers for patient data
 * only) and the providers it may use. Returns its token, the one time it can
 * be read; only the token's SHA-256 is stored.
 */
export const connect = memberMutation("agents")({
  args: {
    name: v.string(),
    slug: v.string(),
    region: regionValidator,
    holdsPatientData: v.boolean(),
    allowedProviders: v.array(v.string()),
    entropy: v.string(),
  },
  handler: async (ctx, args) => {
    requireProjectFields(args);
    if ((await projectRow(ctx, args.slug)) !== null) throw new ConvexError(PROJECT_WORDS.taken);
    const token = await mintProjectToken(args.entropy);
    if (token === null) throw new ConvexError(PROJECT_WORDS.tokenNotMade);
    const now = Date.now();
    await ctx.db.insert("agentProjects", {
      slug: args.slug,
      name: args.name.trim(),
      region: args.region,
      holdsPatientData: args.holdsPatientData,
      allowedProviders: [...args.allowedProviders],
      status: "active",
      tokenHash: await hashToken(token),
      tokenCreatedAt: now,
      createdAt: now,
      createdBy: ctx.member.user._id,
    });
    return { slug: args.slug, token };
  },
});

async function connectable(ctx: QueryCtx, slug: string) {
  if (slug === INTERNAL_PROJECT) throw new ConvexError(PROJECT_WORDS.internal);
  const row = await projectRow(ctx, slug);
  if (row === null) throw new ConvexError(PROJECT_WORDS.noSuch);
  return row;
}

/**
 * Issue a new token for a project, replacing any it had (the old one stops
 * working in this transaction), and return it once. A disconnected project
 * is connected again by this; Vertical Startup's first token is issued by it.
 */
export const rotateToken = memberMutation("agents")({
  args: { slug: v.string(), entropy: v.string() },
  handler: async (ctx, args) => {
    const row = await connectable(ctx, args.slug);
    const token = await mintProjectToken(args.entropy);
    if (token === null) throw new ConvexError(PROJECT_WORDS.tokenNotMade);
    await ctx.db.patch(row._id, {
      tokenHash: await hashToken(token),
      tokenCreatedAt: Date.now(),
      status: "active",
      windowStart: undefined,
      calls: undefined,
    });
    return { slug: row.slug, token };
  },
});

/**
 * Take a project's token away: its next call is refused, one in flight
 * included. Its agents, figures and changes are kept, and a new token
 * connects it again.
 */
export const disconnect = memberMutation("agents")({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const row = await connectable(ctx, args.slug);
    await ctx.db.patch(row._id, { tokenHash: undefined, tokenCreatedAt: undefined, status: "disconnected" });
    return null;
  },
});

// ── Startup OS's own agents ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Startup OS's own four agents as a project card: each one's switch (the
 * Assistant's, `assistant.setAgent`), where it runs (the Mac through Claude,
 * or here on Gemini), and its calls in the seven days to `today` from the
 * record of what the owner's Claude called: how many, how they ended, and
 * the last. Not priced. The owner's alone, as the Assistant is.
 */
export const startupOs = ownerQuery({
  args: { today: v.string() },
  handler: async (ctx, args) => {
    requireDay(args.today);
    const from = Date.parse(`${addDays(args.today, -6)}T00:00:00Z`);
    const dayFrom = Date.parse(`${args.today}T00:00:00Z`);
    const calls = await ctx.db
      .query("agentCalls")
      .withIndex("by_at", (q) => q.gte("at", from).lt("at", dayFrom + DAY_MS))
      .collect();
    const off = await agentsOff(ctx);
    const controls = await ctx.db
      .query("agentControls")
      .withIndex("by_project_and_agentId", (q) => q.eq("project", INTERNAL_PROJECT))
      .collect();
    const today = calls.filter((call) => call.at >= dayFrom);
    return {
      slug: INTERNAL_PROJECT,
      name: INTERNAL_PROJECT_NAME,
      note: INTERNAL_PROJECT_NOTE,
      today: {
        calls: today.length,
        errors: today.filter((call) => call.outcome === "error").length,
      },
      agents: AGENT_IDS.map((id) => {
        const own = calls.filter((call) => call.agent === id);
        const count = (outcome: Doc<"agentCalls">["outcome"]) => own.filter((call) => call.outcome === outcome).length;
        return {
          id,
          name: AGENT_NAMES[id],
          line: AGENT_LINES[id],
          on: !off.includes(id),
          runsOn: runsOnOf(INTERNAL_PROJECT, id, controls.find((control) => control.agentId === id)?.runsOn)!,
          calls7d: own.length,
          outcomes: { ok: count("ok"), refused: count("refused"), invalid: count("invalid"), error: count("error") },
          lastRunAt: own.length === 0 ? null : Math.max(...own.map((call) => call.at)),
        };
      }),
      /** Calls in the seven days that named no agent. */
      unattributed7d: calls.filter((call) => call.agent === undefined).length,
    };
  },
});

// ── Protocol v1, inside (convex/agentsApi.ts) ───────────────────────────────
// The endpoint hands these the SHA-256 of the bearer token, never the token,
// and every one looks the token up again.

/**
 * Admit one call: the project whose token this is, counted against its
 * window (MAX_PROJECT_CALLS_PER_WINDOW in ten minutes, both routes), and
 * stamped as seen. `unauthorized` for a token not honoured; `limited` over
 * the window, uncounted.
 */
export const admit = internalMutation({
  args: { tokenHash: v.string(), now: v.number() },
  handler: async (ctx, { tokenHash, now }) => {
    const row = await projectHolding(ctx, tokenHash);
    if (row === null) return { status: "unauthorized" as const };
    const window = nextWindow({ windowStart: row.windowStart, count: row.calls }, now, MAX_PROJECT_CALLS_PER_WINDOW);
    if (!window.allowed) return { status: "limited" as const };
    await ctx.db.patch(row._id, { windowStart: window.windowStart, calls: window.count, lastSeenAt: now });
    return { status: "ok" as const, project: row.slug };
  },
});

/**
 * What a project is told to run, as its version and the JSON body, or null
 * for a token not honoured. JSON text, since a harness's output schema has
 * `$` keys (`$ref`), which no Convex value may carry.
 */
export const configOf = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }): Promise<{ version: number; body: string } | null> => {
    const row = await projectHolding(ctx, tokenHash);
    if (row === null) return null;
    const config = await configRow(ctx, row.slug);
    const controls = (await controlsOf(ctx, row.slug)).map(asControl);
    const names = new Map((await catalogOf(ctx, row.slug)).map((entry) => [entry.agentId, entry.name]));
    const harnesses = new Map<string, ConfigHarness>();
    const definitions = new Map<string, ConfigDefinition>();
    for (const control of controls) {
      const number = versionNumberOf(control.harnessVersion);
      if (number === null) continue;
      const version = await harnessVersionOf(ctx, row.slug, control.agentId, number);
      if (version === null) continue;
      // v1.3: an agent built here goes out whole, as its definition.
      if (version.definition !== undefined) {
        definitions.set(control.agentId, definitionOut(number, version.definition, await partsOf(ctx, version)));
        continue;
      }
      const defaults = await harnessDefaultsOf(ctx, row.slug, control.agentId);
      harnesses.set(control.agentId, configHarnessOf(number, await partsOf(ctx, version), defaults));
    }
    const body: ProjectConfig = projectConfigBody(row, config?.latestVersion ?? 0, controls, names, harnesses, definitions);
    return { version: body.version, body: JSON.stringify(body) };
  },
});

const knownRow = v.object({
  agentId: v.string(),
  name: v.string(),
  phi: v.boolean(),
  kind: v.union(...AGENT_KINDS.map((kind) => v.literal(kind))),
  /**
   * v1.1: the key of the code's harness defaults (a SHA-256 of their canonical
   * JSON). The defaults themselves, up to 512 KB each, are stored apart by
   * `storeDefaults`, one agent a call, when the key says they changed.
   */
  harnessKey: v.optional(v.string()),
});

/**
 * One usage report, already checked by the endpoint (convex/lib/agentShape.ts),
 * stored as the token's project's and nobody else's: usage, providers, the
 * applied version, and the agents it says it can run. Null for a token not
 * honoured (revoked or rotated while the report was in flight).
 */
export const report = internalMutation({
  args: {
    tokenHash: v.string(),
    usage: v.array(usageValidators.usageRow),
    providers: v.array(usageValidators.providerRow),
    agentsKnown: v.array(knownRow),
    applied: usageValidators.appliedRow,
    /** v1.3: the key of the tool catalogue sent (a SHA-256 of its canonical JSON); none: none sent. */
    toolsKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await projectHolding(ctx, args.tokenHash);
    if (row === null) return null;
    const now = Date.now();
    const counts = await storeRows(
      ctx,
      row.slug,
      { usage: args.usage, providers: args.providers, applied: args.applied },
      now,
    );
    // Harness defaults are rewritten only when they change (a report without
    // them keeps the ones stored): the agents whose key moved are named back,
    // and the endpoint stores each with `storeDefaults`.
    const harnessWanted: string[] = [];
    for (const known of args.agentsKnown) {
      const stored = await ctx.db
        .query("agentCatalog")
        .withIndex("by_project_and_agentId", (q) => q.eq("project", row.slug).eq("agentId", known.agentId))
        .unique();
      if (known.harnessKey !== undefined && stored?.harnessKey !== known.harnessKey) harnessWanted.push(known.agentId);
      const next = { name: known.name, phi: known.phi, kind: known.kind, lastReportedAt: now };
      if (stored === null) {
        await ctx.db.insert("agentCatalog", { project: row.slug, agentId: known.agentId, firstReportedAt: now, ...next });
      } else {
        await ctx.db.patch(stored._id, next);
      }
    }
    await ctx.db.patch(row._id, { lastUsageAt: now });
    const config = await configRow(ctx, row.slug);
    return {
      /** v1.3: the catalogue changed, so the endpoint stores it (`storeTools`, then `finishTools`). */
      toolsWanted: args.toolsKey !== undefined && row.toolsKey !== args.toolsKey,
      accepted: {
        agentUsage: args.usage.length,
        providers: args.providers.length,
        agentsKnown: args.agentsKnown.length,
        ...counts,
      },
      configVersion: config?.latestVersion ?? 0,
      harnessWanted,
    };
  },
});

/**
 * One agent's harness defaults, from a report `report` took: stored, and its
 * key set on the agent's catalogue row, so an unchanged one is not sent to
 * be stored again. One agent a call keeps each write small (up to 512 KB).
 * Null for a token not honoured.
 */
export const storeDefaults = internalMutation({
  args: { tokenHash: v.string(), agentId: v.string(), harness: harnessDefaultsValidator, harnessKey: v.string() },
  handler: async (ctx, args) => {
    const row = await projectHolding(ctx, args.tokenHash);
    if (row === null) return null;
    const entry = await ctx.db
      .query("agentCatalog")
      .withIndex("by_project_and_agentId", (q) => q.eq("project", row.slug).eq("agentId", args.agentId))
      .unique();
    if (entry === null) return null;
    await storeHarnessDefaults(ctx, row.slug, args.agentId, args.harness, Date.now());
    await ctx.db.patch(entry._id, { harnessKey: args.harnessKey });
    return { stored: true };
  },
});

/**
 * Stamp rows from before projects as Vertical Startup's, a batch a table, and make
 * its project row where there is legacy data and none. Run once after the
 * deploy (`npx convex run agentProjects:adoptLegacyRows`) until it returns 0;
 * each legacy push also stamps a batch.
 */
export const adoptLegacyRows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stamped = await adoptLegacy(ctx);
    if (await hasUsage(ctx, LEGACY_PROJECT)) await ensureLegacyProject(ctx, Date.now());
    return { stamped };
  },
});

// ── Protocol v1.3, inside: the tool catalogue and run summaries ─────────────

const toolArg = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
  phi: v.boolean(),
  kind: v.union(v.literal("function"), v.literal("provider")),
  /** JSON text. */
  inputSchema: v.string(),
  effect: v.union(v.literal("read"), v.literal("write")),
  approvable: v.boolean(),
});

/**
 * A slice of a project's tool catalogue, already checked by the endpoint:
 * each tool upserted by its id. `finishTools` then drops what is no longer
 * reported and records the catalogue's key. Null for a token not honoured.
 */
export const storeTools = internalMutation({
  args: { tokenHash: v.string(), tools: v.array(toolArg) },
  handler: async (ctx, args) => {
    const row = await projectHolding(ctx, args.tokenHash);
    if (row === null) return null;
    const now = Date.now();
    for (const tool of args.tools) {
      const stored = await ctx.db
        .query("agentTools")
        .withIndex("by_project_and_toolId", (q) => q.eq("project", row.slug).eq("toolId", tool.id))
        .unique();
      const next = {
        project: row.slug,
        toolId: tool.id,
        name: tool.name,
        description: tool.description,
        phi: tool.phi,
        kind: tool.kind,
        effect: tool.effect,
        approvable: tool.approvable,
        inputSchema: tool.inputSchema,
        firstReportedAt: stored?.firstReportedAt ?? now,
        lastReportedAt: now,
      };
      if (stored === null) await ctx.db.insert("agentTools", next);
      else await ctx.db.replace(stored._id, next);
    }
    return { stored: args.tools.length };
  },
});

/** The end of a catalogue's store: every tool not in it is dropped, and its key kept. */
export const finishTools = internalMutation({
  args: { tokenHash: v.string(), ids: v.array(v.string()), toolsKey: v.string() },
  handler: async (ctx, args) => {
    const row = await projectHolding(ctx, args.tokenHash);
    if (row === null) return null;
    const keep = new Set(args.ids);
    const stored = await ctx.db
      .query("agentTools")
      .withIndex("by_project_and_toolId", (q) => q.eq("project", row.slug))
      .collect();
    let dropped = 0;
    for (const tool of stored) {
      if (keep.has(tool.toolId)) continue;
      await ctx.db.delete(tool._id);
      dropped += 1;
    }
    await ctx.db.patch(row._id, { toolsKey: args.toolsKey });
    return { dropped };
  },
});

const runArg = v.object({
  runId: v.string(),
  agentId: v.string(),
  version: v.string(),
  trigger: v.union(v.literal("api"), v.literal("schedule"), v.literal("subagent"), v.literal("chat"), v.literal("test")),
  parentRunId: v.optional(v.string()),
  status: v.union(
    v.literal("ok"),
    v.literal("error"),
    v.literal("refused"),
    v.literal("awaiting_approval"),
    v.literal("denied"),
    v.literal("timeout"),
  ),
  startedAt: v.string(),
  durationMs: v.number(),
  steps: v.number(),
  costUsd: v.union(v.number(), v.null()),
  errorClass: v.union(v.string(), v.null()),
  toolCalls: v.array(
    v.object({
      toolId: v.string(),
      status: v.union(v.literal("ok"), v.literal("error"), v.literal("denied"), v.literal("skipped")),
      approval: v.optional(v.union(v.literal("approved"), v.literal("denied"), v.literal("pending"))),
    }),
  ),
});

/**
 * A slice of a report's run summaries, already checked by the endpoint:
 * each upserted by its id (a run reported again, say once its approval came,
 * replaces what was kept). One that started more than RUN_RETENTION_DAYS ago
 * is not kept. Null for a token not honoured.
 */
export const storeRuns = internalMutation({
  args: { tokenHash: v.string(), runs: v.array(runArg) },
  handler: async (ctx, args) => {
    const row = await projectHolding(ctx, args.tokenHash);
    if (row === null) return null;
    const now = Date.now();
    const counts = { inserted: 0, updated: 0, expired: 0 };
    for (const run of args.runs) {
      const startedAt = Date.parse(run.startedAt);
      if (!retainedRun(startedAt, now)) {
        counts.expired += 1;
        continue;
      }
      const next = {
        project: row.slug,
        runId: run.runId,
        agentId: run.agentId,
        version: run.version,
        trigger: run.trigger,
        ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
        status: run.status,
        startedAt,
        durationMs: run.durationMs,
        steps: run.steps,
        ...(run.costUsd === null ? {} : { costUsd: run.costUsd }),
        ...(run.errorClass === null ? {} : { errorClass: run.errorClass }),
        toolCalls: run.toolCalls,
        pendingApprovals: pendingApprovalsOf(run.toolCalls),
        receivedAt: now,
      };
      const stored = await ctx.db
        .query("agentRuns")
        .withIndex("by_project_and_runId", (q) => q.eq("project", row.slug).eq("runId", run.runId))
        .unique();
      if (stored === null) {
        await ctx.db.insert("agentRuns", next);
        counts.inserted += 1;
      } else {
        await ctx.db.replace(stored._id, next);
        counts.updated += 1;
      }
    }
    return counts;
  },
});

/** How many old runs one purge deletes before it schedules the next. */
const PURGE_BATCH = 500;

/** Drop run summaries older than RUN_RETENTION_DAYS, a batch at a time (the daily cron). */
export const purgeRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("agentRuns")
      .withIndex("by_startedAt", (q) => q.lt("startedAt", cutoff))
      .take(PURGE_BATCH);
    for (const run of old) await ctx.db.delete(run._id);
    if (old.length === PURGE_BATCH) await ctx.scheduler.runAfter(0, internal.agentProjects.purgeRuns, {});
    return { deleted: old.length };
  },
});
