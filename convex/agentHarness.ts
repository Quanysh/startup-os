import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { commit, desiredOf, requireOsAgentOwner, steerable, whoOf } from "./agentControl";
import { OS_AGENT_WORDS, runsOnOf } from "./lib/osAgents";
import { MODEL_PATTERN, isKnownProvider, type Control, type ModelPair } from "./lib/agentControl";
import { declarativeProblems, definitionOut, type BuilderContext, type ConfigDefinition, type Definition } from "./lib/agentBuilder";
import { builderContextOf, builderPolicyOf, defaultsFor, ownerOnlyRuns, requireRunsReader } from "./lib/agentBuilt";
import { STARTUP_OS_MODELS, STARTUP_OS_PROJECT, STARTUP_OS_PROVIDERS, RUNTIME_ACTION_WORDS } from "./lib/agentStartupOs";
import { configuredProviders } from "./lib/modelClients";
import {
  agentPhi,
  asControl,
  catalogOf,
  controlOf,
  declaredOf,
  harnessDefaultsOf,
  lastSeen,
  partsOf,
  promptVariantsOf,
  providersOf,
  shallowPartsOf,
  writePrompt,
} from "./lib/agentData";
import {
  DEFAULT_VARIANT,
  MAX_HARNESS_BYTES,
  MAX_NOTE_LENGTH,
  MAX_SCHEMA_BYTES,
  MAX_TEMPLATE_BYTES,
  MAX_TOOLS,
  MAX_VARIANTS,
  VARIANT_NAME_PATTERN,
  VERSIONS_SHOWN,
  codeVariantsOf,
  draftVersionName,
  effectiveOf,
  harnessProblems,
  inputOf,
  jobHarnessOf,
  partsAgainst,
  patientDataOnly,
  promptPartOf,
  providerToolsOf,
  usesPhiTool,
  variantNames,
  versionName,
  type HarnessDefaults,
  type HarnessParts,
  type Issue,
} from "./lib/agentHarness";
import {
  GATE_WORDS,
  LEASE_MS,
  MAX_CASES,
  MAX_JOBS_PER_POLL,
  MAX_RUN_MODELS,
  RESULT_ERRORS,
  RUNS_SHOWN,
  caseAgentProblems,
  caseFitProblems,
  caseProblems,
  gateOf,
  jobCaseOf,
  leaseOf,
  resultPassed,
  type GateState,
  type JobCase,
} from "./lib/agentJobs";
import { INTERNAL_PROJECT, PROJECT_WORDS, providerPolicyProblem } from "./lib/agentProjects";
import { isOwner, memberMutation, memberQuery, NOT_ALLOWED, type Member } from "./lib/owner";
import { projectHolding } from "./lib/projectToken";
import { stableStringify } from "./lib/agentSchemaCompat";
import { may } from "./lib/roles";
import { assertionValidator, caseMessagesValidator, harnessParamsValidator, variantsValidator } from "./schema";

// An agent's harness, managed from the OS (Agents Protocol v1.1,
// docs/agents-protocol.md): its prompt templates, model parameters, tools
// and output schema. Changes go live draft → test → publish: a draft is
// edited, tested through the project on made-up cases, and published as a
// new version of the project's config; rolling back publishes an older
// version again. Every version is kept, with who made and published it.
//
// The rules are convex/lib/agentHarness.ts and convex/lib/agentJobs.ts,
// pure. The `agents` area views and edits drafts, cases and runs; publishing
// and rolling back is the owner's and engineers' (`mayPublish`); publishing
// past a failed or missing test run is the owner's alone, with a reason.
//
// The agents run inside their project, and patient data never reaches the
// OS: a prompt here is a template, a test case is made-up data, and a
// result is a model's answer to it.

export const HARNESS_ACTION_WORDS = {
  noAgent: "There is no agent by that id in this project.",
  noVersion: "There is no such version.",
  draftOpen: "This agent already has a draft. Open it, or discard it first.",
  noPublished: "Nothing is published yet: start from the code's defaults.",
  notDraft: "Only a draft can be changed, tested or published.",
  stale: "The draft changed since it was opened. Reload it and try again.",
  note: `A note is at most ${MAX_NOTE_LENGTH} characters.`,
  tooBig: `A template is at most 128 KB, a schema 64 KB and a harness 512 KB as a whole, with at most ${MAX_VARIANTS} variants and 40 tools.`,
  variantName: "A variant's name is a lowercase letter, then up to 31 of a-z, 0-9 and _.",
  unlaunched: "This agent has no model yet: launch it, or wait for its project to report it, before publishing.",
  notRollback: "Only a version that was published before can be rolled back to.",
  overrideOwner: "Only the owner can publish without a passing test run.",
  overrideReason: `Say why it is published without a passing test run, in at most ${MAX_NOTE_LENGTH} characters.`,
  models: `Choose 1 to ${MAX_RUN_MODELS} models, each once.`,
  model: "Choose models its project last saw up, on providers it may use for this agent.",
  cases: `Choose 1 to ${MAX_CASES} of its test cases, each once.`,
  runOpen: "A test run of this draft as it is now is already waiting for its project.",
  noCase: "There is no such test case.",
  builtModel: "Choose a model id of letters, digits and . _ : / -, on a provider this project may use.",
  subAgents: "A test job carries at most 20 sub-agents: this agent calls more, however deep.",
} as const;

// ── Who may publish ──────────────────────────────────────────────────────────

/**
 * Publishing and rolling back go live in a project, so they are the owner's
 * and the engineers': the owner, or a teammate with both `agents` and
 * `engineering` (the engineer's starting pages; a co-founder starts with both
 * too). Asked by area, never by role.
 */
export const mayPublish = (member: Member): boolean => isOwner(member) || may(member, "engineering");

function requirePublisher(member: Member) {
  if (!mayPublish(member)) throw new ConvexError(NOT_ALLOWED);
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The most sub-agents one test job carries (the package's bound). */
const MAX_JOB_SUB_AGENTS = 20;

/** An agent built here, as one of its versions has it: its definition, parts, and what they are checked against. */
type Built = {
  row: Doc<"agentHarnessVersions">;
  definition: Definition;
  parts: HarnessParts;
  context: BuilderContext;
  defaults: HarnessDefaults;
};

/** The newest version of an agent, whatever its state. */
async function newestVersion(ctx: QueryCtx, project: string, agentId: string) {
  return await ctx.db
    .query("agentHarnessVersions")
    .withIndex("by_project_agentId_and_number", (q) => q.eq("project", project).eq("agentId", agentId))
    .order("desc")
    .first();
}

/** A version of an agent built here, read with what the rules need. */
async function builtOf(
  ctx: QueryCtx,
  policy: Awaited<ReturnType<typeof steerable>>,
  row: Doc<"agentHarnessVersions">,
  options: { publishing: boolean; ownerPublishing?: boolean } = { publishing: false },
): Promise<Built | null> {
  if (row.definition === undefined) return null;
  const parts = await partsOf(ctx, row);
  const context = await builderContextOf(ctx, policy, row.agentId, options);
  return { row, definition: row.definition, parts, context, defaults: defaultsFor(row.definition, parts, context) };
}

/** The control an agent built here and never published would have: its definition's model. */
function controlFromDefinition(agentId: string, definition: Definition): Control | null {
  const model = definition.model;
  if (model === undefined) return null;
  return {
    agentId,
    name: definition.name,
    enabled: true,
    provider: model.provider,
    model: model.model,
    fallbackProvider: model.fallbackProvider ?? null,
    fallbackModel: model.fallbackModel ?? null,
    monthlyBudgetUsd: definition.limits.monthlyBudgetUsd ?? null,
    promptVersionPin: null,
    harnessVersion: null,
    version: 0,
  };
}

/** The agent in its project, or a refusal: one its project reported, launched or ran, or one built here. */
async function agentIn(ctx: QueryCtx, project: string, agentId: string) {
  const declared = await declaredOf(ctx, project, agentId);
  if (project === INTERNAL_PROJECT && declared === null) throw new ConvexError(PROJECT_WORDS.internal);
  const policy = declared === null ? await steerable(ctx, project) : await builderPolicyOf(ctx, project);
  if (policy === null) throw new ConvexError(PROJECT_WORDS.noSuch);
  const control = await controlOf(ctx, project, agentId);
  const seen = control === null && declared === null ? await lastSeen(ctx, project, agentId) : null;
  const entry = (await catalogOf(ctx, project)).find((row) => row.agentId === agentId) ?? null;
  if (control === null && seen === null && entry === null && declared === null) {
    throw new ConvexError(HARNESS_ACTION_WORDS.noAgent);
  }
  if (declared !== null) {
    const base =
      (await withStatus(ctx, project, agentId, "draft")) ??
      (await withStatus(ctx, project, agentId, "published")) ??
      (await newestVersion(ctx, project, agentId));
    const built = base === null ? null : await builtOf(ctx, policy, base);
    const current = control !== null ? asControl(control) : built === null ? null : controlFromDefinition(agentId, built.definition);
    return { policy, control, current, entry, defaults: built?.defaults ?? null, built };
  }
  const current: Control | null =
    control !== null
      ? asControl(control)
      : seen !== null
        ? {
            agentId,
            enabled: true,
            provider: seen.provider,
            model: seen.model,
            fallbackProvider: null,
            fallbackModel: null,
            monthlyBudgetUsd: null,
            promptVersionPin: null,
            harnessVersion: null,
            version: 0,
          }
        : null;
  const defaults = await harnessDefaultsOf(ctx, project, agentId);
  return { policy, control, current, entry, defaults, built: null as Built | null };
}

/** A built version's rules: to test it, or (`publishing`, with who publishes) to put it live. */
function builtProblems(built: Built): Issue[] {
  return declarativeProblems(built.definition, built.parts, built.context);
}

/** Whether a built agent's model is one it may run on: well-formed, on a provider its project may use. */
function builtModelProblem(definition: Definition): string | null {
  const model = definition.model;
  if (model === undefined) return null;
  const ids = [model.model, ...(model.fallbackModel === undefined ? [] : [model.fallbackModel])];
  return ids.every((id) => MODEL_PATTERN.test(id)) ? null : HARNESS_ACTION_WORDS.builtModel;
}

/**
 * The published agents built here that a version calls, however deep: each
 * as the config carries it, so a test job runs them as they would run.
 */
async function subAgentsOf(ctx: QueryCtx, built: Built) {
  const peers = new Map(built.context.peers.filter((p) => p.toolId !== null).map((p) => [p.toolId!, p]));
  const out: { agentId: string; definition: ConfigDefinition }[] = [];
  const seen = new Set<string>([built.row.agentId]);
  const queue = [...(built.parts.tools ?? [])];
  while (queue.length > 0) {
    const peer = peers.get(queue.shift()!);
    if (peer === undefined || seen.has(peer.agentId)) continue;
    seen.add(peer.agentId);
    const published = await withStatus(ctx, built.row.project, peer.agentId, "published");
    if (published?.definition === undefined) continue;
    const parts = await partsOf(ctx, published);
    out.push({ agentId: peer.agentId, definition: definitionOut(published.number, published.definition, parts) });
    queue.push(...(parts.tools ?? []));
  }
  return out;
}

/** Whether the agent runs only on providers for patient data (fallback included); false with no model yet. */
const patientProvidersOf = (current: Control | null) =>
  current !== null && patientDataOnly(current.provider, current.fallbackProvider);

async function versionsOf(ctx: QueryCtx, project: string, agentId: string) {
  return await ctx.db
    .query("agentHarnessVersions")
    .withIndex("by_project_agentId_and_number", (q) => q.eq("project", project).eq("agentId", agentId))
    .order("desc")
    .take(VERSIONS_SHOWN);
}

async function withStatus(ctx: QueryCtx, project: string, agentId: string, status: "draft" | "published") {
  return await ctx.db
    .query("agentHarnessVersions")
    .withIndex("by_project_agentId_and_status", (q) =>
      q.eq("project", project).eq("agentId", agentId).eq("status", status),
    )
    .first();
}

async function runsOfVersion(ctx: QueryCtx, versionId: Id<"agentHarnessVersions">) {
  return await ctx.db
    .query("agentHarnessRuns")
    .withIndex("by_versionId_and_createdAt", (q) => q.eq("versionId", versionId))
    .order("desc")
    .take(RUNS_SHOWN);
}

const summaryOf = (run: Doc<"agentHarnessRuns">) => ({
  expected: run.expected,
  received: run.received,
  passed: run.passed,
});

async function gateFor(ctx: QueryCtx, draft: Doc<"agentHarnessVersions">): Promise<GateState> {
  const runs = await runsOfVersion(ctx, draft._id);
  return gateOf(
    draft,
    runs.map((run) => ({ revision: run.revision, status: run.status, summary: summaryOf(run) })),
  );
}

/** The parts a version changes, in a fixed order, read without its prompt. */
const PART_KEYS = ["prompt", "params", "tools", "outputSchema"] as const;
type PartKey = (typeof PART_KEYS)[number];

function changedOf(row: Doc<"agentHarnessVersions">): PartKey[] {
  const shallow = shallowPartsOf(row);
  const prompt = promptVariantsOf(row) !== null;
  return PART_KEYS.filter((key) => (key === "prompt" ? prompt : shallow[key] !== undefined));
}

/**
 * A version as a list shows it: what it changes (and its prompt's variants
 * by name), never its prompt. A prompt is read only where it is shown.
 */
async function versionView(
  ctx: QueryCtx,
  member: Member,
  row: Doc<"agentHarnessVersions">,
  cache: Map<string, string>,
) {
  const changed = changedOf(row);
  return {
    id: row._id,
    number: row.number,
    name: versionName(row.number),
    status: row.status,
    revision: row.revision,
    changed,
    promptVariants: promptVariantsOf(row),
    codeDefault: changed.length === 0,
    basedOn: row.basedOn ?? null,
    note: row.note,
    createdBy: await whoOf(ctx, member, row.createdBy, cache),
    createdAt: row.createdAt,
    updatedBy: await whoOf(ctx, member, row.updatedBy, cache),
    updatedAt: row.updatedAt,
    publishedBy: row.publishedBy === undefined ? null : await whoOf(ctx, member, row.publishedBy, cache),
    publishedAt: row.publishedAt ?? null,
  };
}

/**
 * An agent's harness: the code's defaults, the published version, the open
 * draft with what its rules say and whether its tests let it be published,
 * every version, and each publish and rollback.
 */
export const harness = memberQuery("agents")({
  args: { project: v.string(), agentId: v.string() },
  handler: async (ctx, args) => {
    requireOsAgentOwner(ctx.member, args.project, args.agentId);
    const agent = await agentIn(ctx, args.project, args.agentId);
    const cache = new Map<string, string>();
    const rows = await versionsOf(ctx, args.project, args.agentId);
    const versions = [];
    for (const row of rows) versions.push(await versionView(ctx, ctx.member, row, cache));
    const draftRow = rows.find((row) => row.status === "draft") ?? null;
    const patientProviders = patientProvidersOf(agent.current);
    const events = await ctx.db
      .query("agentHarnessEvents")
      .withIndex("by_project_agentId_and_at", (q) => q.eq("project", args.project).eq("agentId", args.agentId))
      .order("desc")
      .take(VERSIONS_SHOWN);
    const eventViews = [];
    for (const event of events) {
      eventViews.push({
        id: event._id,
        number: event.number,
        name: versionName(event.number),
        action: event.action,
        by: await whoOf(ctx, ctx.member, event.by, cache),
        at: event.at,
        configVersion: event.configVersion,
        overrideReason: event.override?.reason ?? null,
      });
    }
    const draft = versions.find((row) => row.status === "draft") ?? null;
    const publishedRow = rows.find((row) => row.status === "published") ?? null;
    const published = versions.find((row) => row.status === "published") ?? null;
    const draftParts = draftRow === null ? null : await partsOf(ctx, draftRow);
    const draftBuilt =
      draftRow === null || agent.built === null
        ? null
        : await builtOf(ctx, agent.policy, draftRow, { publishing: true, ownerPublishing: isOwner(ctx.member) });
    return {
      project: args.project,
      agentId: args.agentId,
      /** v1.3: an agent built here, not in its project's code. */
      built: agent.built !== null,
      holdsPatientData: agent.policy.holdsPatientData,
      defaults: agent.defaults,
      published:
        published === null || publishedRow === null
          ? null
          : { ...published, parts: await partsOf(ctx, publishedRow), definition: publishedRow.definition ?? null },
      draft:
        draft === null || draftRow === null || draftParts === null
          ? null
          : {
              ...draft,
              parts: draftParts,
              definition: draftRow.definition ?? null,
              problems:
                draftBuilt !== null
                  ? [
                      ...builtProblems(draftBuilt),
                      ...(builtModelProblem(draftBuilt.definition) === null
                        ? []
                        : [{ path: "model", message: builtModelProblem(draftBuilt.definition)! }]),
                    ]
                  : harnessProblems(draftParts, { defaults: agent.defaults, patientProviders }),
              gate: await gateFor(ctx, draftRow),
            },
      versions,
      events: eventViews,
      current:
        agent.current === null
          ? null
          : {
              provider: agent.current.provider,
              model: agent.current.model,
              fallbackProvider: agent.current.fallbackProvider,
            },
      patientProviders,
      /** v1.3: a Startup OS agent using an owner-only tool: its runs and outputs are the owner's. */
      ownerOnly: agent.built !== null && ownerOnlyRuns(args.project, agent.built.parts.tools ?? [], agent.built.context),
      mayPublish: mayPublish(ctx.member),
      isOwner: isOwner(ctx.member),
    };
  },
});

/** One version's parts whole (its prompt too), for a diff of a version the list shows. */
export const version = memberQuery("agents")({
  args: { id: v.id("agentHarnessVersions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    if (row.project === INTERNAL_PROJECT && (await declaredOf(ctx, row.project, row.agentId)) === null) return null;
    requireOsAgentOwner(ctx.member, row.project, row.agentId);
    return {
      id: row._id,
      name: versionName(row.number),
      parts: await partsOf(ctx, row),
      definition: row.definition ?? null,
    };
  },
});

/** The models a Startup OS agent may be tested on: the offered ones and its own, on a provider that is configured. */
function startupOsChoices(definition: Definition | undefined): ModelPair[] {
  const configured = configuredProviders();
  const model = definition?.model;
  const own = model === undefined ? [] : [{ provider: model.provider, model: model.model }];
  if (model?.fallbackProvider !== undefined && model.fallbackModel !== undefined) own.push({ provider: model.fallbackProvider, model: model.fallbackModel });
  const offered = STARTUP_OS_PROVIDERS.flatMap((provider) => (STARTUP_OS_MODELS[provider] ?? []).map((name) => ({ provider: provider as string, model: name })));
  return [...own, ...offered].filter(
    (pair, i, all) =>
      configured[pair.provider] === true &&
      MODEL_PATTERN.test(pair.model) &&
      all.findIndex((other) => other.provider === pair.provider && other.model === pair.model) === i,
  );
}

/** The models a draft may be tested on: up, known, and allowed to this agent with this draft's tools. */
async function runChoices(
  ctx: QueryCtx,
  agent: Awaited<ReturnType<typeof agentIn>>,
  project: string,
  agentId: string,
  draft: Doc<"agentHarnessVersions"> | null,
) {
  // Startup OS's own agents run on its own providers, each once its variables are set.
  if (project === STARTUP_OS_PROJECT) return startupOsChoices(draft?.definition);
  const phiTools =
    draft !== null && usesPhiTool(effectiveOf(shallowPartsOf(draft), agent.defaults).tools, agent.defaults?.tools ?? []);
  const phi = phiTools || (await agentPhi(ctx, project, agentId, agent.control?.harnessVersion));
  return (await providersOf(ctx, project))
    .filter(
      (row) =>
        row.state === "up" &&
        isKnownProvider(row.provider) &&
        providerPolicyProblem(row.provider, agent.policy, phi) === null,
    )
    .map((row) => ({ provider: row.provider, model: row.model }));
}

async function casesOf(ctx: QueryCtx, project: string, agentId: string) {
  return await ctx.db
    .query("agentHarnessCases")
    .withIndex("by_project_and_agentId", (q) => q.eq("project", project).eq("agentId", agentId))
    .take(MAX_CASES + 1);
}

/** An agent's test cases, its latest runs (counts only), and the models a run may choose. */
export const tests = memberQuery("agents")({
  args: { project: v.string(), agentId: v.string() },
  handler: async (ctx, args) => {
    requireOsAgentOwner(ctx.member, args.project, args.agentId);
    const agent = await agentIn(ctx, args.project, args.agentId);
    const draft = await withStatus(ctx, args.project, args.agentId, "draft");
    const cache = new Map<string, string>();
    const cases = [];
    for (const row of await casesOf(ctx, args.project, args.agentId)) {
      cases.push({
        id: row._id,
        name: row.name,
        variables: row.variables,
        toolFixtures: row.toolFixtures ?? null,
        expect: row.expect,
        variant: row.variant ?? null,
        messages: row.messages ?? null,
        subAgentFixtures: row.subAgentFixtures ?? null,
        updatedBy: await whoOf(ctx, ctx.member, row.updatedBy, cache),
        updatedAt: row.updatedAt,
      });
    }
    const runRows = await ctx.db
      .query("agentHarnessRuns")
      .withIndex("by_project_agentId_and_createdAt", (q) => q.eq("project", args.project).eq("agentId", args.agentId))
      .order("desc")
      .take(RUNS_SHOWN);
    const runs = [];
    for (const run of runRows) {
      runs.push({
        id: run._id,
        number: run.number,
        name: `${versionName(run.number)}, revision ${run.revision}`,
        revision: run.revision,
        ofDraftNow: draft !== null && draft._id === run.versionId && draft.revision === run.revision,
        status: run.status,
        models: run.models,
        expected: run.expected,
        received: run.received,
        passed: run.passed,
        createdBy: await whoOf(ctx, ctx.member, run.createdBy, cache),
        createdAt: run.createdAt,
        finishedAt: run.finishedAt ?? null,
      });
    }
    return {
      cases,
      runs,
      choices: await runChoices(ctx, agent, args.project, args.agentId, draft),
      draft: draft === null ? null : { id: draft._id, name: versionName(draft.number), revision: draft.revision },
      variables: agent.defaults?.prompt?.variables ?? [],
      tools: (agent.defaults?.tools ?? []).map((tool) => tool.id),
      /** v1.2: the variants a case may run (the code's; `default` alone where it declares none). */
      variants: caseVariantsOf(agent.defaults),
      /** v1.2: `messages` when each case gives its own conversation. */
      input: inputOf(agent.defaults),
      /** v1.2: tools built into the provider, skipped in test runs. */
      providerTools: providerToolsOf(agent.defaults),
      /** v1.3: an agent built here: the sub-agents its cases may give fixtures for, by tool id. */
      subAgentTools: subAgentToolsOf(agent.built),
      built: agent.built !== null,
      /** Startup OS's agents: where it runs. One of the four on the Mac is not tested here (`OS_AGENT_WORDS.macTests`). */
      runsOn: runsOnOf(args.project, args.agentId, agent.control?.runsOn),
    };
  },
});

/** The tool ids of the sub-agents an agent built here may call (each published and offered); none for a code agent. */
function subAgentToolsOf(built: Built | null): string[] {
  if (built === null) return [];
  return built.context.peers.map((peer) => peer.toolId).filter((id): id is string => id !== null);
}

/** One run: each case on each model, with its output (a model's answer to made-up data). */
export const run = memberQuery("agents")({
  args: { id: v.id("agentHarnessRuns") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    requireOsAgentOwner(ctx.member, row.project, row.agentId);
    // A Startup OS agent using an owner-only tool: its test runs' answers are the owner's too.
    await requireRunsReader(ctx, ctx.member, row.project, row.agentId);
    const cases = await ctx.db
      .query("agentHarnessRunCases")
      .withIndex("by_run_and_caseId", (q) => q.eq("run", row._id))
      .collect();
    const results = await ctx.db
      .query("agentHarnessResults")
      .withIndex("by_run_caseId_provider_and_model", (q) => q.eq("run", row._id))
      .collect();
    return {
      id: row._id,
      project: row.project,
      agentId: row.agentId,
      status: row.status,
      models: row.models,
      cases: cases
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ caseId: c.caseId, name: c.name, expect: c.expect, variant: c.variant ?? null })),
      results: results.map((r) => ({
        caseId: r.caseId,
        provider: r.provider,
        model: r.model,
        output: r.output ?? null,
        schemaValid: r.schemaValid,
        assertions: r.assertions,
        passed: r.passed,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd ?? null,
        error: r.error ?? null,
        skippedTools: r.skippedTools ?? [],
        steps: r.steps ?? null,
        toolCalls: r.toolCalls ?? null,
      })),
    };
  },
});

// ── Drafts ───────────────────────────────────────────────────────────────────

async function nextNumber(ctx: QueryCtx, project: string, agentId: string) {
  const newest = await ctx.db
    .query("agentHarnessVersions")
    .withIndex("by_project_agentId_and_number", (q) => q.eq("project", project).eq("agentId", agentId))
    .order("desc")
    .first();
  return (newest?.number ?? 0) + 1;
}

/** Start a draft from the published version, or from the code's defaults. One draft at a time. */
export const newDraft = memberMutation("agents")({
  args: { project: v.string(), agentId: v.string(), from: v.union(v.literal("published"), v.literal("default")) },
  handler: async (ctx, args) => {
    requireOsAgentOwner(ctx.member, args.project, args.agentId);
    await agentIn(ctx, args.project, args.agentId);
    if ((await withStatus(ctx, args.project, args.agentId, "draft")) !== null) {
      throw new ConvexError(HARNESS_ACTION_WORDS.draftOpen);
    }
    const published = await withStatus(ctx, args.project, args.agentId, "published");
    if (args.from === "published" && published === null) throw new ConvexError(HARNESS_ACTION_WORDS.noPublished);
    const now = Date.now();
    // An agent built here has no code to fall back on: "default" starts from its newest version.
    const agentBuilt = (await declaredOf(ctx, args.project, args.agentId)) !== null;
    const source = args.from === "published" ? published : agentBuilt ? await newestVersion(ctx, args.project, args.agentId) : null;
    const base: HarnessParts = source === null ? {} : await partsOf(ctx, source);
    const { prompt, ...rest } = base;
    const control = agentBuilt ? await controlOf(ctx, args.project, args.agentId) : null;
    const definition =
      source?.definition === undefined
        ? undefined
        : control === null
          ? source.definition
          : {
              // The agent's model as it runs now, so a change made on its row is kept.
              ...source.definition,
              model: {
                provider: control.provider,
                model: control.model,
                ...(control.fallbackProvider === undefined || control.fallbackModel === undefined
                  ? {}
                  : { fallbackProvider: control.fallbackProvider, fallbackModel: control.fallbackModel }),
              },
            };
    const id = await ctx.db.insert("agentHarnessVersions", {
      project: args.project,
      agentId: args.agentId,
      number: await nextNumber(ctx, args.project, args.agentId),
      status: "draft",
      revision: 1,
      ...rest,
      ...(source === null ? {} : { basedOn: source.number }),
      ...(definition === undefined ? {} : { definition }),
      note: "",
      createdBy: ctx.member.user._id,
      createdAt: now,
      updatedBy: ctx.member.user._id,
      updatedAt: now,
    });
    if (prompt !== undefined) await ctx.db.patch(id, await writePrompt(ctx, id, prompt));
    return { id };
  },
});

/** The variants a test case may name: the code's, else `default` alone. */
function caseVariantsOf(defaults: HarnessDefaults | null): string[] {
  const code = codeVariantsOf(defaults);
  return code === null ? [DEFAULT_VARIANT] : variantNames(code);
}

async function draftRow(ctx: QueryCtx & { member: Member }, id: Id<"agentHarnessVersions">) {
  const row = await ctx.db.get(id);
  if (row === null) throw new ConvexError(HARNESS_ACTION_WORDS.noVersion);
  // Startup OS's own four are the owner's: nobody else changes, tests or publishes a draft of one.
  requireOsAgentOwner(ctx.member, row.project, row.agentId);
  if (row.status !== "draft") throw new ConvexError(HARNESS_ACTION_WORDS.notDraft);
  return row;
}

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * Save a draft as the editor shows it: every part as it would run. A part
 * the same as the code's default is kept as the code's. `revision` is the
 * one the editor opened: a draft changed since is not overwritten. A change
 * to a part makes a new revision, which needs its own test run.
 */
export const saveDraft = memberMutation("agents")({
  args: {
    id: v.id("agentHarnessVersions"),
    revision: v.number(),
    /** v1.2's variants, or v1.1's one system and user (the variant `default`); null: none. */
    prompt: v.union(v.object({ variants: variantsValidator }), v.object({ system: v.string(), user: v.string() }), v.null()),
    params: v.union(harnessParamsValidator, v.null()),
    tools: v.union(v.array(v.string()), v.null()),
    outputSchema: v.union(v.string(), v.null()),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await draftRow(ctx, args.id);
    if (row.revision !== args.revision) throw new ConvexError(HARNESS_ACTION_WORDS.stale);
    const note = args.note.trim();
    if (note.length > MAX_NOTE_LENGTH) throw new ConvexError(HARNESS_ACTION_WORDS.note);
    const prompt = args.prompt === null ? null : promptPartOf(args.prompt);
    // A name is checked before it is a key in a stored row; the rules say the rest.
    if (prompt !== null && Object.keys(prompt.variants).some((name) => !VARIANT_NAME_PATTERN.test(name))) {
      throw new ConvexError(HARNESS_ACTION_WORDS.variantName);
    }
    const templates = prompt === null ? [] : Object.values(prompt.variants).flatMap((t) => [t.system, t.user ?? ""]);
    if (
      (prompt !== null && Object.keys(prompt.variants).length > MAX_VARIANTS) ||
      templates.some((text) => utf8(text) > MAX_TEMPLATE_BYTES) ||
      (args.outputSchema !== null && utf8(args.outputSchema) > MAX_SCHEMA_BYTES) ||
      (args.tools !== null && args.tools.length > MAX_TOOLS)
    ) {
      throw new ConvexError(HARNESS_ACTION_WORDS.tooBig);
    }
    // An agent built here keeps every part: it has no code's defaults to leave out.
    const defaults = row.definition !== undefined ? null : await harnessDefaultsOf(ctx, row.project, row.agentId);
    const { prompt: promptPart, ...parts } = partsAgainst(
      { prompt, params: args.params, tools: args.tools, outputSchema: args.outputSchema },
      defaults,
    );
    if (utf8(JSON.stringify({ promptPart, parts })) > MAX_HARNESS_BYTES) throw new ConvexError(HARNESS_ACTION_WORDS.tooBig);
    const before = await partsOf(ctx, row);
    const changed = stableStringify({ ...parts, prompt: promptPart }) !== stableStringify(before);
    const revision = changed ? row.revision + 1 : row.revision;
    const promptFields = await writePrompt(ctx, row._id, promptPart);
    await ctx.db.replace(row._id, {
      project: row.project,
      agentId: row.agentId,
      number: row.number,
      status: row.status,
      revision,
      ...parts,
      ...promptFields,
      ...(row.basedOn === undefined ? {} : { basedOn: row.basedOn }),
      ...(row.definition === undefined ? {} : { definition: row.definition }),
      note,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedBy: ctx.member.user._id,
      updatedAt: Date.now(),
    });
    return { revision, changed };
  },
});

/** Put a draft away. It is kept, as a version never published. */
export const discardDraft = memberMutation("agents")({
  args: { id: v.id("agentHarnessVersions") },
  handler: async (ctx, args) => {
    const row = await draftRow(ctx, args.id);
    await ctx.db.patch(row._id, { status: "archived", updatedBy: ctx.member.user._id, updatedAt: Date.now() });
    return null;
  },
});

// ── Test cases ───────────────────────────────────────────────────────────────

/**
 * Add or change a test case. Made-up data only: `madeUp` is the tick that
 * says so, and a case is not saved without it.
 */
export const saveCase = memberMutation("agents")({
  args: {
    project: v.string(),
    agentId: v.string(),
    id: v.optional(v.id("agentHarnessCases")),
    name: v.string(),
    variables: v.record(v.string(), v.string()),
    toolFixtures: v.optional(v.union(v.string(), v.null())),
    expect: v.array(assertionValidator),
    /** v1.2: the variant it runs; none or null, `default`. */
    variant: v.optional(v.union(v.string(), v.null())),
    /** v1.2: its conversation, for an agent that sends its own. */
    messages: v.optional(v.union(caseMessagesValidator, v.null())),
    /** v1.3, an agent built here: JSON text, answers for each sub-agent's own tools. */
    subAgentFixtures: v.optional(v.union(v.string(), v.null())),
    madeUp: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireOsAgentOwner(ctx.member, args.project, args.agentId);
    const agent = await agentIn(ctx, args.project, args.agentId);
    const problems = args.madeUp
      ? caseProblems({
          name: args.name,
          variables: args.variables,
          toolFixtures: args.toolFixtures,
          expect: args.expect,
          variant: args.variant,
          messages: args.messages,
          subAgentFixtures: args.subAgentFixtures,
        })
      : [{ path: "madeUp", message: "Tick that this is made-up data, never a real patient." }];
    if (problems.length > 0) throw new ConvexError(problems[0]!.message);
    // v1.2: a variant the code declares, and a conversation exactly where the agent sends its own.
    const misfits = caseAgentProblems(args.name.trim(), args, {
      variants: caseVariantsOf(agent.defaults),
      input: inputOf(agent.defaults),
    });
    if (misfits.length > 0) throw new ConvexError(misfits[0]!);
    const now = Date.now();
    const fixtures = args.toolFixtures == null || args.toolFixtures.trim() === "" ? undefined : args.toolFixtures;
    const subAgentFixtures =
      args.subAgentFixtures == null || args.subAgentFixtures.trim() === "" ? undefined : args.subAgentFixtures;
    if (subAgentFixtures !== undefined) {
      const misplaced = caseFitProblems(args.name.trim(), { variables: {}, subAgentFixtures }, [], [], {
        subAgentTools: subAgentToolsOf(agent.built),
      });
      if (misplaced.length > 0) throw new ConvexError(misplaced[0]!);
    }
    const fields = {
      name: args.name.trim(),
      variables: args.variables,
      ...(fixtures === undefined ? {} : { toolFixtures: fixtures }),
      expect: args.expect,
      ...(args.variant == null || args.variant === "" ? {} : { variant: args.variant }),
      ...(args.messages == null ? {} : { messages: args.messages }),
      ...(subAgentFixtures === undefined ? {} : { subAgentFixtures }),
      updatedBy: ctx.member.user._id,
      updatedAt: now,
      madeUpAt: now,
    };
    if (args.id !== undefined) {
      const row = await ctx.db.get(args.id);
      if (row === null || row.project !== args.project || row.agentId !== args.agentId) {
        throw new ConvexError(HARNESS_ACTION_WORDS.noCase);
      }
      await ctx.db.replace(row._id, {
        project: row.project,
        agentId: row.agentId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        ...fields,
      });
      return { id: row._id };
    }
    if ((await casesOf(ctx, args.project, args.agentId)).length >= MAX_CASES) {
      throw new ConvexError(`An agent has at most ${MAX_CASES} test cases.`);
    }
    const id = await ctx.db.insert("agentHarnessCases", {
      project: args.project,
      agentId: args.agentId,
      createdBy: ctx.member.user._id,
      createdAt: now,
      ...fields,
    });
    return { id };
  },
});

export const removeCase = memberMutation("agents")({
  args: { id: v.id("agentHarnessCases") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError(HARNESS_ACTION_WORDS.noCase);
    requireOsAgentOwner(ctx.member, row.project, row.agentId);
    await ctx.db.delete(row._id);
    return null;
  },
});

// ── Test runs ────────────────────────────────────────────────────────────────

const placeOf = (issue: Issue) => (issue.at === undefined ? "" : ` (line ${issue.at.line}, column ${issue.at.column})`);
const firstProblem = (lead: string, issues: readonly Issue[]) =>
  `${lead} ${issues[0]!.path}${placeOf(issues[0]!)}: ${issues[0]!.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`;

/**
 * Queue a test run of a draft as it is now, on chosen models against chosen
 * cases. The draft must keep every rule first. Its project picks the job up
 * on its next poll (GET /agents/v1/jobs).
 */
export const startRun = memberMutation("agents")({
  args: {
    draftId: v.id("agentHarnessVersions"),
    models: v.array(v.object({ provider: v.string(), model: v.string() })),
    caseIds: v.array(v.id("agentHarnessCases")),
  },
  handler: async (ctx, args) => {
    const draft = await draftRow(ctx, args.draftId);
    const agent = await agentIn(ctx, draft.project, draft.agentId);
    if (draft.project === STARTUP_OS_PROJECT) {
      // One of the four on the Mac is not tested here: Startup OS runs no Claude.
      if (runsOnOf(draft.project, draft.agentId, agent.control?.runsOn) === "claude_mac") throw new ConvexError(OS_AGENT_WORDS.macTests);
      // A Startup OS test run calls a model on the owner's key: only for someone who may read its runs, and never while it is off.
      await requireRunsReader(ctx, ctx.member, draft.project, draft.agentId);
      if (agent.control !== null && !agent.control.enabled) throw new ConvexError(RUNTIME_ACTION_WORDS.off);
    }
    const parts = await partsOf(ctx, draft);
    const built = agent.built === null ? null : await builtOf(ctx, agent.policy, draft);
    const problems =
      built !== null
        ? builtProblems(built)
        : harnessProblems(parts, { defaults: agent.defaults, patientProviders: patientProvidersOf(agent.current) });
    if (problems.length > 0) throw new ConvexError(firstProblem("Fix the draft first:", problems));

    const keys = args.models.map((m) => `${m.provider}|${m.model}`);
    if (args.models.length === 0 || args.models.length > MAX_RUN_MODELS || new Set(keys).size !== keys.length) {
      throw new ConvexError(HARNESS_ACTION_WORDS.models);
    }
    const choices = await runChoices(ctx, agent, draft.project, draft.agentId, draft);
    if (!args.models.every((m) => choices.some((c) => c.provider === m.provider && c.model === m.model))) {
      throw new ConvexError(HARNESS_ACTION_WORDS.model);
    }
    if (args.caseIds.length === 0 || args.caseIds.length > MAX_CASES || new Set(args.caseIds).size !== args.caseIds.length) {
      throw new ConvexError(HARNESS_ACTION_WORDS.cases);
    }
    const open = (await runsOfVersion(ctx, draft._id)).some(
      (row) => row.revision === draft.revision && (row.status === "queued" || row.status === "running"),
    );
    if (open) throw new ConvexError(HARNESS_ACTION_WORDS.runOpen);

    const cases: Doc<"agentHarnessCases">[] = [];
    for (const id of args.caseIds) {
      const row = await ctx.db.get(id);
      if (row === null || row.project !== draft.project || row.agentId !== draft.agentId) {
        throw new ConvexError(HARNESS_ACTION_WORDS.noCase);
      }
      cases.push(row);
    }
    const defaults = built?.defaults ?? agent.defaults;
    const variables = defaults?.prompt?.variables ?? [];
    const toolIds = (defaults?.tools ?? []).map((tool) => tool.id);
    const fit = {
      variants: caseVariantsOf(defaults),
      input: inputOf(defaults),
      providerTools: providerToolsOf(defaults),
      subAgentTools: subAgentToolsOf(built),
    };
    const misfits = cases.flatMap((row) => caseFitProblems(row.name, row, variables, toolIds, fit));
    if (misfits.length > 0) throw new ConvexError(misfits[0]!);

    const now = Date.now();
    const harness = jobHarnessOf(draft.number, draft.revision, parts, defaults);
    const id = await ctx.db.insert("agentHarnessRuns", {
      project: draft.project,
      agentId: draft.agentId,
      versionId: draft._id,
      number: draft.number,
      revision: draft.revision,
      tools: harness.tools ?? [],
      models: args.models.map((m) => ({ provider: m.provider, model: m.model })),
      status: "queued",
      leases: 0,
      expected: cases.length * args.models.length,
      received: 0,
      passed: 0,
      createdBy: ctx.member.user._id,
      createdAt: now,
    });
    // Kept apart, so a list of runs never reads a harness of up to 512 KB.
    // v1.3: an agent built here also carries its draft definition and the published sub-agents it calls.
    const subAgents = built === null ? [] : await subAgentsOf(ctx, built);
    if (subAgents.length > MAX_JOB_SUB_AGENTS) throw new ConvexError(HARNESS_ACTION_WORDS.subAgents);
    const definition =
      built === null
        ? {}
        : {
            definition: JSON.stringify({
              definition: definitionOut(draftVersionName(draft.number, draft.revision), built.definition, parts),
              subAgents,
            }),
          };
    await ctx.db.insert("agentHarnessRunPayloads", { run: id, harness: JSON.stringify(harness), ...definition });
    for (const [position, row] of cases.entries()) {
      await ctx.db.insert("agentHarnessRunCases", {
        run: id,
        caseId: row._id,
        name: row.name,
        variables: row.variables,
        ...(row.toolFixtures === undefined ? {} : { toolFixtures: row.toolFixtures }),
        expect: row.expect,
        ...(row.variant === undefined ? {} : { variant: row.variant }),
        ...(row.messages === undefined ? {} : { messages: row.messages }),
        ...(row.subAgentFixtures === undefined ? {} : { subAgentFixtures: row.subAgentFixtures }),
        position,
      });
    }
    // An agent built to run in Startup OS is tested here, by its own runtime: no project polls for it.
    if (draft.project === STARTUP_OS_PROJECT) await ctx.scheduler.runAfter(0, internal.agentRuntime.test, { run: id, from: 0 });
    return { id };
  },
});

// ── Publishing ───────────────────────────────────────────────────────────────

/**
 * Put a version live: its agent's desired state names it, as a new version
 * of the project's config (pending until the project applies it); the
 * version is published and the one before archived; the event is recorded.
 */
async function goLive(
  ctx: MutationCtx,
  member: Member,
  row: Doc<"agentHarnessVersions">,
  action: "publish" | "rollback",
  override: { reason: string } | null,
) {
  const agent = await agentIn(ctx, row.project, row.agentId);
  const built =
    agent.built === null ? null : await builtOf(ctx, agent.policy, row, { publishing: true, ownerPublishing: isOwner(member) });
  let next: Control;
  if (built !== null) {
    // An agent built here goes live on its definition's model, name and budget.
    const problems = builtProblems(built);
    if (problems.length > 0) throw new ConvexError(firstProblem("It cannot go live:", problems));
    const modelProblem = builtModelProblem(built.definition);
    if (modelProblem !== null) throw new ConvexError(modelProblem);
    const fromDefinition = controlFromDefinition(row.agentId, built.definition)!;
    next = {
      ...fromDefinition,
      enabled: agent.control?.enabled ?? true,
      version: agent.current?.version ?? 0,
      harnessVersion: versionName(row.number),
      // One of the four keeps where it runs: publishing never moves it.
      runsOn: agent.current?.runsOn ?? null,
    };
  } else {
    if (agent.current === null) throw new ConvexError(HARNESS_ACTION_WORDS.unlaunched);
    const problems = harnessProblems(await partsOf(ctx, row), {
      defaults: agent.defaults,
      patientProviders: patientProvidersOf(agent.current),
    });
    if (problems.length > 0) throw new ConvexError(firstProblem("It cannot go live:", problems));
    next = { ...agent.current, harnessVersion: versionName(row.number) };
  }
  const configVersion = await commit(
    ctx,
    member,
    row.project,
    agent.control,
    agent.control === null || agent.current === null ? null : desiredOf(agent.current),
    next,
    built !== null && agent.control === null,
  );
  const now = Date.now();
  const previous = await withStatus(ctx, row.project, row.agentId, "published");
  if (previous !== null && previous._id !== row._id) {
    await ctx.db.patch(previous._id, { status: "archived" });
  }
  await ctx.db.patch(row._id, { status: "published", publishedBy: member.user._id, publishedAt: now });
  await ctx.db.insert("agentHarnessEvents", {
    project: row.project,
    agentId: row.agentId,
    number: row.number,
    action,
    by: member.user._id,
    at: now,
    configVersion,
    ...(override === null ? {} : { override }),
  });
  return { configVersion, version: versionName(row.number) };
}

/**
 * Publish a draft: it keeps every rule, and its latest finished test run is
 * of it as it is and passed every expectation on every model. The owner
 * alone may publish without that, saying why (recorded with the event).
 */
export const publish = memberMutation("agents")({
  args: { id: v.id("agentHarnessVersions"), overrideReason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requirePublisher(ctx.member);
    const row = await draftRow(ctx, args.id);
    let override: { reason: string } | null = null;
    if (args.overrideReason !== undefined) {
      if (!isOwner(ctx.member)) throw new ConvexError(HARNESS_ACTION_WORDS.overrideOwner);
      const reason = args.overrideReason.trim();
      if (reason.length === 0 || reason.length > MAX_NOTE_LENGTH) throw new ConvexError(HARNESS_ACTION_WORDS.overrideReason);
      override = { reason };
    } else {
      const gate = await gateFor(ctx, row);
      if (gate !== "passed") throw new ConvexError(`It cannot be published yet. ${GATE_WORDS[gate]}`);
    }
    return await goLive(ctx, ctx.member, row, "publish", override);
  },
});

/** Roll back: publish again a version that was published before. It keeps today's rules; no new test run. */
export const rollback = memberMutation("agents")({
  args: { id: v.id("agentHarnessVersions") },
  handler: async (ctx, args) => {
    requirePublisher(ctx.member);
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError(HARNESS_ACTION_WORDS.noVersion);
    requireOsAgentOwner(ctx.member, row.project, row.agentId);
    if (row.status !== "archived" || row.publishedAt === undefined) throw new ConvexError(HARNESS_ACTION_WORDS.notRollback);
    return await goLive(ctx, ctx.member, row, "rollback", null);
  },
});

// ── Protocol v1.1, inside (convex/agentsApi.ts) ─────────────────────────────

type JobOut = {
  id: string;
  agentId: string;
  /** v1.3: present for an agent built here. */
  kind?: "declarative";
  harness: unknown;
  definition?: unknown;
  subAgents?: unknown;
  models: ModelPair[];
  cases: JobCase[];
};

async function payloadOf(ctx: QueryCtx, run: Doc<"agentHarnessRuns">) {
  return await ctx.db
    .query("agentHarnessRunPayloads")
    .withIndex("by_run", (q) => q.eq("run", run._id))
    .unique();
}

/** A run's harness as its job carries it (JSON text): its own row, or inline on a v1.1 run. */
async function runHarnessOf(ctx: QueryCtx, run: Doc<"agentHarnessRuns">): Promise<string> {
  if (run.harness !== undefined) return run.harness;
  return (await payloadOf(ctx, run))?.harness ?? "{}";
}

/** v1.3: a built agent's draft definition and sub-agents, as its job carries them; null for a code agent's run. */
async function runDefinitionOf(ctx: QueryCtx, run: Doc<"agentHarnessRuns">) {
  if (run.harness !== undefined) return null;
  const text = (await payloadOf(ctx, run))?.definition;
  return text === undefined ? null : (JSON.parse(text) as { definition: unknown; subAgents: unknown });
}

/** The tools a run's job switches on: what a result may say it skipped. */
async function runToolsOf(ctx: QueryCtx, run: Doc<"agentHarnessRuns">): Promise<string[]> {
  if (run.tools !== undefined) return run.tools;
  const harness = JSON.parse(await runHarnessOf(ctx, run)) as { tools?: unknown };
  return Array.isArray(harness.tools) ? harness.tools.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The jobs a project's poll is handed: queued ones, or ones whose lease ran
 * out with leases left, oldest first, at most MAX_JOBS_PER_POLL, each leased
 * for LEASE_MS. A job whose last lease ran out is given up on. Null for a
 * token not honoured.
 */
export const jobsFor = internalMutation({
  args: { tokenHash: v.string(), now: v.number() },
  handler: async (ctx, { tokenHash, now }): Promise<{ body: string } | null> => {
    const project = await projectHolding(ctx, tokenHash);
    if (project === null) return null;
    const open: Doc<"agentHarnessRuns">[] = [];
    for (const status of ["queued", "running"] as const) {
      open.push(
        ...(await ctx.db
          .query("agentHarnessRuns")
          .withIndex("by_project_and_status", (q) => q.eq("project", project.slug).eq("status", status))
          .take(50)),
      );
    }
    open.sort((a, b) => a.createdAt - b.createdAt);
    const jobs: JobOut[] = [];
    for (const run of open) {
      const lease = leaseOf(run, now);
      if (lease === "expire") {
        await ctx.db.patch(run._id, { status: "expired", finishedAt: now, leaseUntil: undefined });
        continue;
      }
      if (lease !== "available" || jobs.length >= MAX_JOBS_PER_POLL) continue;
      await ctx.db.patch(run._id, { status: "running", leaseUntil: now + LEASE_MS, leases: run.leases + 1 });
      const cases = (
        await ctx.db
          .query("agentHarnessRunCases")
          .withIndex("by_run_and_caseId", (q) => q.eq("run", run._id))
          .collect()
      ).sort((a, b) => a.position - b.position);
      const built = await runDefinitionOf(ctx, run);
      jobs.push({
        id: run._id,
        agentId: run.agentId,
        ...(built === null ? {} : { kind: "declarative" as const }),
        harness: JSON.parse(await runHarnessOf(ctx, run)) as unknown,
        ...(built === null ? {} : { definition: built.definition, subAgents: built.subAgents }),
        models: run.models,
        cases: cases.map((c) =>
          jobCaseOf(c.caseId, {
            name: c.name,
            variables: c.variables,
            toolFixtures: c.toolFixtures,
            expect: c.expect,
            variant: c.variant,
            messages: c.messages,
            subAgentFixtures: c.subAgentFixtures,
          }),
        ),
      });
    }
    // JSON text: a schema or a fixture may hold `$` keys, which no Convex value may carry.
    return { body: JSON.stringify({ jobs }) };
  },
});

type JobLookup =
  | { status: "unauthorized" }
  | { status: "not_found" }
  | { status: "closed" }
  | { status: "open"; run: Doc<"agentHarnessRuns">; expectCounts: Map<string, number> };

async function jobOf(ctx: QueryCtx, tokenHash: string, jobId: string): Promise<JobLookup> {
  const project = await projectHolding(ctx, tokenHash);
  if (project === null) return { status: "unauthorized" };
  const id = ctx.db.normalizeId("agentHarnessRuns", jobId);
  const run = id === null ? null : await ctx.db.get(id);
  // Another project's job is answered as one that does not exist.
  if (run === null || run.project !== project.slug) return { status: "not_found" };
  if (run.status !== "queued" && run.status !== "running") return { status: "closed" };
  const cases = await ctx.db
    .query("agentHarnessRunCases")
    .withIndex("by_run_and_caseId", (q) => q.eq("run", run._id))
    .collect();
  return { status: "open", run, expectCounts: new Map(cases.map((c) => [c.caseId, c.expect.length])) };
}

/** What results for a job are checked against: its cases (with how many expectations each) and models. */
export const jobShape = internalQuery({
  args: { tokenHash: v.string(), jobId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { status: "unauthorized" | "not_found" | "closed" }
    | { status: "open"; cases: { caseId: string; expected: number }[]; models: ModelPair[]; tools: string[] }
  > => {
    const job = await jobOf(ctx, args.tokenHash, args.jobId);
    if (job.status !== "open") return { status: job.status };
    return {
      status: "open" as const,
      cases: [...job.expectCounts.entries()].map(([caseId, expected]) => ({ caseId, expected })),
      models: job.run.models,
      tools: await runToolsOf(ctx, job.run),
    };
  },
});

const resultArg = v.object({
  caseId: v.string(),
  provider: v.string(),
  model: v.string(),
  /** JSON text, or null where the model gave none. */
  output: v.union(v.string(), v.null()),
  schemaValid: v.boolean(),
  assertions: v.array(v.object({ index: v.number(), passed: v.boolean() })),
  latencyMs: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  costUsd: v.union(v.number(), v.null()),
  error: v.union(...RESULT_ERRORS.map((error) => v.literal(error)), v.null()),
  skippedTools: v.optional(v.array(v.string())),
  steps: v.optional(v.number()),
  toolCalls: v.optional(
    v.array(v.object({ toolId: v.string(), status: v.union(v.literal("ok"), v.literal("error"), v.literal("skipped")) })),
  ),
});

/** One result as stored: what the endpoint (or Startup OS's own runtime) took. */
export type ResultIn = {
  caseId: string;
  provider: string;
  model: string;
  output: string | null;
  schemaValid: boolean;
  assertions: { index: number; passed: boolean }[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: (typeof RESULT_ERRORS)[number] | null;
  skippedTools?: string[];
  steps?: number;
  toolCalls?: { toolId: string; status: "ok" | "error" | "skipped" }[];
};

/**
 * Store results of an open run: one row per case and model, replaced if sent
 * again, with the run's counts moved to match; `final` closes it. Shared by
 * a project's results (`recordResults`) and Startup OS's own test runs.
 */
export async function storeResults(
  ctx: MutationCtx,
  run: Doc<"agentHarnessRuns">,
  expectCounts: ReadonlyMap<string, number>,
  results: readonly ResultIn[],
  final: boolean,
) {
  let received = run.received;
  let passedCount = run.passed;
  for (const result of results) {
    const passed = resultPassed(result, expectCounts.get(result.caseId) ?? 0);
    const row = {
      run: run._id,
      caseId: result.caseId,
      provider: result.provider,
      model: result.model,
      ...(result.output === null ? {} : { output: result.output }),
      schemaValid: result.schemaValid,
      assertions: result.assertions,
      passed,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ...(result.costUsd === null ? {} : { costUsd: result.costUsd }),
      ...(result.error === null ? {} : { error: result.error }),
      ...(result.skippedTools === undefined || result.skippedTools.length === 0
        ? {}
        : { skippedTools: result.skippedTools }),
      ...(result.steps === undefined ? {} : { steps: result.steps }),
      ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
    };
    const stored = await ctx.db
      .query("agentHarnessResults")
      .withIndex("by_run_caseId_provider_and_model", (q) =>
        q.eq("run", run._id).eq("caseId", result.caseId).eq("provider", result.provider).eq("model", result.model),
      )
      .unique();
    if (stored === null) {
      await ctx.db.insert("agentHarnessResults", row);
      received += 1;
      if (passed) passedCount += 1;
    } else {
      await ctx.db.replace(stored._id, row);
      passedCount += (passed ? 1 : 0) - (stored.passed ? 1 : 0);
    }
  }
  await ctx.db.patch(run._id, {
    received,
    passed: passedCount,
    ...(final ? { status: "done" as const, finishedAt: Date.now(), leaseUntil: undefined } : {}),
  });
}

/**
 * Store a slice of a job's results, already checked by the endpoint against
 * the job: one row per case and model, replaced if sent again, with the
 * run's counts moved to match. The last slice (`final`) closes the job.
 */
export const recordResults = internalMutation({
  args: { tokenHash: v.string(), jobId: v.string(), results: v.array(resultArg), final: v.boolean() },
  handler: async (ctx, args) => {
    const job = await jobOf(ctx, args.tokenHash, args.jobId);
    if (job.status !== "open") return { status: job.status };
    await storeResults(ctx, job.run, job.expectCounts, args.results, args.final);
    return { status: "ok" as const };
  },
});
