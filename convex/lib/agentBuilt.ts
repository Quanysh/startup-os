// What the rules for agents built here (convex/lib/agentBuilder.ts) read from
// the tables: a project's tool catalogue (Startup OS's own for `startup-os`),
// its policy, its other built agents, and an agent's published tool id.
// Shared by convex/agentHarness.ts (tests, publishing) and
// convex/agentBuilder.ts (the builder, runs, tools).
//
// Runs only inside Convex: never import it from the UI.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  declarativeDefaults,
  usesOwnerOnlyTools,
  type BuilderContext,
  type CatalogTool,
  type Definition,
} from "./agentBuilder";
import { asCatalogTool, builderPolicyOf, controlOf, declaredOf, peersOf, publishedVersionOf, toolRowsOf, type ProjectPolicy } from "./agentData";
import type { HarnessDefaults, HarnessParts } from "./agentHarness";
import { STARTUP_OS_PROJECT } from "./agentStartupOs";
import { runsOnOf } from "./osAgents";
import { startupOsCatalog } from "./agentStartupOsTools";
import { isOwner, NOT_ALLOWED, type Member } from "./owner";
import { may, type Area } from "./roles";

/** A catalogue tool with what the Tools tab shows besides. */
export type ToolView = CatalogTool & { inputSchema: string; lastReportedAt: number | null };

/** A project's tools: what it last reported, or Startup OS's own for `startup-os`. */
export async function builderToolsOf(ctx: QueryCtx, project: string): Promise<ToolView[]> {
  if (project === STARTUP_OS_PROJECT) return startupOsCatalog().map((tool) => ({ ...tool, lastReportedAt: null }));
  return (await toolRowsOf(ctx, project)).map((row) => ({
    ...asCatalogTool(row),
    inputSchema: row.inputSchema,
    lastReportedAt: row.lastReportedAt,
  }));
}

export { builderPolicyOf };

/** Everything a version of an agent built here is checked against. */
export async function builderContextOf(
  ctx: QueryCtx,
  policy: ProjectPolicy,
  agentId: string,
  options: { publishing: boolean; ownerPublishing?: boolean },
): Promise<BuilderContext> {
  const published = await publishedVersionOf(ctx, policy.slug, agentId);
  return {
    agentId,
    catalog: await builderToolsOf(ctx, policy.slug),
    peers: await peersOf(ctx, policy.slug, agentId),
    policy: { holdsPatientData: policy.holdsPatientData, allowedProviders: policy.allowedProviders },
    publishing: options.publishing,
    publishedToolId: published?.definition?.triggers.subAgent?.toolId ?? null,
    ...(options.ownerPublishing === undefined ? {} : { ownerPublishing: options.ownerPublishing }),
    ...(policy.slug === STARTUP_OS_PROJECT ? { runsHere: true } : {}),
    ...(runsOnOf(policy.slug, agentId, (await controlOf(ctx, policy.slug, agentId))?.runsOn) === "claude_mac" ? { macRun: true } : {}),
  };
}

/** A version's definition, as the rules read it (stored and read alike). */
export const definitionOfRow = (row: Doc<"agentHarnessVersions">): Definition | null => row.definition ?? null;

/** What a built agent's harness is checked against in place of a code's defaults. */
export const defaultsFor = (definition: Definition, parts: HarnessParts, context: BuilderContext): HarnessDefaults =>
  declarativeDefaults(definition, parts, context.catalog, context.peers);

/** Whether an agent's runs and outputs are the owner's alone: a Startup OS agent using an owner-only tool. */
export function ownerOnlyRuns(project: string, tools: readonly string[], context: BuilderContext): boolean {
  return project === STARTUP_OS_PROJECT && usesOwnerOnlyTools(tools, context.catalog, context.peers);
}

/** Every tool any version of an agent switched on: what its runs may have used. */
async function everyToolOf(ctx: QueryCtx, project: string, agentId: string): Promise<string[]> {
  const versions = await ctx.db
    .query("agentHarnessVersions")
    .withIndex("by_project_agentId_and_number", (q) => q.eq("project", project).eq("agentId", agentId))
    .collect();
  return [...new Set(versions.flatMap((row) => row.tools ?? []))];
}

/**
 * Whether a member may read an agent's runs: anyone with `agents`, but the
 * owner alone for a Startup OS agent any version of which uses an owner-only
 * tool (directly or through a sub-agent). Refused in the words of a missing
 * permission.
 */
export async function requireRunsReader(ctx: QueryCtx, member: Member, project: string, agentId: string) {
  if (project !== STARTUP_OS_PROJECT || isOwner(member)) return;
  if ((await declaredOf(ctx, project, agentId)) === null) return;
  // An answer kept as the owner's makes the agent's runs the owner's, whatever is published since.
  const ownerOnlyAnswer = await ctx.db
    .query("agentRunOutputs")
    .withIndex("by_project_agentId_and_ownerOnly", (q) => q.eq("project", project).eq("agentId", agentId).eq("ownerOnly", true))
    .first();
  if (ownerOnlyAnswer !== null) throw new ConvexError(NOT_ALLOWED);
  const policy = (await builderPolicyOf(ctx, project))!;
  const context = await builderContextOf(ctx, policy, agentId, { publishing: false });
  if (usesOwnerOnlyTools(await everyToolOf(ctx, project, agentId), context.catalog, context.peers)) {
    throw new ConvexError(NOT_ALLOWED);
  }
}

/**
 * Whether a member may read a Startup OS run's answer, by what was decided when
 * it was kept (`agentRunOutputs.ownerOnly` and `areas`): the owner always; an
 * owner-only answer nobody else; any other, whoever holds every one of its
 * pages. Never by what is published since.
 */
export function mayReadOutput(member: Member, kept: { ownerOnly: boolean; areas: readonly string[] }): boolean {
  if (isOwner(member)) return true;
  if (kept.ownerOnly) return false;
  return kept.areas.every((area) => may(member, area as Area));
}
