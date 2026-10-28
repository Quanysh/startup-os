import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { storeResults, type ResultIn } from "./agentHarness";
import { hasOwner, ownerEmailList } from "./authOwner";
import {
  BUILDER_WORDS,
  MAX_SCHEDULE_VALUE,
  MAX_TOOL_CALLS_PER_RUN,
  OWNER_ONLY_TOOL_AREAS,
  RUN_RETENTION_DAYS,
  definitionOut,
  pendingApprovalsOf,
  type ConfigDefinition,
  type ModelChoice,
  type RunErrorClass,
} from "./lib/agentBuilder";
import { mayReadOutput } from "./lib/agentBuilt";
import { MAX_LATENCY_MS, costOf, dayOf, monthStartOf } from "./lib/agentControl";
import { nextRuns } from "./lib/agentCron";
import {
  controlOf,
  declaredIn,
  declaredOf,
  harnessVersionOf,
  partsOf,
  publishedVersionOf,
  usageSince,
} from "./lib/agentData";
import { VARIABLE_NAME_PATTERN, versionName, versionNumberOf } from "./lib/agentHarness";
import { MAX_OUTPUT_BYTES, jobCaseOf, type CaseMessage } from "./lib/agentJobs";
import {
  MAX_PENDING_APPROVALS,
  MAX_RUNS_PER_DAY,
  MAX_RUN_MESSAGE,
  STARTUP_OS_PROJECT,
  STARTUP_OS_PROVIDER_ENV,
  STARTUP_OS_TOOL_AREAS,
  toolAreasOf,
  RUNTIME_ACTION_WORDS,
} from "./lib/agentStartupOs";
import { startupOsCatalog } from "./lib/agentStartupOsTools";
import {
  RUNTIME_WORDS,
  dueAt,
  evaluateAssertions,
  percentile,
  resultErrorOf,
  resumeRun,
  runRefusal,
  startRun,
  type Outcome,
  type RunInput,
  type RunMode,
  type RunRecord,
  type RuntimeAgent,
  type ToolOutcome,
  type World,
} from "./lib/agentRuntime";
import { stableStringify, utf8Bytes } from "./lib/agentSchemaCompat";
import { PRODUCT } from "./lib/identity";
import { bound } from "./lib/mcpBound";
import { issueWords, toolNamed } from "./lib/mcpTools";
import { MAX_DISMISS_REASON_LENGTH, isAgentId } from "./lib/agents";
import { cleanLine } from "./lib/agentText";
import { memberOf } from "./lib/memberOf";
import { endStuckMacRuns, ensureOsAgents, isMacRun, osAgentOn } from "./lib/osAgentRuns";
import { OS_AGENT_WORDS, runsOnOf } from "./lib/osAgents";
import { configuredProviders, modelClientFor } from "./lib/modelClients";
import { isOwner, memberQuery, NOT_ALLOWED, ownerMutation, ownerQuery } from "./lib/owner";
import { may } from "./lib/roles";

// The agents Startup OS runs itself (the project `startup-os`), by the owner's
// decision of 2026-10-17: built on /agents like a project's, run here on
// Gemini (or the Astana GPU) through convex/lib/modelClients.ts, the one
// module that calls a model. The runner is convex/lib/agentRuntime.ts, pure;
// this module starts it, gives it the world (the models, Startup OS's own
// tools as the owner's `Member`, the other agents), and keeps what it did.
//
// How a run starts: on its schedule (`tick`, a native cron every minute: a
// minute runs once), with Run now (the owner's, counted as trigger `api`), as
// another agent's sub-agent (in process), or as a test run of a draft
// (`test`, every tool answered from the case's fixtures).
//
// **A tool that changes something never runs without the owner's click.**
// The run pauses, the call and its arguments wait in `agentApprovals` (the
// owner's alone to read), and `decide` resumes it: approved, the tool runs,
// once (`actTool` refuses an act no approval let through); denied, the model
// is told so. Each run's summary goes into `agentRuns` and its day into
// `agentUsage`, as a project's push would put them, so /agents shows it
// unchanged. Its answer is kept apart (`agentRunOutputs`, 64 KB at most),
// read by whoever may read the agent's runs and holds every page its tools
// read; an agent using a tool of an owner-only page is the owner's alone.
//
// Nothing here logs. No argument, answer or name is in a thrown error or a
// scheduled function's arguments: those carry ids only.

const DAY_MS = 24 * 60 * 60 * 1000;
/** How late a schedule's tick may be and still run it. */
const SCHEDULE_WINDOW_MS = 2 * 60 * 1000;
/** A run still "running" this long after it started (a crashed action) is ended. */
const STUCK_MS = 15 * 60 * 1000;
/** A run still "queued" this long after it was made (its action never started) is ended. */
const QUEUED_MS = 5 * 60 * 1000;
/** How many runs one day's percentiles read. */
const PERCENTILE_READ = 2_000;
const PURGE_BATCH = 500;
/** The waiting calls the owner's list shows, newest first. */
const APPROVALS_SHOWN = 50;
/** A stretch of a run (or a test case on a model) never takes longer than this, whatever the agent's limit: an action has ten minutes. */
const ACTION_LIMIT_MS = 9 * 60 * 1000;

/** A definition held to what one action can run. */
const withinAction = (definition: ConfigDefinition): ConfigDefinition => ({
  ...definition,
  limits: { ...definition.limits, timeoutMs: Math.min(definition.limits.timeoutMs, ACTION_LIMIT_MS) },
});

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A run's id: letters, digits and dashes (RUN_ID_PATTERN). */
function newRunId(now: number): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `os-${now.toString(36)}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── Reading the agents ──────────────────────────────────────────────────────

/** An agent as the action is given it: JSON-safe once stringified (a schema's `$` keys are no Convex value). */
type AgentPayload = {
  agentId: string;
  versionNumber: number;
  version: string;
  definition: ConfigDefinition;
  model: ModelChoice | null;
  enabled: boolean;
  budgetUsd: number | null;
  spentUsd: number | null;
  /** Its runs started today (UTC), toward MAX_RUNS_PER_DAY. */
  runsToday: number;
};

/** Whether an agent may run: one of the four by `agentSettings` (its switch), any other by its control. */
async function switchedOn(ctx: QueryCtx, agentId: string, control: { enabled: boolean } | null): Promise<boolean> {
  return isAgentId(agentId) ? await osAgentOn(ctx, agentId) : (control?.enabled ?? false);
}

/** How many runs an agent started from `dayStart` on: read only up to the cap. */
async function runsSince(ctx: QueryCtx, agentId: string, dayStart: number): Promise<number> {
  const rows = await ctx.db
    .query("agentRuns")
    .withIndex("by_project_agentId_and_startedAt", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("agentId", agentId).gte("startedAt", dayStart))
    .take(MAX_RUNS_PER_DAY);
  return rows.length;
}

/** What an agent at a version runs as, and what guards it. Null: no such built version. */
async function agentPayload(
  ctx: QueryCtx,
  agentId: string,
  versionNumber: number,
  clock: { monthStart: string; dayStart: number },
): Promise<AgentPayload | null> {
  const row = await harnessVersionOf(ctx, STARTUP_OS_PROJECT, agentId, versionNumber);
  if (row === null || row.definition === undefined) return null;
  const parts = await partsOf(ctx, row);
  const control = await controlOf(ctx, STARTUP_OS_PROJECT, agentId);
  const spent = costOf((await usageSince(ctx, STARTUP_OS_PROJECT, clock.monthStart)).filter((day) => day.agentId === agentId));
  return {
    agentId,
    versionNumber,
    version: versionName(versionNumber),
    definition: definitionOut(versionNumber, row.definition, parts),
    model: row.definition.model ?? null,
    enabled: await switchedOn(ctx, agentId, control),
    budgetUsd: control?.monthlyBudgetUsd ?? row.definition.limits.monthlyBudgetUsd ?? null,
    // Nothing spent yet is $0; a day with no price makes the month not known.
    spentUsd: spent.usd !== null ? spent.usd : spent.why === "nothing_reported" ? 0 : null,
    runsToday: await runsSince(ctx, agentId, clock.dayStart),
  };
}

/** The clock a query is handed for an agent's guards: this month's first day, and today's start (UTC). */
const clockOf = (now: number) => ({ monthStart: monthStartOf(utcDay(now)), dayStart: Date.parse(`${utcDay(now)}T00:00:00Z`) });

const guardOf = (payload: AgentPayload, configured: Readonly<Record<string, boolean>>) => ({
  enabled: payload.enabled,
  budgetUsd: payload.budgetUsd,
  spentUsd: payload.spentUsd,
  provider: payload.model?.provider ?? null,
  configured,
  runsToday: payload.runsToday,
  maxRunsPerDay: MAX_RUNS_PER_DAY,
});

/** The frames of a paused run's state, as (agent, version) pairs: what resuming it reads. */
function chainOf(state: string | undefined): { agentId: string; versionNumber: number }[] {
  if (state === undefined) return [];
  const out: { agentId: string; versionNumber: number }[] = [];
  let frame = JSON.parse(state) as { agentId: string; versionNumber: number; child: unknown } | null;
  while (frame !== null && typeof frame === "object") {
    out.push({ agentId: frame.agentId, versionNumber: frame.versionNumber });
    frame = frame.child as typeof frame;
  }
  return out;
}

async function runtimeRow(ctx: QueryCtx, runId: string) {
  return await ctx.db
    .query("agentRuntimeRuns")
    .withIndex("by_runId", (q) => q.eq("runId", runId))
    .unique();
}

/**
 * Everything one stretch of a run needs, as JSON text: the run, the agent at
 * its version, every agent its paused state names, and every published agent
 * offered as a sub-agent. Null for a run that is not running.
 */
export const load = internalQuery({
  args: { runId: v.string(), monthStart: v.string(), dayStart: v.number() },
  handler: async (ctx, args): Promise<{ text: string } | null> => {
    const run = await runtimeRow(ctx, args.runId);
    if (run === null || run.state !== "running") return null;
    const agents: AgentPayload[] = [];
    const seen = new Set<string>();
    const add = async (agentId: string, versionNumber: number) => {
      const key = `${agentId}#${versionNumber}`;
      if (seen.has(key)) return;
      seen.add(key);
      const payload = await agentPayload(ctx, agentId, versionNumber, { monthStart: args.monthStart, dayStart: args.dayStart });
      if (payload !== null) agents.push(payload);
    };
    await add(run.agentId, run.versionNumber);
    for (const frame of chainOf(run.resume)) await add(frame.agentId, frame.versionNumber);
    const offered: Record<string, string> = {};
    for (const declared of await declaredIn(ctx, STARTUP_OS_PROJECT)) {
      const published = await publishedVersionOf(ctx, STARTUP_OS_PROJECT, declared.agentId);
      const toolId = published?.definition?.triggers.subAgent?.toolId;
      if (published === null || toolId === undefined) continue;
      await add(declared.agentId, published.number);
      offered[toolId] = `${declared.agentId}#${published.number}`;
    }
    return {
      text: JSON.stringify({
        run: {
          runId: run.runId,
          agentId: run.agentId,
          versionNumber: run.versionNumber,
          trigger: run.trigger,
          input: run.input,
          resume: run.resume ?? null,
          createdAt: run.createdAt,
        },
        agents,
        offered,
      }),
    };
  },
});

// ── The world a run is given ────────────────────────────────────────────────

type Loaded = {
  run: { runId: string; agentId: string; versionNumber: number; trigger: "api" | "schedule"; input: string; resume: string | null; createdAt: number };
  agents: AgentPayload[];
  offered: Record<string, string>;
};

/** The catalogue as the runner reads it: each tool's description, its arguments' schema, and whether it changes something. */
function catalogMap(): World["catalog"] {
  return new Map(
    startupOsCatalog().map((tool) => [
      tool.id,
      { description: tool.description, parameters: JSON.parse(tool.inputSchema) as Record<string, unknown>, effect: tool.effect },
    ]),
  );
}

const asRuntimeAgent = (payload: AgentPayload, configured: Record<string, boolean>): RuntimeAgent => ({
  agentId: payload.agentId,
  version: payload.version,
  versionNumber: payload.versionNumber,
  definition: withinAction(payload.definition),
  model: payload.model,
  refusal: runRefusal(guardOf(payload, configured)),
});

/**
 * The sentence a function refused with (a `ConvexError` whose data is text),
 * or fixed words for anything else thrown. Between two functions the data
 * travels as JSON, so both forms are read (as convex/mcp.ts does).
 */
function refusalWords(error: unknown): string {
  if (!(error instanceof ConvexError) || typeof error.data !== "string") return RUNTIME_WORDS.failed;
  let said: string = error.data;
  try {
    const decoded: unknown = JSON.parse(error.data);
    if (typeof decoded === "string") said = decoded;
  } catch {
    // Not JSON: it is the sentence itself.
  }
  return said === NOT_ALLOWED ? TOOL_WORDS.notAllowed : said;
}

const TOOL_WORDS = {
  stopped: "This run is not running.",
  notOwner: `${PRODUCT.name}'s agents run as the owner, and no owner is signed up.`,
  notAllowed: "The owner may not use that here.",
  notApproved: "That change was not approved.",
} as const;

function worldFor(ctx: ActionCtx, loaded: Loaded): World {
  const configured = configuredProviders();
  const catalog = catalogMap();
  const byKey = new Map(loaded.agents.map((agent) => [`${agent.agentId}#${agent.versionNumber}`, agent]));
  const rootRunId = loaded.run.runId;
  return {
    catalog,
    subAgent: (toolId) => {
      const key = loaded.offered[toolId];
      const payload = key === undefined ? undefined : byKey.get(key);
      return payload === undefined ? null : asRuntimeAgent(payload, configured);
    },
    agentAt: (agentId, versionNumber) => {
      const payload = byKey.get(`${agentId}#${versionNumber}`);
      return payload === undefined ? null : asRuntimeAgent(payload, configured);
    },
    clientFor: (provider) => modelClientFor(provider),
    execute: async (call): Promise<ToolOutcome> => {
      const now = Date.now();
      const args = {
        rootRunId,
        runId: call.runId,
        agentId: call.agentId,
        versionNumber: call.versionNumber,
        toolId: call.toolId,
        input: JSON.stringify(call.args),
        now,
        today: utcDay(now),
      };
      // A call the owner approved (a write, or a tool the agent lists in `approvals`) runs in a mutation, which spends the approval.
      const approved =
        catalog.get(call.toolId)?.effect === "write" ||
        (byKey.get(`${call.agentId}#${call.versionNumber}`)?.definition.approvals.includes(call.toolId) ?? false);
      try {
        const ran = approved
          ? await ctx.runMutation(internal.agentRuntime.actTool, args)
          : await ctx.runQuery(internal.agentRuntime.readTool, args);
        return ran.status === "ok" ? { status: "ok", output: JSON.parse(ran.text) as unknown } : { status: "error", message: ran.message };
      } catch (error) {
        return { status: "error", message: refusalWords(error) };
      }
    },
    now: () => Date.now(),
    newRunId: () => newRunId(Date.now()),
  };
}

/** The root run's record when the action itself failed: ended as a server error. */
function crashed(loaded: Loaded, startedAt: number): Outcome {
  const root = loaded.agents.find((a) => a.agentId === loaded.run.agentId && a.versionNumber === loaded.run.versionNumber);
  return {
    kind: "finished",
    records: [
      {
        runId: loaded.run.runId,
        parentRunId: null,
        agentId: loaded.run.agentId,
        version: versionName(loaded.run.versionNumber),
        versionNumber: loaded.run.versionNumber,
        trigger: loaded.run.trigger,
        status: "error",
        errorClass: "server",
        startedAt,
        durationMs: 0,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        provider: root?.model?.provider ?? null,
        model: root?.model?.model ?? null,
        usedFallback: false,
        toolCalls: [],
        output: null,
        schemaValid: null,
      },
    ],
  };
}

async function segment(ctx: ActionCtx, runId: string, go: (world: World, loaded: Loaded) => Promise<Outcome>) {
  const now = Date.now();
  const found = await ctx.runQuery(internal.agentRuntime.load, { runId, ...clockOf(now) });
  if (found === null) return;
  const loaded = JSON.parse(found.text) as Loaded;
  let outcome: Outcome;
  try {
    outcome = await go(worldFor(ctx, loaded), loaded);
  } catch {
    outcome = crashed(loaded, loaded.run.createdAt);
  }
  await ctx.runMutation(internal.agentRuntime.settle, { runId, outcome: JSON.stringify(outcome) });
}

/** Start a queued run (Run now, a schedule). */
export const execute = internalAction({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const claimed = await ctx.runMutation(internal.agentRuntime.claim, { runId: args.runId });
    if (!claimed) return;
    await segment(ctx, args.runId, async (world, loaded) => {
      const root = world.agentAt(loaded.run.agentId, loaded.run.versionNumber);
      if (root === null) return crashed(loaded, loaded.run.createdAt);
      const input = JSON.parse(loaded.run.input) as RunInput;
      return await startRun(root, input, { trigger: loaded.run.trigger, runId: loaded.run.runId, world, mode: { kind: "run" } });
    });
  },
});

/** Resume a run the owner decided on (`decide` has claimed it). */
export const resume = internalAction({
  args: { runId: v.string(), decision: v.union(v.literal("approved"), v.literal("denied")) },
  handler: async (ctx, args) => {
    await segment(ctx, args.runId, async (world, loaded) => {
      if (loaded.run.resume === null) return crashed(loaded, loaded.run.createdAt);
      return await resumeRun(loaded.run.resume, args.decision, world);
    });
  },
});

/** A queued run, taken to run: once. */
export const claim = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const run = await runtimeRow(ctx, args.runId);
    if (run === null || run.state !== "queued") return false;
    await ctx.db.patch(run._id, { state: "running", claimedAt: Date.now() });
    return true;
  },
});

// ── Tools, as the owner ─────────────────────────────────────────────────────

const toolArgs = {
  rootRunId: v.string(),
  /** The run that made the call (the root, or a sub-agent's run under it), its agent and that agent's version. */
  runId: v.string(),
  agentId: v.string(),
  versionNumber: v.number(),
  toolId: v.string(),
  /** The call's arguments, as JSON: checked against the tool's schema before anything runs. */
  input: v.string(),
  now: v.number(),
  today: v.string(),
};

type ToolRan = { status: "ok"; text: string } | { status: "error"; message: string };

type ToolCallArgs = {
  rootRunId: string;
  runId: string;
  agentId: string;
  versionNumber: number;
  toolId: string;
  input: string;
  now: number;
  today: string;
};

/** Arguments as JSON in one form whatever their keys' order, or null for text that is not JSON. */
function canonical(text: string): string | null {
  try {
    return stableStringify(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * One of Startup OS's tools, for a run that is running, as the owner's
 * `Member` (asked again here, as the gate would: still an owner now), with
 * the tool's area checked and the tool in the calling agent's own version
 * (one that was published). A call that needs the owner's approval (every
 * act, and a read the agent lists in `approvals`) runs only in a mutation
 * and only on an approval given for exactly this call: this run, this agent,
 * this tool and these arguments, unused; it is spent. A refusal by the app's
 * own rules is thrown by the function the tool calls, and a mutation that
 * throws writes nothing.
 */
async function runTool(ctx: QueryCtx | MutationCtx, route: "read" | "act", args: ToolCallArgs): Promise<ToolRan> {
  const run = await runtimeRow(ctx, args.rootRunId);
  if (run === null || run.state !== "running") return { status: "error", message: TOOL_WORDS.stopped };
  const version = await harnessVersionOf(ctx, STARTUP_OS_PROJECT, args.agentId, args.versionNumber);
  if (version?.definition === undefined || version.publishedAt === undefined || !(version.tools ?? []).includes(args.toolId)) {
    return { status: "error", message: RUNTIME_WORDS.notATool };
  }
  const user = await ctx.db.get(run.actAs);
  const member = user?.email === undefined ? null : await memberOf(ctx, user.email);
  if (member === null || !isOwner(member)) return { status: "error", message: TOOL_WORDS.notOwner };
  const tool = toolNamed(args.toolId);
  const area = STARTUP_OS_TOOL_AREAS[args.toolId];
  if (tool === undefined || area === undefined || tool.audience === "runner") return { status: "error", message: RUNTIME_WORDS.notATool };
  const needsApproval = tool.kind === "act" || version.definition.approvals.includes(args.toolId);
  if (needsApproval !== (route === "act")) return { status: "error", message: TOOL_WORDS.notApproved };
  if (!may(member, toolAreasOf(args.toolId, tool.kind))) return { status: "error", message: TOOL_WORDS.notAllowed };
  let raw: unknown;
  try {
    raw = JSON.parse(args.input);
  } catch {
    raw = null;
  }
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) return { status: "error", message: issueWords(parsed.error) };
  // One of the four writes as itself, never as another of them.
  const named = (parsed.data as { agent?: unknown }).agent;
  if (isAgentId(args.agentId) && named !== undefined && named !== args.agentId) return { status: "error", message: OS_AGENT_WORDS.wrongAgent };
  const clock = { now: args.now, today: args.today, client: args.agentId };
  if (needsApproval) {
    const given = canonical(args.input);
    const approved = (
      await ctx.db
        .query("agentApprovals")
        .withIndex("by_rootRunId", (q) => q.eq("rootRunId", run.runId))
        .collect()
    ).find(
      (row) =>
        row.state === "approved" &&
        row.usedAt === undefined &&
        row.toolId === args.toolId &&
        row.agentId === args.agentId &&
        row.runId === args.runId &&
        given !== null &&
        canonical(row.arguments) === given,
    );
    if (approved === undefined) return { status: "error", message: TOOL_WORDS.notApproved };
    const mutation = ctx as MutationCtx;
    await mutation.db.patch(approved._id, { usedAt: args.now });
    const output = await tool.run(mutation, member, parsed.data, clock);
    return { status: "ok", text: JSON.stringify(bound(output, tool.caps)) };
  }
  if (tool.kind !== "read") return { status: "error", message: TOOL_WORDS.notApproved };
  const output = await tool.run(ctx, member, parsed.data, clock);
  return { status: "ok", text: JSON.stringify(bound(output, tool.caps)) };
}

export const readTool = internalQuery({
  args: toolArgs,
  handler: (ctx, args): Promise<ToolRan> => runTool(ctx, "read", args),
});

export const actTool = internalMutation({
  args: toolArgs,
  handler: (ctx, args): Promise<ToolRan> => runTool(ctx, "act", args),
});

// ── Keeping what a run did ──────────────────────────────────────────────────

/** A run's summary into `agentRuns`, as a project's push would put it: ids, states and numbers. */
async function storeSummary(ctx: MutationCtx, record: RunRecord, now: number) {
  const next = {
    project: STARTUP_OS_PROJECT,
    runId: record.runId,
    agentId: record.agentId,
    version: record.version,
    trigger: record.trigger,
    ...(record.parentRunId === null ? {} : { parentRunId: record.parentRunId }),
    status: record.status,
    startedAt: record.startedAt,
    durationMs: Math.max(0, Math.round(record.durationMs)),
    steps: record.steps,
    // No price is known for Startup OS's own models: left out, "Not priced", never $0.
    ...(record.errorClass === null ? {} : { errorClass: record.errorClass }),
    toolCalls: record.toolCalls,
    pendingApprovals: pendingApprovalsOf(record.toolCalls),
    receivedAt: now,
  };
  const stored = await ctx.db
    .query("agentRuns")
    .withIndex("by_project_and_runId", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("runId", record.runId))
    .unique();
  if (stored === null) await ctx.db.insert("agentRuns", next);
  else await ctx.db.replace(stored._id, next);
}

/** A finished run added to its day's usage row, as a project's daily total would carry it. */
async function addUsage(ctx: MutationCtx, record: RunRecord, now: number) {
  if (record.provider === null || record.model === null) return;
  const day = dayOf(record.startedAt);
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const ofDay = await ctx.db
    .query("agentRuns")
    .withIndex("by_project_agentId_and_startedAt", (q) =>
      q.eq("project", STARTUP_OS_PROJECT).eq("agentId", record.agentId).gte("startedAt", dayStart).lt("startedAt", dayStart + DAY_MS),
    )
    .take(PERCENTILE_READ);
  const durations = ofDay
    .filter((run) => run.version === record.version && run.status !== "awaiting_approval" && run.status !== "refused")
    .map((run) => run.durationMs);
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const stored = await ctx.db
    .query("agentUsage")
    .withIndex("by_project_agentId_promptVersion_provider_model_day", (q) =>
      q
        .eq("project", STARTUP_OS_PROJECT)
        .eq("agentId", record.agentId)
        .eq("promptVersion", record.version)
        .eq("provider", record.provider!)
        .eq("model", record.model!)
        .eq("day", day),
    )
    .unique();
  const failed = record.status === "error" || record.status === "timeout";
  const next = {
    project: STARTUP_OS_PROJECT,
    agentId: record.agentId,
    promptVersion: record.version,
    provider: record.provider,
    model: record.model,
    day,
    calls: (stored?.calls ?? 0) + 1,
    errors: (stored?.errors ?? 0) + (failed ? 1 : 0),
    schemaFailures: (stored?.schemaFailures ?? 0) + (record.errorClass === "schema" ? 1 : 0),
    fallbacks: (stored?.fallbacks ?? 0) + (record.usedFallback ? 1 : 0),
    refusals: (stored?.refusals ?? 0) + (record.status === "refused" ? 1 : 0),
    inputTokens: (stored?.inputTokens ?? 0) + record.inputTokens,
    outputTokens: (stored?.outputTokens ?? 0) + record.outputTokens,
    ...(p50 === null ? {} : { p50Ms: p50 }),
    ...(p95 === null ? {} : { p95Ms: p95 }),
    syncedAt: now,
  };
  if (stored === null) await ctx.db.insert("agentUsage", next);
  else await ctx.db.replace(stored._id, next);
}

async function storeRecord(ctx: MutationCtx, record: RunRecord, now: number) {
  await storeSummary(ctx, record, now);
  if (record.status === "awaiting_approval") return;
  await addUsage(ctx, record, now);
  if (record.output === null) return;
  const kept = await ctx.db
    .query("agentRunOutputs")
    .withIndex("by_project_and_runId", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("runId", record.runId))
    .unique();
  if (kept !== null) return;
  const access = await accessOf(ctx, record);
  await ctx.db.insert("agentRunOutputs", {
    project: STARTUP_OS_PROJECT,
    runId: record.runId,
    agentId: record.agentId,
    format: record.output.format,
    text: record.output.text,
    truncated: record.output.truncated,
    ownerOnly: access.ownerOnly,
    areas: access.areas,
    createdAt: now,
  });
}

/** How deep a run's sub-agent runs are read for its answer's access: the runtime's own limit, and one more. */
const ACCESS_DEPTH = 4;

/**
 * Who may read a run's answer, decided as it is kept: the pages of the tools
 * of the version it ran on and of each version its sub-agent runs ran on
 * (their summaries are stored before it), however deep. Owner-only where any
 * of those pages is the owner's to give.
 */
async function accessOf(ctx: QueryCtx, record: RunRecord): Promise<{ ownerOnly: boolean; areas: string[] }> {
  const areaOf = new Map(startupOsCatalog().map((tool) => [tool.id, tool.area]));
  const areas = new Set<string>();
  let level = [{ runId: record.runId, agentId: record.agentId, versionNumber: record.versionNumber }];
  for (let depth = 0; depth < ACCESS_DEPTH && level.length > 0; depth += 1) {
    const next: typeof level = [];
    for (const run of level) {
      const version = await harnessVersionOf(ctx, STARTUP_OS_PROJECT, run.agentId, run.versionNumber);
      for (const id of version?.tools ?? []) {
        const area = areaOf.get(id);
        if (area !== undefined) areas.add(area);
      }
      const children = await ctx.db
        .query("agentRuns")
        .withIndex("by_project_and_parentRunId", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("parentRunId", run.runId))
        .take(MAX_TOOL_CALLS_PER_RUN);
      for (const child of children) {
        const number = versionNumberOf(child.version);
        if (number !== null) next.push({ runId: child.runId, agentId: child.agentId, versionNumber: number });
      }
    }
    level = next;
  }
  const sorted = [...areas].sort();
  return { ownerOnly: sorted.some((area) => (OWNER_ONLY_TOOL_AREAS as readonly string[]).includes(area)), areas: sorted };
}

/** What a stretch of a run did: its summaries, usage and answers kept; a pause waits for the owner. */
export const settle = internalMutation({
  args: { runId: v.string(), outcome: v.string() },
  handler: async (ctx, args) => {
    const run = await runtimeRow(ctx, args.runId);
    if (run === null || run.state !== "running") return;
    const outcome = JSON.parse(args.outcome) as Outcome;
    const now = Date.now();
    for (const record of outcome.records) await storeRecord(ctx, record, now);
    if (outcome.kind === "paused") {
      await ctx.db.insert("agentApprovals", {
        project: STARTUP_OS_PROJECT,
        rootAgentId: run.agentId,
        rootRunId: run.runId,
        agentId: outcome.pending.agentId,
        runId: outcome.pending.runId,
        toolId: outcome.pending.toolId,
        arguments: JSON.stringify(outcome.pending.args),
        state: "pending",
        createdAt: now,
      });
      await ctx.db.patch(run._id, { state: "awaiting_approval", resume: outcome.state });
      return;
    }
    await ctx.db.patch(run._id, { state: "done", finishedAt: now, resume: undefined });
  },
});

// ── Starting a run ──────────────────────────────────────────────────────────

/** A published Startup OS agent that may run now, or the sentence that says why not. */
async function runnable(ctx: QueryCtx, agentId: string, now: number) {
  if ((await declaredOf(ctx, STARTUP_OS_PROJECT, agentId)) === null) throw new ConvexError(RUNTIME_ACTION_WORDS.noAgent);
  const published = await publishedVersionOf(ctx, STARTUP_OS_PROJECT, agentId);
  const definition = published?.definition;
  if (published === null || definition === undefined) throw new ConvexError(RUNTIME_ACTION_WORDS.notPublished);
  const payload = (await agentPayload(ctx, agentId, published.number, clockOf(now)))!;
  const refusal = runRefusal(guardOf(payload, configuredProviders()));
  return { published, definition, refusal, provider: payload.model?.provider ?? null, capped: payload.runsToday >= MAX_RUNS_PER_DAY };
}

/** How many of an agent's calls wait for the owner, up to the cap. */
async function waitingCalls(ctx: QueryCtx, agentId: string): Promise<number> {
  const rows = await ctx.db
    .query("agentApprovals")
    .withIndex("by_project_rootAgentId_and_state", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("rootAgentId", agentId).eq("state", "pending"))
    .take(MAX_PENDING_APPROVALS);
  return rows.length;
}

/** Whether an agent has a run started and not ended: queued, running or waiting for the owner. */
async function busy(ctx: QueryCtx, agentId: string): Promise<boolean> {
  for (const state of ["queued", "running", "awaiting_approval"] as const) {
    const row = await ctx.db
      .query("agentRuntimeRuns")
      .withIndex("by_project_agentId_and_state", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("agentId", agentId).eq("state", state))
      .first();
    if (row !== null) return true;
  }
  return false;
}

function refusalSentence(refusal: RunErrorClass, provider: string | null, capped: boolean): string {
  if (refusal === "agent_off") return RUNTIME_ACTION_WORDS.off;
  if (refusal === "over_budget") return capped ? RUNTIME_ACTION_WORDS.dailyCap : RUNTIME_ACTION_WORDS.overBudget;
  if (provider === null) return RUNTIME_ACTION_WORDS.noModel;
  return RUNTIME_ACTION_WORDS.notConfigured(STARTUP_OS_PROVIDER_ENV[provider] ?? []);
}

/** The owner whose `Member` a scheduled run acts as: the first owner address that has signed in. */
async function actingOwner(ctx: QueryCtx): Promise<Id<"users"> | null> {
  if (!hasOwner()) return null;
  for (const email of ownerEmailList()) {
    const member = await memberOf(ctx, email);
    if (member !== null && isOwner(member)) return member.user._id;
  }
  return null;
}

/**
 * Run a published Startup OS agent now, with what the owner typed: its
 * variables, or one message for a conversation agent. Counted as trigger
 * `api`. Refused while it is off, over its budget or its provider is not
 * configured. The run starts at once; its summary appears on the Runs tab.
 */
export const runNow = ownerMutation({
  args: { agentId: v.string(), variables: v.record(v.string(), v.string()), message: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    // One of the four on the Mac runs there, at its times: Startup OS does not start it.
    if (isAgentId(args.agentId) && runsOnOf(STARTUP_OS_PROJECT, args.agentId, (await controlOf(ctx, STARTUP_OS_PROJECT, args.agentId))?.runsOn) === "claude_mac") {
      throw new ConvexError(OS_AGENT_WORDS.macRunNow);
    }
    const { published, definition, refusal, provider, capped } = await runnable(ctx, args.agentId, now);
    if (refusal !== null) throw new ConvexError(refusalSentence(refusal, provider, capped));
    if ((await waitingCalls(ctx, args.agentId)) >= MAX_PENDING_APPROVALS) throw new ConvexError(RUNTIME_ACTION_WORDS.tooManyWaiting);
    let input: RunInput;
    if (definition.input.mode === "messages") {
      const message = (args.message ?? "").trim();
      if (message === "" || message.length > MAX_RUN_MESSAGE) throw new ConvexError(RUNTIME_ACTION_WORDS.message);
      input = { variables: {}, messages: [{ role: "user", content: message }] };
    } else {
      const declared = new Set(definition.input.variables.map((variable) => variable.name));
      for (const name of Object.keys(args.variables)) {
        if (!declared.has(name)) {
          throw new ConvexError(BUILDER_WORDS.scheduleVariable(VARIABLE_NAME_PATTERN.test(name) ? name : "*"));
        }
      }
      for (const variable of definition.input.variables) {
        if (variable.required && (args.variables[variable.name] ?? "").trim() === "") {
          throw new ConvexError(BUILDER_WORDS.scheduleRequired(variable.name));
        }
      }
      if (Object.values(args.variables).some((value) => value.length > MAX_SCHEDULE_VALUE)) {
        throw new ConvexError(BUILDER_WORDS.scheduleValue);
      }
      input = { variables: { ...args.variables } };
    }
    const runId = newRunId(now);
    await ctx.db.insert("agentRuntimeRuns", {
      project: STARTUP_OS_PROJECT,
      runId,
      agentId: args.agentId,
      versionNumber: published.number,
      trigger: "api",
      state: "queued",
      actAs: ctx.owner._id,
      startedBy: ctx.owner._id,
      input: JSON.stringify(input),
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.agentRuntime.execute, { runId });
    return { runId };
  },
});

/** The record of a run ended without a model call: refused before it started, or stuck. */
function endedRecord(
  run: { runId: string; agentId: string; versionNumber: number; trigger: "api" | "schedule"; createdAt: number },
  status: "refused" | "timeout" | "error",
  errorClass: RunErrorClass,
  model: ModelChoice | null,
): RunRecord {
  return {
    runId: run.runId,
    parentRunId: null,
    agentId: run.agentId,
    version: versionName(run.versionNumber),
    versionNumber: run.versionNumber,
    trigger: run.trigger,
    status,
    errorClass,
    startedAt: run.createdAt,
    durationMs: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    provider: model?.provider ?? null,
    model: model?.model ?? null,
    usedFallback: false,
    toolCalls: [],
    output: null,
    schemaValid: null,
  };
}

/**
 * Every minute (a native cron): each published, switched-on Startup OS agent
 * whose schedule was due in the last two minutes is started once for that
 * minute; one that may not run (over its budget, its provider not
 * configured) is recorded as a refused run. Runs stuck past fifteen minutes
 * (a failed action) are ended as timed out.
 */
export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const owner = await actingOwner(ctx);
    if (owner !== null) {
      // Startup OS's own four, seeded from their code's defaults once an owner has signed in.
      const ownerRow = await ctx.db.get(owner);
      if (ownerRow !== null) await ensureOsAgents(ctx, ownerRow, now);
      for (const declared of await declaredIn(ctx, STARTUP_OS_PROJECT)) {
        const published = await publishedVersionOf(ctx, STARTUP_OS_PROJECT, declared.agentId);
        const schedule = published?.definition?.triggers.schedule;
        if (published === null || schedule === undefined) continue;
        const control = await controlOf(ctx, STARTUP_OS_PROJECT, declared.agentId);
        if (control === null || !(await switchedOn(ctx, declared.agentId, control))) continue;
        // One runner an agent: one of the four on the Mac is the Mac's to run, never this schedule's.
        if (runsOnOf(STARTUP_OS_PROJECT, declared.agentId, control.runsOn) === "claude_mac") continue;
        // One run of an agent at a time: no scheduled run piles onto one not ended.
        if (await busy(ctx, declared.agentId)) continue;
        const due = dueAt((after) => nextRuns(schedule.cron, after, 5), now, SCHEDULE_WINDOW_MS);
        if (due === null) continue;
        const taken = await ctx.db
          .query("agentRuntimeRuns")
          .withIndex("by_project_agentId_and_scheduledFor", (q) =>
            q.eq("project", STARTUP_OS_PROJECT).eq("agentId", declared.agentId).eq("scheduledFor", due),
          )
          .first();
        if (taken !== null) continue;
        const { refusal, definition } = await runnable(ctx, declared.agentId, now);
        const run = {
          project: STARTUP_OS_PROJECT,
          runId: newRunId(now),
          agentId: declared.agentId,
          versionNumber: published.number,
          trigger: "schedule" as const,
          actAs: owner,
          scheduledFor: due,
          input: JSON.stringify({ variables: { ...schedule.variables } }),
          createdAt: now,
        };
        if (refusal !== null) {
          await ctx.db.insert("agentRuntimeRuns", { ...run, state: "done", finishedAt: now });
          await storeRecord(ctx, endedRecord(run, "refused", refusal, definition.model ?? null), now);
          continue;
        }
        await ctx.db.insert("agentRuntimeRuns", { ...run, state: "queued" });
        await ctx.scheduler.runAfter(0, internal.agentRuntime.execute, { runId: run.runId });
      }
    }
    // A run queued and never started (its action never came) is ended, with a class.
    const unstarted = await ctx.db
      .query("agentRuntimeRuns")
      .withIndex("by_state_and_createdAt", (q) => q.eq("state", "queued").lt("createdAt", now - QUEUED_MS))
      .take(50);
    for (const run of unstarted) {
      // A Mac run handed out waits for the runner, which may be running the ones before it: ended by its own rule.
      if (isMacRun(run)) continue;
      const version = await harnessVersionOf(ctx, STARTUP_OS_PROJECT, run.agentId, run.versionNumber);
      await storeRecord(ctx, endedRecord(run, "error", "server", version?.definition?.model ?? null), now);
      await ctx.db.patch(run._id, { state: "done", finishedAt: now });
    }
    // A run whose action died is ended, not left running. The Mac's runs are ended by their own rule.
    await endStuckMacRuns(ctx, now);
    const stuck = await ctx.db
      .query("agentRuntimeRuns")
      .withIndex("by_state_and_createdAt", (q) => q.eq("state", "running"))
      .take(50);
    for (const run of stuck) {
      if (isMacRun(run) || (run.claimedAt ?? run.createdAt) > now - STUCK_MS) continue;
      const version = await harnessVersionOf(ctx, STARTUP_OS_PROJECT, run.agentId, run.versionNumber);
      await storeRecord(ctx, endedRecord(run, "timeout", "timeout", version?.definition?.model ?? null), now);
      await ctx.db.patch(run._id, { state: "done", finishedAt: now, resume: undefined });
    }
  },
});

// ── Approvals: the owner's ──────────────────────────────────────────────────

/** The calls waiting for the owner on an agent's runs (started by it, or its own as a sub-agent), with their arguments. */
export const approvals = ownerQuery({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    // Newest first, so a new call is never behind older ones; new runs stop at MAX_PENDING_APPROVALS, so this holds them all.
    const started = await ctx.db
      .query("agentApprovals")
      .withIndex("by_project_rootAgentId_and_state", (q) =>
        q.eq("project", STARTUP_OS_PROJECT).eq("rootAgentId", args.agentId).eq("state", "pending"),
      )
      .order("desc")
      .take(APPROVALS_SHOWN);
    const own = await ctx.db
      .query("agentApprovals")
      .withIndex("by_project_agentId_and_state", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("agentId", args.agentId).eq("state", "pending"))
      .order("desc")
      .take(APPROVALS_SHOWN);
    const rows = [...new Map([...started, ...own].map((row) => [row._id, row])).values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, APPROVALS_SHOWN);
    return rows.map((row) => ({
      id: row._id,
      rootRunId: row.rootRunId,
      runId: row.runId,
      agentId: row.agentId,
      toolId: row.toolId,
      toolName: toolNamed(row.toolId)?.title ?? row.toolId,
      /** JSON text, as the model sent it: data, shown as text. */
      arguments: row.arguments,
      createdAt: row.createdAt,
    }));
  },
});

/** The owner's click on a waiting call: approved, it runs and the run goes on; denied, the run goes on without it. */
export const decide = ownerMutation({
  args: {
    id: v.id("agentApprovals"),
    decision: v.union(v.literal("approve"), v.literal("deny")),
    /** A denial's reason, typed on /approvals (required to deny): kept on the row, never sent to the model or a log. */
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null || row.state !== "pending") throw new ConvexError(RUNTIME_ACTION_WORDS.decided);
    const run = await runtimeRow(ctx, row.rootRunId);
    if (run === null || run.state !== "awaiting_approval") throw new ConvexError(RUNTIME_ACTION_WORDS.gone);
    const now = Date.now();
    const state = args.decision === "approve" ? ("approved" as const) : ("denied" as const);
    if ((args.reason ?? "").trim().length > MAX_DISMISS_REASON_LENGTH) {
      throw new ConvexError(`That reason is too long (${MAX_DISMISS_REASON_LENGTH} characters at most).`);
    }
    const said = state === "denied" ? cleanLine(args.reason ?? "", MAX_DISMISS_REASON_LENGTH) : "";
    // One rule with a proposal's rejection: a denial carries the owner's reason.
    if (state === "denied" && said === "") throw new ConvexError(RUNTIME_ACTION_WORDS.denyReason);
    await ctx.db.patch(row._id, {
      state,
      decidedAt: now,
      decidedBy: ctx.owner._id,
      ...(said === "" ? null : { denyReason: said }),
    });
    await ctx.db.patch(run._id, { state: "running", claimedAt: now });
    await ctx.scheduler.runAfter(0, internal.agentRuntime.resume, { runId: run.runId, decision: state });
    return { state };
  },
});

// ── A run's answer ──────────────────────────────────────────────────────────

/**
 * What a Startup OS run answered (text or JSON, 64 KB at most), for whoever may
 * read the agent's runs and holds every page its tools read; an agent using
 * a tool of an owner-only page, the owner alone. Null where it kept none.
 */
export const output = memberQuery("agents")({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("agentRunOutputs")
      .withIndex("by_project_and_runId", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("runId", args.runId))
      .unique();
    if (row === null) return null;
    // Decided when it was kept, never by what is published since.
    if (!mayReadOutput(ctx.member, row)) throw new ConvexError(NOT_ALLOWED);
    return { runId: row.runId, agentId: row.agentId, format: row.format, text: row.text, truncated: row.truncated };
  },
});

// ── Test runs of a Startup OS draft ───────────────────────────────────────────

type TestJob = {
  definition: ConfigDefinition;
  subAgents: { agentId: string; definition: ConfigDefinition }[];
  models: { provider: string; model: string }[];
  cases: { caseId: string; expect: Record<string, unknown>[]; variables: Record<string, string>; variant?: string; messages?: CaseMessage[]; toolFixtures?: Record<string, unknown>; subAgentFixtures?: Record<string, unknown> }[];
  agentId: string;
};

/** A Startup OS test run's job, as JSON text, marked running; null once it is closed. */
export const testJob = internalMutation({
  args: { run: v.id("agentHarnessRuns") },
  handler: async (ctx, args): Promise<{ text: string } | null> => {
    const run = await ctx.db.get(args.run);
    if (run === null || run.project !== STARTUP_OS_PROJECT || (run.status !== "queued" && run.status !== "running")) return null;
    if (run.status === "queued") await ctx.db.patch(run._id, { status: "running" });
    const payload = await ctx.db
      .query("agentHarnessRunPayloads")
      .withIndex("by_run", (q) => q.eq("run", run._id))
      .unique();
    if (payload?.definition === undefined) return null;
    const built = JSON.parse(payload.definition) as { definition: ConfigDefinition; subAgents: TestJob["subAgents"] };
    const cases = (
      await ctx.db
        .query("agentHarnessRunCases")
        .withIndex("by_run_and_caseId", (q) => q.eq("run", run._id))
        .collect()
    ).sort((a, b) => a.position - b.position);
    const job: TestJob = {
      agentId: run.agentId,
      definition: built.definition,
      subAgents: built.subAgents,
      models: run.models,
      cases: cases.map((c) => {
        const out = jobCaseOf(c.caseId, {
          name: c.name,
          variables: c.variables,
          toolFixtures: c.toolFixtures,
          expect: c.expect,
          variant: c.variant,
          messages: c.messages,
          subAgentFixtures: c.subAgentFixtures,
        });
        return { ...out, caseId: c.caseId };
      }),
    };
    return { text: JSON.stringify(job) };
  },
});

/** One result of a Startup OS test run, stored as a project's would be; the last closes the run. */
export const testResult = internalMutation({
  args: { run: v.id("agentHarnessRuns"), result: v.string(), final: v.boolean() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.run);
    if (run === null || run.project !== STARTUP_OS_PROJECT || (run.status !== "queued" && run.status !== "running")) return;
    const cases = await ctx.db
      .query("agentHarnessRunCases")
      .withIndex("by_run_and_caseId", (q) => q.eq("run", run._id))
      .collect();
    await storeResults(ctx, run, new Map(cases.map((c) => [c.caseId, c.expect.length])), [JSON.parse(args.result) as ResultIn], args.final);
  },
});

/** One case on one model, run on the case's fixtures: the result a project would send. */
async function runCase(job: TestJob, index: number): Promise<ResultIn> {
  const testCase = job.cases[Math.floor(index / job.models.length)]!;
  const model = job.models[index % job.models.length]!;
  const configured = configuredProviders();
  const asAgent = (agentId: string, definition: ConfigDefinition): RuntimeAgent => ({
    agentId,
    version: definition.harness.version,
    versionNumber: 0,
    definition: withinAction(definition),
    model,
    refusal: configured[model.provider] === true ? null : "provider_not_configured",
  });
  const subs = new Map(
    job.subAgents
      .filter((sub) => sub.definition.triggers.subAgent !== undefined)
      .map((sub) => [sub.definition.triggers.subAgent!.toolId, asAgent(sub.agentId, sub.definition)]),
  );
  let ids = 0;
  const world: World = {
    catalog: catalogMap(),
    subAgent: (toolId) => subs.get(toolId) ?? null,
    agentAt: () => null,
    clientFor: (provider) => modelClientFor(provider),
    // Nothing runs in a test: every tool is answered from a fixture.
    execute: () => Promise.resolve({ status: "error", message: RUNTIME_WORDS.noFixture }),
    now: () => Date.now(),
    newRunId: () => `test-${(ids += 1)}`,
  };
  const mode: RunMode = {
    kind: "test",
    fixtures: testCase.toolFixtures ?? {},
    subAgentFixtures: testCase.subAgentFixtures ?? {},
    model,
  };
  const started = Date.now();
  const outcome = await startRun(
    asAgent(job.agentId, job.definition),
    { variables: testCase.variables, ...(testCase.messages === undefined ? {} : { messages: testCase.messages }), ...(testCase.variant === undefined ? {} : { variant: testCase.variant }) },
    { trigger: "test", runId: "test-root", world, mode },
  );
  const root = outcome.records.find((record) => record.runId === "test-root")!;
  const value =
    root.output === null || root.output.truncated
      ? null
      : root.output.format === "json"
        ? (JSON.parse(root.output.text) as unknown)
        : root.output.text;
  const text = value === null ? null : JSON.stringify(value);
  const hasSchema = job.definition.harness.output !== undefined;
  return {
    caseId: testCase.caseId,
    provider: model.provider,
    model: model.model,
    output: text !== null && utf8Bytes(text) <= MAX_OUTPUT_BYTES ? text : null,
    schemaValid: hasSchema ? root.schemaValid === true : true,
    assertions: evaluateAssertions(value, testCase.expect),
    latencyMs: Math.min(MAX_LATENCY_MS, Date.now() - started),
    inputTokens: outcome.records.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: outcome.records.reduce((sum, record) => sum + record.outputTokens, 0),
    costUsd: null,
    error: resultErrorOf(root.status, root.errorClass),
    steps: Math.min(1_000, root.steps),
    toolCalls: root.toolCalls.slice(0, 100).map((call) => ({ toolId: call.toolId, status: call.status === "denied" ? "error" : call.status })),
  };
}

/** A Startup OS test run: one case on one model per action, each result stored, then the next. */
export const test = internalAction({
  args: { run: v.id("agentHarnessRuns"), from: v.number() },
  handler: async (ctx, args) => {
    const found = await ctx.runMutation(internal.agentRuntime.testJob, { run: args.run });
    if (found === null) return;
    const job = JSON.parse(found.text) as TestJob;
    const total = job.cases.length * job.models.length;
    if (args.from >= total) return;
    let result: ResultIn;
    try {
      result = await runCase(job, args.from);
    } catch {
      const testCase = job.cases[Math.floor(args.from / job.models.length)]!;
      const model = job.models[args.from % job.models.length]!;
      result = {
        caseId: testCase.caseId,
        provider: model.provider,
        model: model.model,
        output: null,
        schemaValid: false,
        assertions: testCase.expect.map((_e, index) => ({ index, passed: false })),
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        error: "server",
      };
    }
    const final = args.from + 1 >= total;
    await ctx.runMutation(internal.agentRuntime.testResult, { run: args.run, result: JSON.stringify(result), final });
    if (!final) await ctx.scheduler.runAfter(0, internal.agentRuntime.test, { run: args.run, from: args.from + 1 });
  },
});

// ── Keeping it bounded ──────────────────────────────────────────────────────

/** Answers, finished runs and decided approvals older than ninety days, a batch at a time (a native daily cron). */
export const purge = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RUN_RETENTION_DAYS * DAY_MS;
    let deleted = 0;
    const outputs = await ctx.db
      .query("agentRunOutputs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(PURGE_BATCH);
    for (const row of outputs) await ctx.db.delete(row._id);
    deleted += outputs.length;
    // Only rows that may go are read, so rows still waiting never stand in the way.
    const runs = await ctx.db
      .query("agentRuntimeRuns")
      .withIndex("by_state_and_createdAt", (q) => q.eq("state", "done").lt("createdAt", cutoff))
      .take(PURGE_BATCH);
    for (const row of runs) await ctx.db.delete(row._id);
    deleted += runs.length;
    const decided = [];
    for (const state of ["approved", "denied"] as const) {
      decided.push(
        ...(await ctx.db
          .query("agentApprovals")
          .withIndex("by_state_and_createdAt", (q) => q.eq("state", state).lt("createdAt", cutoff))
          .take(PURGE_BATCH)),
      );
    }
    for (const row of decided) await ctx.db.delete(row._id);
    deleted += decided.length;
    if (outputs.length === PURGE_BATCH || runs.length === PURGE_BATCH || decided.length >= PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.agentRuntime.purge, {});
    }
    return { deleted };
  },
});
