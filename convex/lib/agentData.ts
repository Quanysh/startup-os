// The tables of the projects' agents, read and written for convex/agentControl.ts
// (the page, the changes, the legacy push) and convex/agentProjects.ts (the
// projects, Protocol v1). Runs only inside Convex: never import it from the UI.
//
// Every row carries its project's slug. Rows from before projects carry none
// and are Vertical Startup's (LEGACY_PROJECT): every read of that project reads
// both until `adoptLegacy` has stamped them all, so nothing goes missing
// between the deploy and the stamping. Nothing here logs.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { definitionPhi, type CatalogTool, type Peer } from "./agentBuilder";
import { addDays, newestBusiest, type Control, type UsageDay } from "./agentControl";
import {
  promptPartOf,
  usesPhiTool,
  variantNames,
  versionNumberOf,
  type HarnessDefaults,
  type HarnessParts,
  type PromptPart,
} from "./agentHarness";
import { STARTUP_OS_POLICY, STARTUP_OS_PROJECT } from "./agentStartupOs";
import {
  INTERNAL_PROJECT_NAME,
  LEGACY_PROJECT,
  LEGACY_PROJECT_NAME,
  PATIENT_DATA_PROVIDERS,
  type AgentKind,
  type Region,
} from "./agentProjects";

/** The values of `project` a project's rows may carry: its slug, and none for the legacy project's oldest. */
export const slugsOf = (project: string): (string | undefined)[] =>
  project === LEGACY_PROJECT ? [project, undefined] : [project];

/** A row's project: its slug, or the legacy project's where it predates projects. */
export const projectOf = (row: { project?: string }): string => row.project ?? LEGACY_PROJECT;

/** What a project is held to, from its row or (the legacy project, before its row exists) the defaults. */
export type ProjectPolicy = {
  slug: string;
  name: string;
  region: Region;
  holdsPatientData: boolean;
  allowedProviders: string[];
};

/** Vertical Startup as its first legacy push makes it: US, holding patient data, Vertex AI only. */
export const LEGACY_DEFAULTS: ProjectPolicy = {
  slug: LEGACY_PROJECT,
  name: LEGACY_PROJECT_NAME,
  region: "US",
  holdsPatientData: true,
  allowedProviders: [...PATIENT_DATA_PROVIDERS],
};

export async function projectRow(ctx: QueryCtx, slug: string): Promise<Doc<"agentProjects"> | null> {
  return await ctx.db
    .query("agentProjects")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/** A project's policy, or null for one that does not exist. */
export async function policyOf(ctx: QueryCtx, slug: string): Promise<ProjectPolicy | null> {
  const row = await projectRow(ctx, slug);
  if (row !== null) {
    return {
      slug: row.slug,
      name: row.name,
      region: row.region,
      holdsPatientData: row.holdsPatientData,
      allowedProviders: row.allowedProviders,
    };
  }
  return slug === LEGACY_PROJECT ? LEGACY_DEFAULTS : null;
}

/** Make the legacy project's row where it is missing: Vertical Startup's first push does. */
export async function ensureLegacyProject(ctx: MutationCtx, now: number): Promise<Doc<"agentProjects">> {
  const row = await projectRow(ctx, LEGACY_PROJECT);
  if (row !== null) return row;
  const { slug, name, region, holdsPatientData, allowedProviders } = LEGACY_DEFAULTS;
  const id = await ctx.db.insert("agentProjects", {
    slug,
    name,
    region,
    holdsPatientData,
    allowedProviders,
    status: "active",
    createdAt: now,
  });
  return (await ctx.db.get(id))!;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function configRow(ctx: QueryCtx, project: string): Promise<Doc<"agentConfig"> | null> {
  for (const slug of slugsOf(project)) {
    const row = await ctx.db
      .query("agentConfig")
      .withIndex("by_project", (q) => q.eq("project", slug))
      .first();
    if (row !== null) return row;
  }
  return null;
}

export const asUsage = (row: Doc<"agentUsage">): UsageDay => ({
  agentId: row.agentId,
  promptVersion: row.promptVersion,
  provider: row.provider,
  model: row.model,
  day: row.day,
  calls: row.calls,
  errors: row.errors,
  schemaFailures: row.schemaFailures,
  fallbacks: row.fallbacks,
  refusals: row.refusals,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  costUsd: row.costUsd ?? null,
  p50Ms: row.p50Ms ?? null,
  p95Ms: row.p95Ms ?? null,
});

export const asControl = (row: Doc<"agentControls">): Control => ({
  agentId: row.agentId,
  enabled: row.enabled,
  provider: row.provider,
  model: row.model,
  fallbackProvider: row.fallbackProvider ?? null,
  fallbackModel: row.fallbackModel ?? null,
  monthlyBudgetUsd: row.monthlyBudgetUsd ?? null,
  name: row.name ?? null,
  promptVersionPin: row.promptVersionPin ?? null,
  harnessVersion: row.harnessVersion ?? null,
  runsOn: row.runsOn ?? null,
  version: row.version,
});

/** A project's usage from `from` (a UTC day) on. */
export async function usageSince(ctx: QueryCtx, project: string, from: string): Promise<UsageDay[]> {
  const rows: UsageDay[] = [];
  for (const slug of slugsOf(project)) {
    const found = await ctx.db
      .query("agentUsage")
      .withIndex("by_project_and_day", (q) => q.eq("project", slug).gte("day", from))
      .collect();
    rows.push(...found.map(asUsage));
  }
  return rows;
}

/** Every project's usage from `from` on, by project. */
export async function allUsageSince(ctx: QueryCtx, from: string): Promise<Map<string, UsageDay[]>> {
  const rows = await ctx.db
    .query("agentUsage")
    .withIndex("by_day", (q) => q.gte("day", from))
    .collect();
  const by = new Map<string, UsageDay[]>();
  for (const row of rows) by.set(projectOf(row), [...(by.get(projectOf(row)) ?? []), asUsage(row)]);
  return by;
}

/** Whether a project has any usage at all. */
export async function hasUsage(ctx: QueryCtx, project: string): Promise<boolean> {
  for (const slug of slugsOf(project)) {
    const row = await ctx.db
      .query("agentUsage")
      .withIndex("by_project_and_day", (q) => q.eq("project", slug))
      .first();
    if (row !== null) return true;
  }
  return false;
}

export async function controlsOf(ctx: QueryCtx, project: string): Promise<Doc<"agentControls">[]> {
  const rows: Doc<"agentControls">[] = [];
  for (const slug of slugsOf(project)) {
    rows.push(
      ...(await ctx.db
        .query("agentControls")
        .withIndex("by_project_and_agentId", (q) => q.eq("project", slug))
        .collect()),
    );
  }
  return rows;
}

export async function controlOf(ctx: QueryCtx, project: string, agentId: string) {
  for (const slug of slugsOf(project)) {
    const row = await ctx.db
      .query("agentControls")
      .withIndex("by_project_and_agentId", (q) => q.eq("project", slug).eq("agentId", agentId))
      .unique();
    if (row !== null) return row;
  }
  return null;
}

/** The model and prompt an agent was last seen on in its project, from its newest day, however old. */
export async function lastSeen(ctx: QueryCtx, project: string, agentId: string): Promise<UsageDay | null> {
  const days: UsageDay[] = [];
  for (const slug of slugsOf(project)) {
    const newest = await ctx.db
      .query("agentUsage")
      .withIndex("by_project_agentId_and_day", (q) => q.eq("project", slug).eq("agentId", agentId))
      .order("desc")
      .first();
    if (newest === null) continue;
    const day = await ctx.db
      .query("agentUsage")
      .withIndex("by_project_agentId_and_day", (q) =>
        q.eq("project", slug).eq("agentId", agentId).eq("day", newest.day),
      )
      .collect();
    days.push(...day.map(asUsage));
  }
  return newestBusiest(days);
}

export type ProviderView = {
  project: string;
  provider: string;
  model: string;
  state: "up" | "degraded" | "down";
  checkedAt: number;
  lastErrorClass: string | null;
};

const asProvider = (row: Doc<"agentProviders">): ProviderView => ({
  project: projectOf(row),
  provider: row.provider,
  model: row.model,
  state: row.state,
  checkedAt: row.checkedAt,
  lastErrorClass: row.lastErrorClass ?? null,
});

const providerOrder = (a: ProviderView, b: ProviderView) =>
  a.project.localeCompare(b.project) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);

/** A project's providers, or every project's with no project given. */
export async function providersOf(ctx: QueryCtx, project?: string): Promise<ProviderView[]> {
  if (project === undefined) return (await ctx.db.query("agentProviders").collect()).map(asProvider).sort(providerOrder);
  const rows: ProviderView[] = [];
  for (const slug of slugsOf(project)) {
    const found = await ctx.db
      .query("agentProviders")
      .withIndex("by_project_provider_and_model", (q) => q.eq("project", slug))
      .collect();
    rows.push(...found.map(asProvider));
  }
  return rows.sort(providerOrder);
}

export type CatalogEntry = { agentId: string; name: string; phi: boolean; kind: AgentKind; lastReportedAt: number };

export async function catalogOf(ctx: QueryCtx, project: string): Promise<CatalogEntry[]> {
  const rows = await ctx.db
    .query("agentCatalog")
    .withIndex("by_project_and_agentId", (q) => q.eq("project", project))
    .collect();
  return rows.map((row) => ({
    agentId: row.agentId,
    name: row.name,
    phi: row.phi,
    kind: row.kind,
    lastReportedAt: row.lastReportedAt,
  }));
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Present only where known: a null from the wire is left out, never stored as 0. */
const known = <K extends string>(key: K, value: number | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, number>>;

type UsageFields = Omit<Doc<"agentUsage">, "_id" | "_creationTime">;

const sameUsage = (stored: Doc<"agentUsage">, next: UsageFields) =>
  stored.project === next.project &&
  (
    [
      "calls",
      "errors",
      "schemaFailures",
      "fallbacks",
      "refusals",
      "inputTokens",
      "outputTokens",
      "costUsd",
      "p50Ms",
      "p95Ms",
    ] as const
  ).every((field) => stored[field] === next[field]);

export type UsageIn = {
  product?: string;
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
  costUsd?: number | null;
  p50Ms?: number | null;
  p95Ms?: number | null;
};

export type ProviderIn = {
  provider: string;
  model: string;
  state: "up" | "degraded" | "down";
  checkedAt: string;
  lastErrorClass?: Doc<"agentProviders">["lastErrorClass"] | null;
};

export type Counts = { inserted: number; updated: number; unchanged: number };

/**
 * One push's rows, for one project: usage upserted by its six-part key, each
 * provider's newer check, and the applied version where it moves forward.
 * The project is the caller's to decide (the token's, or the legacy source's):
 * nothing in a row names one.
 */
export async function storeRows(
  ctx: MutationCtx,
  project: string,
  rows: { usage: readonly UsageIn[]; providers: readonly ProviderIn[]; applied?: { version: number; appliedAt: string | null } },
  now: number,
): Promise<Counts> {
  const counts = { inserted: 0, updated: 0, unchanged: 0 };

  for (const row of rows.usage) {
    const next: UsageFields = {
      project,
      ...(row.product === undefined ? {} : { product: row.product }),
      agentId: row.agentId,
      promptVersion: row.promptVersion,
      provider: row.provider,
      model: row.model,
      day: row.day,
      calls: row.calls,
      errors: row.errors,
      schemaFailures: row.schemaFailures,
      fallbacks: row.fallbacks,
      refusals: row.refusals,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      ...known("costUsd", row.costUsd),
      ...known("p50Ms", row.p50Ms),
      ...known("p95Ms", row.p95Ms),
      syncedAt: now,
    };
    let stored: Doc<"agentUsage"> | null = null;
    for (const slug of slugsOf(project)) {
      stored = await ctx.db
        .query("agentUsage")
        .withIndex("by_project_agentId_promptVersion_provider_model_day", (q) =>
          q
            .eq("project", slug)
            .eq("agentId", row.agentId)
            .eq("promptVersion", row.promptVersion)
            .eq("provider", row.provider)
            .eq("model", row.model)
            .eq("day", row.day),
        )
        .unique();
      if (stored !== null) break;
    }
    if (stored === null) {
      await ctx.db.insert("agentUsage", next);
      counts.inserted += 1;
    } else if (sameUsage(stored, next)) {
      counts.unchanged += 1;
    } else {
      // Replace, so a figure no longer known is gone rather than kept stale.
      await ctx.db.replace(stored._id, next);
      counts.updated += 1;
    }
  }

  for (const row of rows.providers) {
    const checkedAt = Date.parse(row.checkedAt);
    const next = {
      project,
      provider: row.provider,
      model: row.model,
      state: row.state,
      checkedAt,
      ...(row.lastErrorClass == null ? {} : { lastErrorClass: row.lastErrorClass }),
      syncedAt: now,
    };
    let stored: Doc<"agentProviders"> | null = null;
    for (const slug of slugsOf(project)) {
      stored = await ctx.db
        .query("agentProviders")
        .withIndex("by_project_provider_and_model", (q) =>
          q.eq("project", slug).eq("provider", row.provider).eq("model", row.model),
        )
        .unique();
      if (stored !== null) break;
    }
    if (stored === null) {
      await ctx.db.insert("agentProviders", next);
      counts.inserted += 1;
    } else if (checkedAt < stored.checkedAt) {
      // An older check than the one held: the newer one stands.
      counts.unchanged += 1;
    } else if (
      stored.project === project &&
      stored.checkedAt === checkedAt &&
      stored.state === next.state &&
      stored.lastErrorClass === next.lastErrorClass
    ) {
      counts.unchanged += 1;
    } else {
      await ctx.db.replace(stored._id, next);
      counts.updated += 1;
    }
  }

  if (rows.applied !== undefined) {
    const config = await configRow(ctx, project);
    const at = rows.applied.appliedAt === null ? {} : { appliedAt: Date.parse(rows.applied.appliedAt) };
    if (config === null) {
      await ctx.db.insert("agentConfig", { project, latestVersion: 0, appliedVersion: rows.applied.version, ...at });
      counts.updated += 1;
    } else if (config.appliedVersion === undefined || rows.applied.version > config.appliedVersion) {
      await ctx.db.patch(config._id, { project, appliedVersion: rows.applied.version, ...at });
      counts.updated += 1;
    } else {
      counts.unchanged += 1;
    }
  }
  return counts;
}

// ── Harnesses ────────────────────────────────────────────────────────────────

/** The code's harness defaults for an agent, as its project last reported them, or null. */
export async function harnessDefaultsOf(ctx: QueryCtx, project: string, agentId: string): Promise<HarnessDefaults | null> {
  const row = await ctx.db
    .query("agentHarnessDefaults")
    .withIndex("by_project_and_agentId", (q) => q.eq("project", project).eq("agentId", agentId))
    .unique();
  return row?.harness ?? null;
}

/** Store an agent's harness defaults as its project reported them, replacing what was there. */
export async function storeHarnessDefaults(
  ctx: MutationCtx,
  project: string,
  agentId: string,
  harness: HarnessDefaults,
  now: number,
) {
  const stored = await ctx.db
    .query("agentHarnessDefaults")
    .withIndex("by_project_and_agentId", (q) => q.eq("project", project).eq("agentId", agentId))
    .unique();
  const row = { project, agentId, harness, reportedAt: now };
  if (stored === null) await ctx.db.insert("agentHarnessDefaults", row);
  else await ctx.db.replace(stored._id, row);
}

/** One version of an agent's harness by its number, or null. */
export async function harnessVersionOf(ctx: QueryCtx, project: string, agentId: string, number: number) {
  return await ctx.db
    .query("agentHarnessVersions")
    .withIndex("by_project_agentId_and_number", (q) =>
      q.eq("project", project).eq("agentId", agentId).eq("number", number),
    )
    .unique();
}

/** A version's parts but its prompt, which may be kept apart: what can be read without it. */
export const shallowPartsOf = (row: Doc<"agentHarnessVersions">): Omit<HarnessParts, "prompt"> => ({
  ...(row.params === undefined ? {} : { params: row.params }),
  ...(row.tools === undefined ? {} : { tools: row.tools }),
  ...(row.outputSchema === undefined ? {} : { outputSchema: row.outputSchema }),
});

/** The variants a version's prompt has, without reading it: null where it keeps the code's prompt. */
export function promptVariantsOf(row: Doc<"agentHarnessVersions">): string[] | null {
  if (row.prompt !== undefined) return ["default"];
  return row.promptVariants ?? null;
}

/** A version's prompt: v1.1's inline, else its own row (v1.2). None: the code's. */
export async function promptOf(ctx: QueryCtx, row: Doc<"agentHarnessVersions">): Promise<PromptPart | undefined> {
  if (row.prompt !== undefined) return promptPartOf(row.prompt);
  if (row.promptVariants === undefined) return undefined;
  const stored = await ctx.db
    .query("agentHarnessPrompts")
    .withIndex("by_versionId", (q) => q.eq("versionId", row._id))
    .unique();
  return stored === null ? undefined : promptPartOf({ variants: stored.variants });
}

/** A version's parts, as convex/lib/agentHarness.ts reads them. */
export async function partsOf(ctx: QueryCtx, row: Doc<"agentHarnessVersions">): Promise<HarnessParts> {
  const prompt = await promptOf(ctx, row);
  return { ...(prompt === undefined ? {} : { prompt }), ...shallowPartsOf(row) };
}

/**
 * Keep a version's prompt in its own row, replacing what was there (none:
 * the code's), and return what the version row says of it.
 */
export async function writePrompt(
  ctx: MutationCtx,
  versionId: Id<"agentHarnessVersions">,
  prompt: PromptPart | undefined,
): Promise<{ promptVariants?: string[] }> {
  const stored = await ctx.db
    .query("agentHarnessPrompts")
    .withIndex("by_versionId", (q) => q.eq("versionId", versionId))
    .unique();
  if (prompt === undefined) {
    if (stored !== null) await ctx.db.delete(stored._id);
    return {};
  }
  if (stored === null) await ctx.db.insert("agentHarnessPrompts", { versionId, variants: prompt.variants });
  else await ctx.db.replace(stored._id, { versionId, variants: prompt.variants });
  return { promptVariants: variantNames(prompt.variants) };
}

/**
 * Whether an agent is held to providers for patient data: its project says
 * it handles patient data, or the harness version it runs switches on a tool
 * that does.
 */
export async function agentPhi(
  ctx: QueryCtx,
  project: string,
  agentId: string,
  harnessVersion: string | null | undefined,
): Promise<boolean> {
  const entry = (await catalogOf(ctx, project)).find((row) => row.agentId === agentId);
  if (entry?.phi === true) return true;
  const number = versionNumberOf(harnessVersion);
  if (number === null) return false;
  const version = await harnessVersionOf(ctx, project, agentId, number);
  if (version?.tools === undefined) return false;
  // An agent built here: its tools are its project's catalogue and its sub-agents.
  if (version.definition !== undefined) {
    return definitionPhi(version.tools, (await toolRowsOf(ctx, project)).map(asCatalogTool), await peersOf(ctx, project, agentId));
  }
  const defaults = await harnessDefaultsOf(ctx, project, agentId);
  return usesPhiTool(version.tools, defaults?.tools ?? []);
}

// ── Agents built here (Protocol v1.3) ────────────────────────────────────────

/** What an agent built for a project is held to: the project's policy, or Startup OS's. Null: no such project. */
export async function builderPolicyOf(ctx: QueryCtx, project: string): Promise<ProjectPolicy | null> {
  if (project === STARTUP_OS_PROJECT) return { ...STARTUP_OS_POLICY, name: INTERNAL_PROJECT_NAME, region: "US" };
  return await policyOf(ctx, project);
}

/** Whether an agent was built here, and by whom: its row, or null. */
export async function declaredOf(ctx: QueryCtx, project: string, agentId: string) {
  return await ctx.db
    .query("agentDeclared")
    .withIndex("by_project_and_agentId", (q) => q.eq("project", project).eq("agentId", agentId))
    .unique();
}

/** Every agent built here for a project. */
export async function declaredIn(ctx: QueryCtx, project: string) {
  return await ctx.db
    .query("agentDeclared")
    .withIndex("by_project_and_agentId", (q) => q.eq("project", project))
    .collect();
}

/** The tools a project last said it can execute (`toolsCatalog`), in id order. */
export async function toolRowsOf(ctx: QueryCtx, project: string): Promise<Doc<"agentTools">[]> {
  return await ctx.db
    .query("agentTools")
    .withIndex("by_project_and_toolId", (q) => q.eq("project", project))
    .collect();
}

export const asCatalogTool = (row: Doc<"agentTools">): CatalogTool => ({
  id: row.toolId,
  name: row.name,
  description: row.description,
  phi: row.phi,
  kind: row.kind,
  effect: row.effect,
  approvable: row.approvable,
});

/** An agent's published harness version, or null. */
export async function publishedVersionOf(ctx: QueryCtx, project: string, agentId: string) {
  return await ctx.db
    .query("agentHarnessVersions")
    .withIndex("by_project_agentId_and_status", (q) =>
      q.eq("project", project).eq("agentId", agentId).eq("status", "published"),
    )
    .first();
}

/**
 * The project's other agents built here, as their published versions have
 * them: the tool id each is offered as (none where it is not, or is not
 * published) and the tools it uses. What sub-agent references, cycles, depth
 * and patient data are worked out from.
 */
export async function peersOf(ctx: QueryCtx, project: string, except: string | null): Promise<Peer[]> {
  const peers: Peer[] = [];
  for (const row of await declaredIn(ctx, project)) {
    if (row.agentId === except) continue;
    const published = await publishedVersionOf(ctx, project, row.agentId);
    const definition = published?.definition;
    peers.push({
      agentId: row.agentId,
      name: definition?.name ?? row.agentId,
      toolId: definition?.triggers.subAgent?.toolId ?? null,
      description: definition?.triggers.subAgent?.description ?? "",
      tools: published?.tools ?? [],
    });
  }
  return peers;
}

/** How many rows of each table one call stamps at most. */
export const ADOPT_BATCH = 500;

/**
 * Stamp rows from before projects as the legacy project's, up to `limit` a
 * table. Returns how many it stamped; zero once none is left.
 */
export async function adoptLegacy(ctx: MutationCtx, limit = ADOPT_BATCH): Promise<number> {
  let stamped = 0;
  type Stamped = "agentUsage" | "agentProviders" | "agentControls" | "agentControlChanges" | "agentConfig";
  const stamp = async (rows: { _id: Id<Stamped> }[]) => {
    for (const row of rows) {
      // Every one of these tables has an optional `project`, and nothing else is set.
      await ctx.db.patch(row._id as Id<"agentUsage">, { project: LEGACY_PROJECT });
      stamped += 1;
    }
  };
  await stamp(
    await ctx.db
      .query("agentUsage")
      .withIndex("by_project_and_day", (q) => q.eq("project", undefined))
      .take(limit),
  );
  await stamp(
    await ctx.db
      .query("agentProviders")
      .withIndex("by_project_provider_and_model", (q) => q.eq("project", undefined))
      .take(limit),
  );
  await stamp(
    await ctx.db
      .query("agentControls")
      .withIndex("by_project_and_agentId", (q) => q.eq("project", undefined))
      .take(limit),
  );
  await stamp(
    await ctx.db
      .query("agentControlChanges")
      .withIndex("by_project_and_at", (q) => q.eq("project", undefined))
      .take(limit),
  );
  await stamp(
    await ctx.db
      .query("agentConfig")
      .withIndex("by_project", (q) => q.eq("project", undefined))
      .take(limit),
  );
  return stamped;
}

/** The days a read covers: `days` back from `today`. */
export const fromDay = (today: string, days: number) => addDays(today, -days);
