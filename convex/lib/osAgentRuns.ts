// Startup OS's own four agents as harness-managed agents of `startup-os`
// (convex/lib/osAgents.ts): seeding them from their code's defaults, what
// the Mac's runner is handed each run, which tools each may call, and the
// record of each run the Mac makes.
//
// - **Seeded once** (`ensureOsAgents`), as the owner, when an owner has
//   signed in: built here, h1 published from the code's defaults (the text
//   of docs/agents/), a control on the Mac. Never again for one that exists:
//   what the owner changed is kept.
// - **The Mac is handed** each due run (`dueRuns`, the runner's own
//   `os_agents_due`): the published instructions and tools, or the code's
//   defaults when no published version can be read. Only an agent switched
//   on, that runs on the Mac and is not already running; a time is handed
//   out once (`scheduledFor`). A Gemini agent is never handed to the Mac.
//   A run handed out waits (`queued`) until the runner starts it
//   (`startRun`, `os_agent_start`), just before Claude Code: its clock, and
//   the stuck limit, start then, since the runner runs a check's runs one
//   after another.
// - **Which tools a call may use** (`allowlistFor`): a call that names one
//   of the four (the runner's `X-Startup-Agent` header, or an `agent` argument)
//   may use only that agent's tools: those of the version its Mac run is on,
//   else its published version's, else the code's defaults.
// - **A Mac run's record** (`finishRun`): a summary in `agentRuns`, as the
//   Runs tab reads every run, made from the run's own `agentCalls` rows
//   (tool names and outcomes: no argument, no answer).
//
// Runs only inside Convex: never import it from the UI. Nothing here logs.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { commit } from "../agentControl";
import { MAX_TOOL_CALLS_PER_RUN, type AgentRunStatus, type RunErrorClass, type ToolCallStatus } from "./agentBuilder";
import { controlOf, declaredOf, harnessVersionOf, partsOf, publishedVersionOf, writePrompt } from "./agentData";
import { DEFAULT_VARIANT, versionName } from "./agentHarness";
import { MAX_RUNS_PER_DAY, STARTUP_OS_PROJECT } from "./agentStartupOs";
import { AGENT_IDS, AGENT_NAMES, AGENT_OFF, type AgentId } from "./agents";
import { agentsOff, ownerMember } from "./agentStore";
import type { RunnerFailure } from "./chatRules";
import {
  CODE_DEFAULT_VERSION,
  osAgentUserTemplate,
  macDefaultConfig,
  osAgentDefault,
  type MacConfig,
} from "./osAgentDefaults";
import {
  DEFAULT_RUNS_ON,
  MAC_RUN_STUCK_MS,
  MAC_START_WITHIN_MS,
  OS_AGENT_RUN_ORDER,
  OS_AGENT_WORDS,
  macActForbidden,
  macDueAt,
  type RunsOn,
} from "./osAgents";
import type { Member } from "./owner";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * What one check-in hands out at most, in UTF-8 bytes of the runs: under the
 * tool's caps (`os_agents_due`), so a run recorded as running is never cut
 * from the answer. One that does not fit waits for the next check-in.
 */
export const MAX_DUE_BYTES = 180_000;
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** What the seeded h1 says it is, on its Versions tab. */
export const SEEDED_NOTE = "The code's defaults: docs/agents/run.md and this agent's own file.";
/** Why the seeded h1 went live without a test run, as its publish event says. */
export const SEEDED_REASON = "Seeded from the code's defaults (docs/agents/), as the four ran before.";

// ── Seeding ─────────────────────────────────────────────────────────────────

/**
 * Seed each of the four not yet built here: built by the owner, h1 published
 * from its code's defaults, its control on the Mac with its switch as
 * `agentSettings` has it. One that exists is left as the owner made it.
 * Returns the ids seeded.
 */
export async function ensureOsAgents(ctx: MutationCtx, owner: Doc<"users">, now: number): Promise<AgentId[]> {
  const seeded: AgentId[] = [];
  const off = await agentsOff(ctx);
  for (const agent of AGENT_IDS) {
    if ((await declaredOf(ctx, STARTUP_OS_PROJECT, agent)) !== null) continue;
    const { definition, parts } = osAgentDefault(agent);
    await ctx.db.insert("agentDeclared", { project: STARTUP_OS_PROJECT, agentId: agent, createdBy: owner._id, createdAt: now });
    const id = await ctx.db.insert("agentHarnessVersions", {
      project: STARTUP_OS_PROJECT,
      agentId: agent,
      number: 1,
      status: "published",
      revision: 1,
      tools: [...(parts.tools ?? [])],
      definition,
      note: SEEDED_NOTE,
      createdBy: owner._id,
      createdAt: now,
      updatedBy: owner._id,
      updatedAt: now,
      publishedBy: owner._id,
      publishedAt: now,
    });
    await ctx.db.patch(id, await writePrompt(ctx, id, parts.prompt));
    const stored = await controlOf(ctx, STARTUP_OS_PROJECT, agent);
    const configVersion = await commit(
      ctx,
      ownerMember(owner),
      STARTUP_OS_PROJECT,
      stored,
      null,
      {
        agentId: agent,
        name: AGENT_NAMES[agent],
        // The switch is agentSettings'; the control says the same.
        enabled: !off.includes(agent),
        provider: definition.model!.provider,
        model: definition.model!.model,
        fallbackProvider: null,
        fallbackModel: null,
        monthlyBudgetUsd: null,
        promptVersionPin: null,
        harnessVersion: versionName(1),
        runsOn: DEFAULT_RUNS_ON,
        version: stored?.version ?? 0,
      },
      true,
    );
    await ctx.db.insert("agentHarnessEvents", {
      project: STARTUP_OS_PROJECT,
      agentId: agent,
      number: 1,
      action: "publish",
      by: owner._id,
      at: now,
      configVersion,
      override: { reason: SEEDED_REASON },
    });
    seeded.push(agent);
  }
  return seeded;
}

// ── Where each runs, and whether it is on ───────────────────────────────────

/** Where one of the four runs: its control's setting, else the Mac. */
export async function runsOnFor(ctx: QueryCtx, agent: AgentId): Promise<RunsOn> {
  return (await controlOf(ctx, STARTUP_OS_PROJECT, agent))?.runsOn ?? DEFAULT_RUNS_ON;
}

/** Whether one of the four is switched on: `agentSettings` alone says so. */
export async function osAgentOn(ctx: QueryCtx, agent: AgentId): Promise<boolean> {
  return !(await agentsOff(ctx)).includes(agent);
}

// ── What the Mac is handed ──────────────────────────────────────────────────

/** A config and its schedule: what the Mac runs, and when. */
export type MacPlan = MacConfig & { versionNumber: number; cron: string | null };

/**
 * One agent's config at a version: its instructions (the variant `default`),
 * its user turn, its tools and bounds, and its schedule. Null where the
 * version or its prompt cannot be read.
 */
async function planAt(ctx: QueryCtx, agent: AgentId, row: Doc<"agentHarnessVersions"> | null): Promise<MacPlan | null> {
  if (row === null || row.definition === undefined) return null;
  const parts = await partsOf(ctx, row);
  const variant = parts.prompt?.variants[DEFAULT_VARIANT];
  if (variant === undefined || variant.system.trim() === "") return null;
  return {
    agentId: agent,
    version: versionName(row.number),
    versionNumber: row.number,
    instructions: variant.system,
    user: variant.user ?? osAgentUserTemplate(),
    tools: [...(parts.tools ?? [])],
    limits: { maxSteps: row.definition.limits.maxSteps, timeoutMs: row.definition.limits.timeoutMs },
    cron: row.definition.triggers.schedule?.cron ?? null,
  };
}

/** The code's defaults as a plan: version 0, "code default". */
function defaultPlan(agent: AgentId): MacPlan {
  const { definition } = osAgentDefault(agent);
  return { ...macDefaultConfig(agent), versionNumber: 0, cron: definition.triggers.schedule?.cron ?? null };
}

/** What one of the four runs with now: its published version, or the code's defaults when none can be read. */
export async function macPlanOf(ctx: QueryCtx, agent: AgentId): Promise<MacPlan> {
  return (await planAt(ctx, agent, await publishedVersionOf(ctx, STARTUP_OS_PROJECT, agent))) ?? defaultPlan(agent);
}

/** What a run on a version runs with: that version, or the code's defaults for version 0 or one gone. */
async function planOfRun(ctx: QueryCtx, agent: AgentId, versionNumber: number): Promise<MacPlan> {
  if (versionNumber === 0) return defaultPlan(agent);
  return (await planAt(ctx, agent, await harnessVersionOf(ctx, STARTUP_OS_PROJECT, agent, versionNumber))) ?? defaultPlan(agent);
}

/** A run's id: letters, digits and dashes. */
function newRunId(now: number): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `mac-${now.toString(36)}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function runtimeRow(ctx: QueryCtx, runId: string) {
  return await ctx.db
    .query("agentRuntimeRuns")
    .withIndex("by_runId", (q) => q.eq("runId", runId))
    .unique();
}

/** Whether an agent has a run started and not ended, here or on the Mac. */
async function busy(ctx: QueryCtx, agent: AgentId): Promise<boolean> {
  for (const state of ["queued", "running", "awaiting_approval"] as const) {
    const row = await ctx.db
      .query("agentRuntimeRuns")
      .withIndex("by_project_agentId_and_state", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("agentId", agent).eq("state", state))
      .first();
    if (row !== null) return true;
  }
  return false;
}

/** How many runs an agent started from `dayStart` on, read only up to the cap. */
async function runsSince(ctx: QueryCtx, agent: AgentId, dayStart: number): Promise<number> {
  const rows = await ctx.db
    .query("agentRuns")
    .withIndex("by_project_agentId_and_startedAt", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("agentId", agent).gte("startedAt", dayStart))
    .take(MAX_RUNS_PER_DAY);
  return rows.length;
}

/** One run as the Mac is handed it. */
export type MacRun = {
  runId: string;
  agentId: AgentId;
  name: string;
  version: string;
  instructions: string;
  user: string;
  tools: string[];
  limits: { maxSteps: number; timeoutMs: number };
};

/**
 * The runs the Mac should make now, in the order it makes them: each of the
 * four that runs on the Mac, is switched on, is not running, has a schedule
 * due within the catch-up and was not handed out for that time, and has not
 * started its runs for the day. Each is recorded as handed out (`queued`)
 * before it is, so a time is run once. Runs the Mac never started or never
 * finished are ended first.
 */
export async function dueRuns(ctx: MutationCtx, member: Member, now: number): Promise<MacRun[]> {
  await ensureOsAgents(ctx, member.user, now);
  await endStuckMacRuns(ctx, now);
  const off = await agentsOff(ctx);
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const out: MacRun[] = [];
  for (const agent of OS_AGENT_RUN_ORDER) {
    // A Gemini agent is Startup OS's to run, never the Mac's.
    if ((await runsOnFor(ctx, agent)) !== "claude_mac") continue;
    if (off.includes(agent)) continue;
    if (await busy(ctx, agent)) continue;
    const plan = await macPlanOf(ctx, agent);
    if (plan.cron === null) continue;
    const due = macDueAt(plan.cron, now);
    if (due === null) continue;
    const taken = await ctx.db
      .query("agentRuntimeRuns")
      .withIndex("by_project_agentId_and_scheduledFor", (q) =>
        q.eq("project", STARTUP_OS_PROJECT).eq("agentId", agent).eq("scheduledFor", due),
      )
      .first();
    if (taken !== null) continue;
    if ((await runsSince(ctx, agent, dayStart)) >= MAX_RUNS_PER_DAY) continue;
    // What does not fit in this answer waits for the next check-in.
    if (bytesOf(out) + bytesOf(plan) > MAX_DUE_BYTES) break;
    const runId = newRunId(now);
    await ctx.db.insert("agentRuntimeRuns", {
      project: STARTUP_OS_PROJECT,
      runId,
      agentId: agent,
      versionNumber: plan.versionNumber,
      trigger: "schedule",
      // Handed out: running from when the runner starts it (`startRun`).
      state: "queued",
      runner: "mac",
      actAs: member.user._id,
      scheduledFor: due,
      input: "{}",
      createdAt: now,
    });
    out.push({
      runId,
      agentId: agent,
      name: AGENT_NAMES[agent],
      version: plan.version,
      instructions: plan.instructions,
      user: plan.user,
      // Never a tool that changes something at once: nothing on the Mac waits for an approval.
      tools: plan.tools.filter((tool) => !macActForbidden(tool)),
      limits: plan.limits,
    });
  }
  return out;
}

// ── Which tools a call may use ──────────────────────────────────────────────

/** `runId`: the Mac run the call was made in, where it named one that is that agent's and running; a refused call is part of it too. */
export type Allowed =
  | { ok: true; agent: AgentId | null; runId: string | null }
  | { ok: false; words: string; agent: AgentId | null; runId: string | null };

/**
 * Whether a call may use a tool, by the agent it names: the runner's header
 * (`header`), or the call's own `agent` argument (`argument`), which must
 * agree. With a Mac run named, the tools of the version that run is on;
 * else the published version's; else the code's defaults. A call that
 * names no agent is not held here: it keeps what the token may do.
 */
export async function allowlistFor(
  ctx: QueryCtx,
  call: { tool: string; header: AgentId | null; argument: AgentId | null; runId: string | null },
): Promise<Allowed> {
  const agent = call.header ?? call.argument;
  if (agent === null) {
    // A run named with no agent is refused: the runner always sends both.
    return call.runId === null
      ? { ok: true, agent: null, runId: null }
      : { ok: false, words: OS_AGENT_WORDS.runGone, agent: null, runId: null };
  }
  let tools: string[];
  if (call.runId !== null) {
    const run = await runtimeRow(ctx, call.runId);
    if (run === null || run.runner !== "mac" || run.state !== "running" || run.agentId !== agent) {
      return { ok: false, words: OS_AGENT_WORDS.runGone, agent, runId: null };
    }
    tools = (await planOfRun(ctx, agent, run.versionNumber)).tools;
  } else {
    tools = (await macPlanOf(ctx, agent)).tools;
  }
  if (call.header !== null && call.argument !== null && call.header !== call.argument) {
    return { ok: false, words: OS_AGENT_WORDS.wrongAgent, agent, runId: call.runId };
  }
  if (!tools.includes(call.tool)) return { ok: false, words: OS_AGENT_WORDS.notAllowedTool(agent), agent, runId: call.runId };
  // One the owner switched off (`agentSettings`) is refused every call, a read as much as a write:
  // retiring one of the four is this switch, and no call of it is then answered (Bot Loop v3, J).
  if (!(await osAgentOn(ctx, agent))) return { ok: false, words: AGENT_OFF, agent, runId: call.runId };
  // A call made on the Mac (in its run, or by an agent that runs there) never changes something at once.
  if (macActForbidden(call.tool) && (call.runId !== null || (await runsOnFor(ctx, agent)) === "claude_mac")) {
    return { ok: false, words: OS_AGENT_WORDS.macActTool, agent, runId: call.runId };
  }
  return { ok: true, agent, runId: call.runId };
}

// ── A Mac run's record ──────────────────────────────────────────────────────

/** How a run on the Mac ended, as the runner says it: done, or one of the chat runner's closed kinds of failure. */
export type MacOutcome = "done" | RunnerFailure;

const OUTCOME_STATE: Record<MacOutcome, { status: AgentRunStatus; errorClass: RunErrorClass | null }> = {
  done: { status: "ok", errorClass: null },
  tooLong: { status: "timeout", errorClass: "timeout" },
  notSignedIn: { status: "error", errorClass: "auth" },
  usageLimit: { status: "error", errorClass: "rate_limit" },
  notStarted: { status: "error", errorClass: "server" },
  wrong: { status: "error", errorClass: "server" },
};

const CALL_STATUS: Record<Doc<"agentCalls">["outcome"], ToolCallStatus> = {
  ok: "ok",
  error: "error",
  refused: "denied",
  invalid: "error",
};

/** The calls a run made, oldest first, as the Runs tab shows them: a tool's name and how it ended. */
async function callsOf(ctx: QueryCtx, runId: string) {
  const rows = await ctx.db
    .query("agentCalls")
    .withIndex("by_runId", (q) => q.eq("runId", runId))
    .take(MAX_TOOL_CALLS_PER_RUN);
  return rows.sort((a, b) => a.at - b.at).map((row) => ({ toolId: row.tool, status: CALL_STATUS[row.outcome] }));
}

/** End a Mac run: its summary into `agentRuns` and the run marked done. */
async function endMacRun(
  ctx: MutationCtx,
  run: Doc<"agentRuntimeRuns">,
  ended: { status: AgentRunStatus; errorClass: RunErrorClass | null; steps: number | null },
  now: number,
) {
  const startedAt = run.claimedAt ?? run.createdAt;
  const toolCalls = await callsOf(ctx, run.runId);
  const summary = {
    project: STARTUP_OS_PROJECT,
    runId: run.runId,
    agentId: run.agentId,
    version: run.versionNumber === 0 ? CODE_DEFAULT_VERSION : versionName(run.versionNumber),
    trigger: run.trigger,
    status: ended.status,
    startedAt,
    durationMs: Math.max(0, Math.round(now - startedAt)),
    steps: Math.max(0, Math.min(1_000, Math.round(ended.steps ?? toolCalls.length))),
    ...(ended.errorClass === null ? {} : { errorClass: ended.errorClass }),
    toolCalls,
    pendingApprovals: 0,
    runner: "mac" as const,
    receivedAt: now,
  };
  const stored = await ctx.db
    .query("agentRuns")
    .withIndex("by_project_and_runId", (q) => q.eq("project", STARTUP_OS_PROJECT).eq("runId", run.runId))
    .unique();
  if (stored === null) await ctx.db.insert("agentRuns", summary);
  else await ctx.db.replace(stored._id, summary);
  await ctx.db.patch(run._id, { state: "done", finishedAt: now });
}

/** The runner starts a run it was handed, just before Claude Code: its clock starts now. Once; refused for any other run. */
export async function startRun(ctx: MutationCtx, args: { runId: string }, now: number): Promise<{ ok: true }> {
  const run = await runtimeRow(ctx, args.runId);
  if (run === null || run.runner !== "mac" || run.state !== "queued") throw new ConvexError(OS_AGENT_WORDS.runGone);
  await ctx.db.patch(run._id, { state: "running", claimedAt: now });
  return { ok: true };
}

/** The runner's last word on a run it made: how it ended and how many turns it took. Refused for a run it is not making. */
export async function finishRun(
  ctx: MutationCtx,
  args: { runId: string; outcome: MacOutcome; turns?: number },
  now: number,
): Promise<{ ok: true }> {
  const run = await runtimeRow(ctx, args.runId);
  if (run === null || run.runner !== "mac" || run.state !== "running") throw new ConvexError(OS_AGENT_WORDS.runGone);
  await endMacRun(ctx, run, { ...OUTCOME_STATE[args.outcome], steps: args.turns ?? null }, now);
  return { ok: true };
}

/**
 * Mac runs started and never finished (the Mac slept, the runner stopped),
 * past the stuck limit from their own start, and runs handed out and never
 * started within the hour: ended as timed out.
 */
export async function endStuckMacRuns(ctx: MutationCtx, now: number) {
  const running = await ctx.db
    .query("agentRuntimeRuns")
    .withIndex("by_state_and_createdAt", (q) => q.eq("state", "running"))
    .take(50);
  for (const run of running) {
    if (run.runner !== "mac" || (run.claimedAt ?? run.createdAt) > now - MAC_RUN_STUCK_MS) continue;
    await endMacRun(ctx, run, { status: "timeout", errorClass: "timeout", steps: null }, now);
  }
  const waiting = await ctx.db
    .query("agentRuntimeRuns")
    .withIndex("by_state_and_createdAt", (q) => q.eq("state", "queued").lt("createdAt", now - MAC_START_WITHIN_MS))
    .take(50);
  for (const run of waiting) {
    if (run.runner !== "mac") continue;
    await endMacRun(ctx, run, { status: "timeout", errorClass: "timeout", steps: null }, now);
  }
}

/** For a test and the runtime's tick: whether a run is the Mac's. */
export const isMacRun = (run: { runner?: "mac" }): boolean => run.runner === "mac";

