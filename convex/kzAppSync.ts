import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { appNameKey } from "./lib/kzAppLink";
import { DOCTOR_WEEKS, TRIAL_OUTCOMES } from "./lib/kzProductDetail";

// What the PostHog run for Globex's app writes besides numbers: each
// clinic's link to Customers, its weeks of usage, its doctors and the
// breakdowns. Internal: only `connectors/posthogGlobex` calls these.
//
// A clinic's name arrives only to be compared with Customers' names, and is
// stored nowhere. A doctor's name is stored on `customerDoctors` alone. No
// name goes in a log or a thrown error.

const plan = v.optional(v.union(v.literal("paid"), v.literal("trial")));
const counts = v.record(v.string(), v.number());
const doctorWeek = v.union(...DOCTOR_WEEKS.map((w) => v.literal(w)));
const clinicWeek = v.object({
  weekStart: v.string(),
  checks: v.number(),
  actions: v.number(),
  doctors: v.number(),
  activeDays: v.number(),
  lastActiveOn: v.optional(v.string()),
  plan,
  failures: v.number(),
  modules: counts,
});
const doctor = v.object({
  org: v.string(),
  doctorId: v.string(),
  name: v.string(),
  weekStart: v.string(),
  week: doctorWeek,
  weekBefore: v.optional(doctorWeek),
  actions: v.number(),
  previous: v.optional(v.number()),
  usual: v.optional(v.number()),
  activeDays: v.number(),
  lastActiveOn: v.optional(v.string()),
  lastEvent: v.optional(v.string()),
  mainModule: v.optional(v.string()),
  plan,
  trialEndedOn: v.optional(v.string()),
  trialOutcome: v.optional(v.union(...TRIAL_OUTCOMES.map((t) => v.literal(t)))),
  actionsBeforeTrialEnd: v.optional(v.number()),
  actionsAfterTrialEnd: v.optional(v.number()),
  modules: counts,
  modulesPrevious: v.optional(counts),
  history: v.array(v.object({ weekStart: v.string(), actions: v.number(), days: v.number(), modules: counts })),
});

/** At most this many clinics in Customers are read to link against. */
const MAX_CUSTOMERS = 2000;

/**
 * Link each clinic the app knows to its row in Customers: kept where it is
 * linked already (an archived clinic's link included, so its app id is never
 * given to a second clinic), else by a name that matches exactly one
 * Kazakhstan clinic not yet linked and not unlinked from that id by hand.
 * Then record each with its latest week, linked or not.
 */
export const linkClinics = internalMutation({
  args: {
    syncedAt: v.number(),
    clinics: v.array(
      v.object({
        org: v.string(),
        name: v.string(),
        weeks: v.number(),
        actions: v.number(),
        doctors: v.number(),
        lastActiveOn: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const customers = (await ctx.db.query("customers").take(MAX_CUSTOMERS)).filter((c) => c.market === "kz");
    const linked = new Map(customers.filter((c) => c.appOrgId !== undefined).map((c) => [c.appOrgId!, c._id]));
    const free = new Map<string, Doc<"customers">[]>();
    for (const c of customers) {
      if (c.appOrgId !== undefined || c.archivedAt !== undefined) continue;
      const key = appNameKey(c.name);
      free.set(key, [...(free.get(key) ?? []), c]);
    }
    let linkedNow = 0;
    const seen = new Set<string>();
    for (const clinic of args.clinics) {
      seen.add(clinic.org);
      let customerId = linked.get(clinic.org);
      if (customerId === undefined && clinic.name !== "") {
        const matches = free.get(appNameKey(clinic.name)) ?? [];
        // One clinic of that name, and only one: never a guess between two.
        // Nor a link someone took apart by hand.
        if (matches.length === 1 && !(matches[0]!.appOrgUnlinked ?? []).includes(clinic.org)) {
          customerId = matches[0]!._id;
          await ctx.db.patch(customerId, { appOrgId: clinic.org });
          free.delete(appNameKey(clinic.name));
          linked.set(clinic.org, customerId);
          linkedNow += 1;
        }
      }
      const fields = {
        org: clinic.org,
        customerId,
        weeks: clinic.weeks,
        actions: clinic.actions,
        doctors: clinic.doctors,
        lastActiveOn: clinic.lastActiveOn,
        syncedAt: args.syncedAt,
      };
      const row = await ctx.db
        .query("kzAppClinics")
        .withIndex("by_org", (q) => q.eq("org", clinic.org))
        .unique();
      if (row === null) await ctx.db.insert("kzAppClinics", fields);
      else await ctx.db.replace(row._id, fields);
    }
    // A clinic the app no longer reports is not listed as waiting for a link.
    for (const row of await ctx.db.query("kzAppClinics").take(MAX_CUSTOMERS)) {
      if (!seen.has(row.org)) await ctx.db.delete(row._id);
    }
    return { clinics: args.clinics.length, linkedNow };
  },
});

async function customerOf(ctx: MutationCtx, org: string): Promise<Id<"customers"> | null> {
  const row = await ctx.db
    .query("kzAppClinics")
    .withIndex("by_org", (q) => q.eq("org", org))
    .unique();
  return row?.customerId ?? null;
}

/** Each linked clinic's weeks of usage and its doctors, replaced by what PostHog says now. */
export const applyClinics = internalMutation({
  args: {
    syncedAt: v.number(),
    clinics: v.array(v.object({ org: v.string(), weeks: v.array(clinicWeek) })),
    doctors: v.array(doctor),
  },
  handler: async (ctx, args) => {
    let written = 0;
    for (const clinic of args.clinics) {
      const customerId = await customerOf(ctx, clinic.org);
      // Not linked to Customers yet: nothing is written under a clinic nobody has named.
      if (customerId === null) continue;

      const usage = await ctx.db
        .query("customerUsage")
        .withIndex("by_customerId_and_weekStart", (q) => q.eq("customerId", customerId))
        .take(200);
      const byWeek = new Map(usage.map((u) => [u.weekStart, u]));
      for (const week of clinic.weeks) {
        const fields = { customerId, ...week, syncedAt: args.syncedAt };
        const current = byWeek.get(week.weekStart);
        if (current === undefined) await ctx.db.insert("customerUsage", fields);
        else await ctx.db.replace(current._id, fields);
        written += 1;
      }

      const theirs = args.doctors.filter((d) => d.org === clinic.org);
      const existing = await ctx.db
        .query("customerDoctors")
        .withIndex("by_customerId_and_doctorId", (q) => q.eq("customerId", customerId))
        .take(1000);
      const byDoctor = new Map<string, Doc<"customerDoctors">>(existing.map((d) => [d.doctorId, d]));
      const kept = new Set<string>();
      for (const { org: _org, ...d } of theirs) {
        kept.add(d.doctorId);
        const fields = { customerId, ...d, syncedAt: args.syncedAt };
        const current = byDoctor.get(d.doctorId);
        if (current === undefined) await ctx.db.insert("customerDoctors", fields);
        else await ctx.db.replace(current._id, fields);
      }
      // A doctor who moved clinic, or is gone from the app, leaves this roster.
      for (const d of existing) if (!kept.has(d.doctorId)) await ctx.db.delete(d._id);
    }
    return { written };
  },
});

/** One kind of breakdown, its weeks replaced whole. */
export const applyBreakdowns = internalMutation({
  args: {
    syncedAt: v.number(),
    kind: v.union(v.literal("hour"), v.literal("page"), v.literal("event"), v.literal("field")),
    weeks: v.array(v.string()),
    rows: v.array(v.object({ weekStart: v.string(), key: v.string(), values: counts })),
  },
  handler: async (ctx, args) => {
    for (const weekStart of args.weeks) {
      const old = await ctx.db
        .query("kzBreakdowns")
        .withIndex("by_kind_and_weekStart", (q) => q.eq("kind", args.kind).eq("weekStart", weekStart))
        .take(2000);
      for (const row of old) await ctx.db.delete(row._id);
    }
    const weeks = new Set(args.weeks);
    for (const row of args.rows) {
      if (!weeks.has(row.weekStart)) continue;
      await ctx.db.insert("kzBreakdowns", { kind: args.kind, ...row, syncedAt: args.syncedAt });
    }
    return { rows: args.rows.length };
  },
});
