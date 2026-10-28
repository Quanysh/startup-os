import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireOsAgentOwner, steerable } from "./agentControl";
import { AGENT_ID_PATTERN, isKnownProvider } from "./lib/agentControl";
import {
  AGENT_RUN_STATUSES,
  BUILDER_WORDS,
  MAX_DESCRIPTION,
  MAX_GREETING,
  MAX_SCHEDULE_VALUE,
  MIN_RUNS_HERE_GAP_MINUTES,
  RUN_TRIGGERS,
  defaultModelFor,
  newDefinition,
  newPrompt,
  type Definition,
} from "./lib/agentBuilder";
import { builderContextOf, builderPolicyOf, builderToolsOf, mayReadOutput, requireRunsReader } from "./lib/agentBuilt";
import { MAX_CRON_LENGTH, minGapMinutes } from "./lib/agentCron";
import {
  catalogOf,
  controlOf,
  declaredIn,
  declaredOf,
  lastSeen,
  partsOf,
  providersOf,
  publishedVersionOf,
  writePrompt,
  type ProjectPolicy,
} from "./lib/agentData";
import {
  MAX_HARNESS_BYTES,
  MAX_NOTE_LENGTH,
  MAX_SCHEMA_BYTES,
  MAX_TEMPLATE_BYTES,
  MAX_TOOLS,
  MAX_VARIABLES,
  MAX_VARIANTS,
  VARIABLE_NAME_PATTERN,
  VARIANT_NAME_PATTERN,
  cleanParams,
  promptPartOf,
  type HarnessParts,
} from "./lib/agentHarness";
import { AGENT_NAME_PATTERN, MAX_AGENTS_PER_PROJECT, providerPolicyProblem } from "./lib/agentProjects";
import { STARTUP_OS_MODELS, STARTUP_OS_PROJECT, STARTUP_OS_PROVIDERS } from "./lib/agentStartupOs";
import { stableStringify, utf8Bytes } from "./lib/agentSchemaCompat";
import { configuredProviders } from "./lib/modelClients";
import { OS_AGENT_WORDS, isOsAgent, macActForbidden, runsOnOf } from "./lib/osAgents";
import { isOwner, memberMutation, memberQuery, type Member } from "./lib/owner";
import { definitionValidator, harnessParamsValidator, variantsValidator } from "./schema";

// Agents built here, from scratch (Agents Protocol v1.3, docs/agents-protocol.md;
// the rules are convex/lib/agentBuilder.ts): creating one in a project (or in
// Startup OS itself, the project `startup-os`), saving its draft definition, what
// the builder offers (the project's tools, its other built agents, the models
// it may run on), its runs as the project reported them, and a project's tool
// catalogue. A draft is tested and published through convex/agentHarness.ts,
// as any agent's harness is: its definition rides on the version.
//
// The `agents` area's, on no company. Publishing is the owner's and the
// engineers' (convex/agentHarness.ts), an agent using a tool of an owner-only
// page the owner's alone, and that agent's runs are the owner's alone too.
// Nothing here calls a model: Startup OS's own runtime is a follow-up.

export const BUILDER_ACTION_WORDS = {
  noAgent: "There is no agent built here by that id in this project.",
  notBuilt: "That agent is in its project's code: change it on its Harness tab.",
  notDraft: "Only a draft can be changed.",
  stale: "The draft changed since it was opened. Reload it and try again.",
  note: `A note is at most ${MAX_NOTE_LENGTH} characters.`,
  tooBig: `A template is at most 128 KB, a schema 64 KB and the whole 512 KB, with at most ${MAX_VARIANTS} variants, ${MAX_VARIABLES} variables and ${MAX_TOOLS} tools.`,
  variantName: "A variant's name is a lowercase letter, then up to 31 of a-z, 0-9 and _.",
  tooMany: `A project has at most ${MAX_AGENTS_PER_PROJECT} agents built here.`,
} as const;

/** The project an agent may be built in: a connected one, or Startup OS itself. */
async function buildable(ctx: QueryCtx, project: string): Promise<ProjectPolicy> {
  if (project === STARTUP_OS_PROJECT) return (await builderPolicyOf(ctx, project))!;
  return await steerable(ctx, project);
}

/** Whether an agent id is already used in a project: built here, launched, reported or run. */
async function idTaken(ctx: QueryCtx, project: string, agentId: string): Promise<boolean> {
  if ((await declaredOf(ctx, project, agentId)) !== null) return true;
  if ((await controlOf(ctx, project, agentId)) !== null) return true;
  if ((await catalogOf(ctx, project)).some((entry) => entry.agentId === agentId)) return true;
  return (await lastSeen(ctx, project, agentId)) !== null;
}

const modelArg = v.object({
  provider: v.string(),
  model: v.string(),
  fallbackProvider: v.optional(v.string()),
  fallbackModel: v.optional(v.string()),
});

/**
 * Create an agent from scratch: its id, name, description and what it takes
 * (variables, or a conversation). It is a draft (h1, revision 1) with an empty
 * prompt to write, an API endpoint on and the usual limits, on the model the
 * project starts new agents on (DEFAULT_BUILDER_MODEL where it may use it;
 * none for a project that holds patient data) or the one chosen.
 */
export const create = memberMutation("agents")({
  args: {
    project: v.string(),
    agentId: v.string(),
    name: v.string(),
    description: v.string(),
    mode: v.union(v.literal("text"), v.literal("messages")),
    model: v.optional(v.union(modelArg, v.null())),
  },
  handler: async (ctx, args) => {
    const policy = await buildable(ctx, args.project);
    if (!AGENT_ID_PATTERN.test(args.agentId)) throw new ConvexError(BUILDER_WORDS.agentId);
    // Startup OS's own four are seeded from their code's defaults, never made here.
    if (isOsAgent(args.project, args.agentId)) throw new ConvexError(OS_AGENT_WORDS.reserved);
    const name = args.name.trim();
    if (!AGENT_NAME_PATTERN.test(name)) throw new ConvexError(BUILDER_WORDS.name);
    const description = args.description.trim();
    if (description.length === 0 || description.length > MAX_DESCRIPTION) throw new ConvexError(BUILDER_WORDS.description);
    if (await idTaken(ctx, args.project, args.agentId)) throw new ConvexError(BUILDER_WORDS.taken);
    if ((await declaredIn(ctx, args.project)).length >= MAX_AGENTS_PER_PROJECT) {
      throw new ConvexError(BUILDER_ACTION_WORDS.tooMany);
    }
    const chosen = args.model === undefined ? defaultModelFor(policy) : (args.model ?? undefined);
    if (chosen !== undefined) {
      const problem = providerPolicyProblem(chosen.provider, policy, false);
      if (problem !== null) throw new ConvexError(problem);
    }
    const definition: Definition = {
      ...newDefinition({ name, description, mode: args.mode }),
      ...(chosen === undefined ? {} : { model: chosen }),
    };
    const now = Date.now();
    await ctx.db.insert("agentDeclared", {
      project: args.project,
      agentId: args.agentId,
      createdBy: ctx.member.user._id,
      createdAt: now,
    });
    const id = await ctx.db.insert("agentHarnessVersions", {
      project: args.project,
      agentId: args.agentId,
      number: 1,
      status: "draft",
      revision: 1,
      tools: [],
      definition,
      note: "",
      createdBy: ctx.member.user._id,
      createdAt: now,
      updatedBy: ctx.member.user._id,
      updatedAt: now,
    });
    await ctx.db.patch(id, await writePrompt(ctx, id, newPrompt(args.mode)));
    return { id, project: args.project, agentId: args.agentId };
  },
});

/** A definition's sizes, before it is stored: the rules say the rest, as it is typed. */
function sizeProblem(definition: Definition): string | null {
  if (definition.name.length > 200 || definition.description.length > MAX_DESCRIPTION * 2) return BUILDER_WORDS.description;
  const variables = definition.input.variables;
  if (variables.length > MAX_VARIABLES) return BUILDER_ACTION_WORDS.tooBig;
  if (variables.some((variable) => !VARIABLE_NAME_PATTERN.test(variable.name))) return BUILDER_WORDS.variableName;
  if (definition.approvals.length > MAX_TOOLS) return BUILDER_ACTION_WORDS.tooBig;
  const schedule = definition.triggers.schedule;
  if (schedule !== undefined) {
    if (schedule.cron.length > MAX_CRON_LENGTH * 2) return BUILDER_ACTION_WORDS.tooBig;
    // A name is checked before it is a key in a stored row.
    if (Object.keys(schedule.variables).some((name) => !VARIABLE_NAME_PATTERN.test(name))) return BUILDER_WORDS.variableName;
    if (Object.keys(schedule.variables).length > MAX_VARIABLES) return BUILDER_ACTION_WORDS.tooBig;
    if (Object.values(schedule.variables).some((value) => value.length > MAX_SCHEDULE_VALUE)) return BUILDER_WORDS.scheduleValue;
  }
  const sub = definition.triggers.subAgent;
  if (sub !== undefined && (sub.toolId.length > 64 || sub.description.length > MAX_DESCRIPTION * 2)) {
    return BUILDER_WORDS.exposureDescription;
  }
  const chat = definition.triggers.chat;
  if (chat !== undefined && (chat.title.length > 200 || chat.greeting.length > MAX_GREETING * 2)) return BUILDER_WORDS.chatGreeting;
  const model = definition.model;
  if (model !== undefined && [model.provider, model.model, model.fallbackProvider ?? "", model.fallbackModel ?? ""].some((s) => s.length > 100)) {
    return BUILDER_ACTION_WORDS.tooBig;
  }
  return null;
}

/**
 * Save an agent's draft as the builder shows it: its definition and every
 * part (an agent built here keeps them all: there is no code's default).
 * `revision` is the one the builder opened; a change makes a new revision,
 * which needs its own test run. Problems are shown, not refused: the rules
 * are asked before a test run and a publish.
 */
export const saveDefinition = memberMutation("agents")({
  args: {
    id: v.id("agentHarnessVersions"),
    revision: v.number(),
    definition: definitionValidator,
    prompt: v.object({ variants: variantsValidator }),
    params: v.union(harnessParamsValidator, v.null()),
    tools: v.array(v.string()),
    outputSchema: v.union(v.string(), v.null()),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null || row.definition === undefined) throw new ConvexError(BUILDER_ACTION_WORDS.noAgent);
    requireOsAgentOwner(ctx.member, row.project, row.agentId);
    if (row.status !== "draft") throw new ConvexError(BUILDER_ACTION_WORDS.notDraft);
    if (row.revision !== args.revision) throw new ConvexError(BUILDER_ACTION_WORDS.stale);
    const note = args.note.trim();
    if (note.length > MAX_NOTE_LENGTH) throw new ConvexError(BUILDER_ACTION_WORDS.note);
    const prompt = promptPartOf(args.prompt);
    const names = Object.keys(prompt.variants);
    if (names.some((name) => !VARIANT_NAME_PATTERN.test(name))) throw new ConvexError(BUILDER_ACTION_WORDS.variantName);
    const templates = Object.values(prompt.variants).flatMap((t) => [t.system, t.user ?? ""]);
    if (
      names.length > MAX_VARIANTS ||
      templates.some((text) => utf8Bytes(text) > MAX_TEMPLATE_BYTES) ||
      (args.outputSchema !== null && utf8Bytes(args.outputSchema) > MAX_SCHEMA_BYTES) ||
      args.tools.length > MAX_TOOLS ||
      args.tools.some((id) => id.length > 64)
    ) {
      throw new ConvexError(BUILDER_ACTION_WORDS.tooBig);
    }
    const size = sizeProblem(args.definition);
    if (size !== null) throw new ConvexError(size);
    // One of the four on the Mac: nothing there waits for an approval, so no act tool but proposing and the brief.
    if (
      runsOnOf(row.project, row.agentId, (await controlOf(ctx, row.project, row.agentId))?.runsOn) === "claude_mac" &&
      args.tools.some(macActForbidden)
    ) {
      throw new ConvexError(OS_AGENT_WORDS.macActTool);
    }
    // Startup OS's own agents have no chat box: the chat is the one on /assistant.
    if (row.project === STARTUP_OS_PROJECT && args.definition.triggers.chat?.enabled === true) {
      throw new ConvexError(BUILDER_WORDS.chatRunsHere);
    }
    // Each scheduled run of a Startup OS agent calls a model: no more often than every five minutes.
    const cron = args.definition.triggers.schedule?.cron;
    if (row.project === STARTUP_OS_PROJECT && cron !== undefined && (minGapMinutes(cron) ?? MIN_RUNS_HERE_GAP_MINUTES) < MIN_RUNS_HERE_GAP_MINUTES) {
      throw new ConvexError(BUILDER_WORDS.scheduleTooOften);
    }
    const parts: HarnessParts = {
      prompt,
      ...(args.params === null ? {} : { params: cleanParams(args.params) }),
      tools: [...new Set(args.tools)],
      ...(args.outputSchema === null || args.outputSchema.trim() === "" ? {} : { outputSchema: args.outputSchema }),
    };
    if (utf8Bytes(JSON.stringify({ parts, definition: args.definition })) > MAX_HARNESS_BYTES) {
      throw new ConvexError(BUILDER_ACTION_WORDS.tooBig);
    }
    const before = { parts: await partsOf(ctx, row), definition: row.definition };
    const changed = stableStringify({ parts, definition: args.definition }) !== stableStringify(before);
    const revision = changed ? row.revision + 1 : row.revision;
    const { prompt: promptPart, ...rest } = parts;
    const promptFields = await writePrompt(ctx, row._id, promptPart);
    await ctx.db.replace(row._id, {
      project: row.project,
      agentId: row.agentId,
      number: row.number,
      status: row.status,
      revision,
      ...rest,
      ...promptFields,
      ...(row.basedOn === undefined ? {} : { basedOn: row.basedOn }),
      definition: args.definition,
      note,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedBy: ctx.member.user._id,
      updatedAt: Date.now(),
    });
    return { revision, changed };
  },
});

/** An agent built here in its project, or a refusal in fixed words. */
async function builtAgent(ctx: QueryCtx, project: string, agentId: string) {
  const policy = await buildable(ctx, project);
  const declared = await declaredOf(ctx, project, agentId);
  if (declared === null) throw new ConvexError(BUILDER_ACTION_WORDS.noAgent);
  return { policy, declared };
}

/** The models the builder offers: the project's, last seen up and allowed; Startup OS's own, configured or not. */
async function modelChoices(ctx: QueryCtx, policy: ProjectPolicy) {
  if (policy.slug === STARTUP_OS_PROJECT) {
    const configured = configuredProviders();
    return {
      pairs: STARTUP_OS_PROVIDERS.flatMap((provider) =>
        (STARTUP_OS_MODELS[provider] ?? []).map((model) => ({ provider, model, patientData: false })),
      ),
      providers: STARTUP_OS_PROVIDERS.map((provider) => ({ provider, configured: configured[provider] === true })),
    };
  }
  const pairs = (await providersOf(ctx, policy.slug))
    .filter((p) => p.state === "up" && isKnownProvider(p.provider) && providerPolicyProblem(p.provider, policy, false) === null)
    .map((p) => ({ provider: p.provider, model: p.model, patientData: providerPolicyProblem(p.provider, policy, true) === null }));
  return { pairs, providers: policy.allowedProviders.map((provider) => ({ provider, configured: null as boolean | null })) };
}

/**
 * What the builder offers an agent built here: its project's tools (Startup
 * OS's own for `startup-os`, each with its area), the project's other built
 * agents (each one published and offered as a sub-agent may be called), and
 * the models it may run on. The draft itself is `agentHarness.harness`'s.
 */
export const builder = memberQuery("agents")({
  args: { project: v.string(), agentId: v.string() },
  handler: async (ctx, args) => {
    requireOsAgentOwner(ctx.member, args.project, args.agentId);
    const { policy } = await builtAgent(ctx, args.project, args.agentId);
    const context = await builderContextOf(ctx, policy, args.agentId, { publishing: false });
    const models = await modelChoices(ctx, policy);
    return {
      project: {
        slug: policy.slug,
        name: policy.name,
        holdsPatientData: policy.holdsPatientData,
        allowedProviders: policy.allowedProviders,
        runsHere: policy.slug === STARTUP_OS_PROJECT,
      },
      tools: context.catalog.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        phi: tool.phi,
        kind: tool.kind,
        effect: tool.effect,
        approvable: tool.approvable,
        area: tool.area ?? null,
      })),
      peers: context.peers.map((peer) => ({
        agentId: peer.agentId,
        name: peer.name,
        toolId: peer.toolId,
        description: peer.description,
        tools: peer.tools,
      })),
      publishedToolId: context.publishedToolId,
      ...models,
      isOwner: isOwner(ctx.member),
      /** One of the four on the Mac: no act tool but proposing and the brief (OS_AGENT_WORDS.macActTool). */
      macRun: context.macRun === true,
    };
  },
});

/** Whether a member may read a Startup OS run's answer: there is one, and what was decided when it was kept lets them. */
async function answerReadable(ctx: QueryCtx, member: Member, project: string, runId: string): Promise<boolean> {
  if (project !== STARTUP_OS_PROJECT) return false;
  const kept = await ctx.db
    .query("agentRunOutputs")
    .withIndex("by_project_and_runId", (q) => q.eq("project", project).eq("runId", runId))
    .unique();
  return kept !== null && mayReadOutput(member, kept);
}

/** How many runs the Runs tab reads, newest first, before it filters. */
const RUNS_READ = 500;
/** How many it shows. */
const RUNS_SHOWN = 200;
/** How many child runs each run shows. */
const CHILDREN_SHOWN = 30;

/** The proposals a run made: its `propose` calls that went through (each stored one for the owner to decide). */
const proposalsOf = (run: Doc<"agentRuns">) => run.toolCalls.filter((call) => call.toolId === "propose" && call.status === "ok").length;

const runView = (run: Doc<"agentRuns">) => ({
  runId: run.runId,
  agentId: run.agentId,
  version: run.version,
  trigger: run.trigger,
  parentRunId: run.parentRunId ?? null,
  status: run.status,
  startedAt: run.startedAt,
  durationMs: run.durationMs,
  steps: run.steps,
  costUsd: run.costUsd ?? null,
  errorClass: run.errorClass ?? null,
  toolCalls: run.toolCalls,
  pendingApprovals: run.pendingApprovals,
  /** Who ran it: the runner on the owner's Mac (Claude), or where its project or Startup OS ran it. */
  runner: run.runner === "mac" ? ("mac" as const) : null,
  /** Startup OS's own runs: how many proposals it made; null for a project's run (its tools are not Startup OS's). */
  proposals: run.project === STARTUP_OS_PROJECT ? proposalsOf(run) : null,
});

/**
 * An agent's runs, as its project reported them (newest first, filtered by
 * state and how it was started), each with the runs it started as sub-agent
 * calls, and how many of its tool calls wait on a human. Ids, states and
 * numbers only. A Startup OS agent using an owner-only tool: the owner's alone.
 */
export const runs = memberQuery("agents")({
  args: {
    project: v.string(),
    agentId: v.string(),
    status: v.optional(v.union(...AGENT_RUN_STATUSES.map((s) => v.literal(s)))),
    trigger: v.optional(v.union(...RUN_TRIGGERS.map((t) => v.literal(t)))),
  },
  handler: async (ctx, args) => {
    requireOsAgentOwner(ctx.member, args.project, args.agentId);
    const policy = await buildable(ctx, args.project);
    await requireRunsReader(ctx, ctx.member, policy.slug, args.agentId);
    const newest = await ctx.db
      .query("agentRuns")
      .withIndex("by_project_agentId_and_startedAt", (q) => q.eq("project", args.project).eq("agentId", args.agentId))
      .order("desc")
      .take(RUNS_READ);
    const shown = newest
      .filter((run) => (args.status === undefined || run.status === args.status) && (args.trigger === undefined || run.trigger === args.trigger))
      .slice(0, RUNS_SHOWN);
    const out = [];
    for (const run of shown) {
      const children = await ctx.db
        .query("agentRuns")
        .withIndex("by_project_and_parentRunId", (q) => q.eq("project", args.project).eq("parentRunId", run.runId))
        .take(CHILDREN_SHOWN);
      const kids = [];
      for (const child of children.sort((a, b) => a.startedAt - b.startedAt)) {
        kids.push({ ...runView(child), answer: await answerReadable(ctx, ctx.member, args.project, child.runId) });
      }
      out.push({ ...runView(run), answer: await answerReadable(ctx, ctx.member, args.project, run.runId), children: kids });
    }
    const waiting = await ctx.db
      .query("agentRuns")
      .withIndex("by_project_agentId_and_status", (q) =>
        q.eq("project", args.project).eq("agentId", args.agentId).eq("status", "awaiting_approval"),
      )
      .take(RUNS_READ);
    return {
      runs: out,
      /** Startup OS runs it: its runs start here, and their answers are kept here. */
      runsHere: policy.slug === STARTUP_OS_PROJECT,
      /** Tool calls waiting on a human, over every run waiting on one. */
      pendingApprovals: waiting.reduce((sum, run) => sum + run.pendingApprovals, 0),
      runsWaiting: waiting.length,
      /** The runs read before filtering; RUNS_READ at most. */
      read: newest.length,
    };
  },
});

/**
 * A project's tool catalogue (Startup OS's own for `startup-os`): each tool,
 * read or write, for patient data or not, whether it may ask for approval,
 * its input schema, and the agents built here whose published version uses it.
 */
export const tools = memberQuery("agents")({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    const policy = await buildable(ctx, args.project);
    const catalog = await builderToolsOf(ctx, policy.slug);
    const usedBy = new Map<string, string[]>();
    for (const row of await declaredIn(ctx, policy.slug)) {
      // Startup OS's own four are the owner's: nobody else is told what they use.
      if (isOsAgent(policy.slug, row.agentId) && !isOwner(ctx.member)) continue;
      const published = await publishedVersionOf(ctx, policy.slug, row.agentId);
      for (const id of published?.tools ?? []) usedBy.set(id, [...(usedBy.get(id) ?? []), row.agentId]);
    }
    return {
      runsHere: policy.slug === STARTUP_OS_PROJECT,
      tools: catalog.map((tool) => ({ ...tool, area: tool.area ?? null, usedBy: usedBy.get(tool.id) ?? [] })),
    };
  },
});
