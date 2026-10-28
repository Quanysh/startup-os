import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { SOURCES } from "./connectors/manifest";
import { failureKeyOf, type Cadence, type FailureKey } from "./lib/cadence";
import { sourceOn } from "./lib/featureGates";
import type { CompanyId } from "./lib/company";
import { SOURCE_IDS, type SourceId } from "./lib/metricRegistry";
import { MIRROR_SOURCES } from "./lib/mirrorRules";
import { memberQuery, type Member } from "./lib/owner";
import {
  PAGE_SOURCES,
  figuresOf,
  isFreshnessPage,
  type FreshnessPage,
} from "./lib/pageSources";
import { holderOf, personalStatus } from "./lib/personal";
import { ANY_AREA, may } from "./lib/roles";
import { maySeeMetric } from "./metrics";
import { companyValidator } from "./schema";

/** The words for figures typed into the OS, where a page lists them beside its sources. */
export const TYPED_LABEL = "Typed-in figures";
/** Typed-in buckets read per figure for the newest entry: about a year of months. */
const TYPED_BUCKETS = 13;

export type SourceReading = {
  id: SourceId;
  label: string;
  cadence: Cadence;
  lastOkAt: number | null;
  lastRunAt: number | null;
  /** The stored state of the last run; null when it has never run. */
  state: "ok" | "error" | "empty" | "not_configured" | null;
  /** Why the last run is not a good one, as a key: never the message it stored. */
  failureKey: FailureKey | null;
};

const defOf = (id: SourceId) => SOURCES.find((s) => s.id === id)!;

function present(
  id: SourceId,
  status: { state?: SourceReading["state"]; lastRunAt?: number; lastOkAt?: number } | null,
  cadence: Cadence = defOf(id).cadence,
): SourceReading {
  const state = status?.state ?? null;
  return {
    id,
    label: id === "manual" ? TYPED_LABEL : defOf(id).label,
    cadence,
    lastOkAt: status?.lastOkAt ?? null,
    lastRunAt: status?.lastRunAt ?? null,
    state,
    failureKey: failureKeyOf(state),
  };
}

const deploymentStatus = (ctx: QueryCtx, source: string) =>
  ctx.db
    .query("sourceStatus")
    .withIndex("by_source", (q) => q.eq("source", source))
    .unique();

/**
 * The sources behind one page's data in one company's view, each gated as
 * that data is gated: a source whose figures the caller is not sent is left
 * out (never shown as hidden), so the answer says nothing about what exists.
 *
 * - A figure's source: sent if the caller is sent one of that source's
 *   figures on this page in this company (`maySeeMetric`, the scorecard's
 *   own rule). Typed-in figures are one row whose time is the newest entry
 *   among the page's typed-in figures the caller may see.
 * - A source that carries no figure: the page's own area, and a company it
 *   serves on that page.
 * - Today: the caller's own four work tools, and nobody else's: the owner's
 *   are the deployment's state, a teammate's their own `personalSourceStatus`.
 *
 * A caller without the page's area, a company they are not on, or a page
 * this does not know: an empty list. Never reads the clock: times only.
 */
export async function freshnessFor(
  ctx: QueryCtx,
  member: Member,
  page: string,
  company: CompanyId,
): Promise<SourceReading[]> {
  if (!isFreshnessPage(page) || !member.companies.includes(company)) return [];
  const found = new Map<SourceId, SourceReading>();
  await collect(ctx, member, page, company, found);
  // In the registry's order, as `pageSources` gives them.
  return SOURCE_IDS.flatMap((id) => {
    const row = found.get(id);
    return row === undefined ? [] : [row];
  });
}

async function collect(
  ctx: QueryCtx,
  member: Member,
  page: FreshnessPage,
  company: CompanyId,
  found: Map<SourceId, SourceReading>,
) {
  const spec = PAGE_SOURCES[page];
  if (spec.area !== undefined && !may(member, spec.area)) return;
  for (const sub of spec.of ?? []) await collect(ctx, member, sub, company, found);

  // The page's figures the caller is sent, by source.
  const typed: number[] = [];
  for (const { metric, scope, source } of figuresOf(page, company)) {
    if (!maySeeMetric(member, metric, scope)) continue;
    if (source === "manual") {
      const rows = await ctx.db
        .query("metricSnapshots")
        .withIndex("by_key_and_scope_and_period_and_periodStart", (q) =>
          q.eq("key", metric.key).eq("scope", scope).eq("period", metric.grain),
        )
        .order("desc")
        .take(TYPED_BUCKETS);
      for (const row of rows) if (row.source === "manual") typed.push(row.syncedAt);
      if (!found.has("manual")) found.set("manual", present("manual", null));
      continue;
    }
    // A source a switched-off feature takes away is never late: it is not read (convex/lib/featureGates.ts).
    if (!sourceOn(source)) continue;
    if (!found.has(source)) found.set(source, present(source, await deploymentStatus(ctx, source)));
  }
  if (found.has("manual") && typed.length > 0) {
    const newest = Math.max(...typed, found.get("manual")!.lastOkAt ?? 0);
    found.set("manual", present("manual", { state: "ok", lastOkAt: newest, lastRunAt: newest }));
  }

  for (const list of spec.lists ?? []) {
    if (!list.companies.includes(company) || found.has(list.source) || !sourceOn(list.source)) continue;
    found.set(list.source, present(list.source, await deploymentStatus(ctx, list.source)));
  }

  // A person's own tools, for one who holds `today`: each person's own.
  if (spec.own && may(member, "today")) {
    const holder = holderOf(member);
    if (holder.kind === "owner") {
      // A tool the owner switched off is not read, so it is not late either.
      const off = (await ctx.db.query("workToolSettings").first())?.off ?? [];
      for (const tool of MIRROR_SOURCES) {
        if (off.includes(tool)) continue;
        found.set(tool, present(tool, await deploymentStatus(ctx, tool)));
      }
    } else {
      for (const tool of MIRROR_SOURCES) {
        const row = await personalStatus(ctx, holder, tool);
        found.set(tool, present(tool, row, defOf(tool).personal));
      }
    }
  }
}

/**
 * What one page's header says about how fresh its data is: each source it
 * draws on in the company in view, with the last good read, the last run, its
 * stored state and its expected cadence. Gated per source in `freshnessFor`.
 */
export const forPage = memberQuery(ANY_AREA)({
  args: { page: v.string(), company: companyValidator },
  handler: (ctx, args) => freshnessFor(ctx, ctx.member, args.page, args.company),
});
