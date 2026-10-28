import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { COMPANIES } from "./lib/company";
import {
  MARKET_CURRENCY,
  REGISTER_SOURCE,
  SALES_SOURCE,
  nameKeyOf,
  type CustomerRow,
} from "./lib/customerShape";
import { CUSTOMER_WORDS, shrinksTooFar } from "./lib/customerRules";
import { requireFeature } from "./lib/featureGates";
import { APP_ORG_ID } from "./lib/kzAppLink";
import { MAX_NOTES_LENGTH } from "./lib/limits";
import { memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { cleanText } from "./lib/text";
import { customerStatusValidator, marketValidator } from "./schema";
import { setSourceStatus } from "./snapshots";

// Clinics. This file, the `customers` table and the won-deal rule that writes
// a won deal's name into it (convex/lib/wonCustomers.ts) are the only places a
// client's name is handled inside Convex. Nothing here puts a name in a thrown
// error, a run-log message or a source's status.

/** Rows of the `deals` source read for the list: far more than Sales will ever win. */
const SALES_ROWS = 1_000;

function present(c: Doc<"customers">): CustomerRow {
  return {
    id: c._id,
    name: c.name,
    market: c.market,
    status: c.status,
    monthlyFee: c.monthlyFee ?? null,
    currency: c.currency,
    lastPaymentDate: c.lastPaymentDate ?? null,
    amountOwed: c.amountOwed ?? null,
    lastUsageDate: c.lastUsageDate ?? null,
    contractDate: c.contractDate ?? null,
    baaDate: c.baaDate ?? null,
    nextTouch: c.nextTouch ?? null,
    note: c.note ?? null,
    syncedAt: c.syncedAt,
    archived: c.archivedAt !== undefined,
    dealId: c.dealId ?? null,
    fromSales: c.source === SALES_SOURCE,
  };
}

/**
 * Every clinic, archived ones included, in name order, and when the register
 * was last pushed. Health is not computed here: it depends on today's date,
 * which a query must not read (src/lib/customers/health.ts).
 *
 * Beside the register's clinics, the ones won on the Sales board that the
 * register does not carry yet (`fromSales`). One of those that is archived
 * (its deal left Won, or the register now carries the clinic) is not sent:
 * it is no clinic of anyone's.
 *
 * What the query returns and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function, so the two cannot drift.
 */
export async function customersFor(ctx: QueryCtx, member: Member) {
  {
    // The index puts them in nameKey order.
    const register = await ctx.db
      .query("customers")
      .withIndex("by_source_and_nameKey", (q) => q.eq("source", REGISTER_SOURCE))
      .collect();
    const won = await ctx.db
      .query("customers")
      .withIndex("by_source_and_nameKey", (q) => q.eq("source", SALES_SOURCE))
      .take(SALES_ROWS);
    const rows = [...register, ...won.filter((row) => row.archivedAt === undefined)].sort((a, b) =>
      a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0,
    );
    const status = await ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", REGISTER_SOURCE))
      .unique();
    // A clinic of a market the caller is not on is never sent.
    const theirs = rows.filter((row) => member.companies.includes(row.market));
    return { customers: theirs.map(present), lastPushAt: status?.lastOkAt ?? null };
  }
}

export const list = memberQuery("customers")({
  args: {},
  handler: (ctx) => customersFor(ctx, ctx.member),
});

function presentDoctor(r: Doc<"customerDoctors">) {
  return {
    customerId: r.customerId,
    doctorId: r.doctorId,
    name: r.name,
    weekStart: r.weekStart,
    week: r.week,
    weekBefore: r.weekBefore ?? null,
    actions: r.actions,
    previous: r.previous ?? null,
    usual: r.usual ?? null,
    activeDays: r.activeDays ?? null,
    lastActiveOn: r.lastActiveOn ?? null,
    lastEvent: r.lastEvent ?? null,
    mainModule: r.mainModule ?? null,
    plan: r.plan ?? null,
    trialEndedOn: r.trialEndedOn ?? null,
    trialOutcome: r.trialOutcome ?? null,
    actionsBeforeTrialEnd: r.actionsBeforeTrialEnd ?? null,
    actionsAfterTrialEnd: r.actionsAfterTrialEnd ?? null,
    modules: r.modules,
    modulesPrevious: r.modulesPrevious ?? {},
    history: r.history ?? [],
  };
}

/** At most this many doctors in the whole list: the weekly report keeps 300. */
export const MAX_ROSTER = 300;

/**
 * Every doctor of the caller's Kazakhstan clinics, for Product › Kazakhstan's
 * Doctors, Modules and Clinics tabs: names under the same rule as `doctors`
 * (the Customers page, the clinic's own market). Each row says its clinic by
 * id; the clinic's name is `list`'s.
 */
export const doctorRoster = memberQuery("customers")({
  args: {},
  handler: async (ctx) => {
    const { customers } = await customersFor(ctx, ctx.member);
    const out: ReturnType<typeof presentDoctor>[] = [];
    for (const clinic of customers) {
      if (clinic.archived || out.length >= MAX_ROSTER) continue;
      const rows = await ctx.db
        .query("customerDoctors")
        .withIndex("by_customerId_and_doctorId", (q) => q.eq("customerId", clinic.id))
        .take(MAX_ROSTER - out.length);
      out.push(...rows.map(presentDoctor));
    }
    return out;
  },
});

/** At most this many doctors a clinic is sent: a clinic's staff, never a list without end. */
export const MAX_DOCTORS = 200;

/**
 * One clinic's doctors and their last week in Globex's app. Names are
 * personal data: sent only for a clinic of the caller's markets, with the
 * Customers page, and only here. A clinic of another market is refused in the
 * words of one that is gone, so an id tells nothing.
 */
export const doctors = memberQuery("customers")({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const clinic = await ctx.db.get(args.customerId);
    if (clinic === null || !ctx.member.companies.includes(clinic.market)) {
      throw new ConvexError("That clinic is no longer in the list.");
    }
    const rows = await ctx.db
      .query("customerDoctors")
      .withIndex("by_customerId_and_doctorId", (q) => q.eq("customerId", args.customerId))
      .take(MAX_DOCTORS);
    return rows.map(presentDoctor);
  },
});

/** The finished weeks of usage sent per clinic: a year, so a period may reach back that far. */
export const USAGE_WEEKS = 53;

/**
 * Each clinic's weekly use of the app, newest week last, for the clinics of
 * the caller's markets (the same rule as `list`). Counts only; the name is
 * `list`'s, joined in the browser by id.
 */
export const usage = memberQuery("customers")({
  args: {},
  handler: async (ctx) => {
    const { customers } = await customersFor(ctx, ctx.member);
    const out: {
      customerId: Doc<"customers">["_id"];
      weeks: {
        weekStart: string;
        checks: number;
        actions: number;
        doctors: number;
        doctorsTotal: number | null;
        activeDays: number | null;
        lastActiveOn: string | null;
        plan: "paid" | "trial" | null;
        failures: number;
        modules: Record<string, number>;
      }[];
    }[] = [];
    for (const clinic of customers) {
      const rows = await ctx.db
        .query("customerUsage")
        .withIndex("by_customerId_and_weekStart", (q) => q.eq("customerId", clinic.id))
        .order("desc")
        .take(USAGE_WEEKS);
      if (rows.length === 0) continue;
      out.push({
        customerId: clinic.id,
        weeks: rows.reverse().map((r) => ({
          weekStart: r.weekStart,
          checks: r.checks,
          actions: r.actions,
          doctors: r.doctors,
          doctorsTotal: r.doctorsTotal ?? null,
          activeDays: r.activeDays ?? null,
          lastActiveOn: r.lastActiveOn ?? null,
          plan: r.plan ?? null,
          failures: r.failures,
          modules: r.modules,
        })),
      });
    }
    return out;
  },
});

/**
 * Whether a deal is on Customers: a clinic on the list is linked to it (one
 * it made, or the register's). For the deal's page, so Sales; a deal of a
 * company the caller is not on is refused. No clinic is named.
 */
export const ofDeal = memberQuery("sales")({
  // A string: the deal's page passes the id its address holds, which may be
  // no id at all. That, like a deal that is gone, is not on Customers.
  args: { dealId: v.string() },
  handler: async (ctx, args) => {
    const dealId = ctx.db.normalizeId("deals", args.dealId);
    const deal = dealId === null ? null : await ctx.db.get(dealId);
    if (deal === null) return { onCustomers: false };
    requireCompany(ctx.member, deal.market);
    const linked = await ctx.db
      .query("customers")
      .withIndex("by_dealId", (q) => q.eq("dealId", deal._id))
      .take(20);
    return { onCustomers: linked.some((row) => row.archivedAt === undefined) };
  },
});

/** The owner's two fields of a clinic, as an edit: null clears one; leaving it out keeps it. */
export type OwnerFieldsEdit = {
  id: Id<"customers">;
  note?: string | null | undefined;
  nextTouch?: string | null | undefined;
};

/**
 * Set the owner's own two fields of a clinic of a market the member is on.
 * What the page's form runs and what the owner's agent runs
 * (`customer_update`, convex/lib/mcpTools.ts): one function, so the two
 * cannot drift. It takes nothing else: every other field belongs to the
 * client register.
 */
export async function setCustomerOwnerFields(ctx: MutationCtx, member: Member, args: OwnerFieldsEdit): Promise<null> {
  const customer = await ctx.db.get(args.id);
  if (!customer) throw new ConvexError(CUSTOMER_WORDS.gone);
  requireCompany(member, customer.market);
  if (args.nextTouch != null && !isCanonicalPeriodStart("day", args.nextTouch)) {
    // Fixed words: nothing typed into this form is echoed back.
    throw new ConvexError(CUSTOMER_WORDS.notADate);
  }
  await ctx.db.patch(args.id, {
    ...(args.note !== undefined
      ? {
          note:
            args.note === null
              ? undefined
              : cleanText(args.note, MAX_NOTES_LENGTH, "That note") || undefined,
        }
      : null),
    ...(args.nextTouch !== undefined ? { nextTouch: args.nextTouch ?? undefined } : null),
  });
  return null;
}

/**
 * The owner's own two fields. null clears one; leaving it out keeps it. It
 * takes nothing else: every other field belongs to the client register.
 */
export const setOwnerFields = memberMutation("customers")({
  args: {
    id: v.id("customers"),
    note: v.optional(v.union(v.string(), v.null())),
    nextTouch: v.optional(v.union(v.string(), v.null())),
  },
  handler: (ctx, args) => setCustomerOwnerFields(ctx, ctx.member, args),
});

/**
 * How many usage or doctor rows one mutation deletes while a clinic's link
 * changes. A full read means more remain, so the rest is scheduled.
 */
const DROP_APP_LINK_BATCH = 200;

type DropAppLink = {
  customerId: Id<"customers">;
  /** Rows written before this belong to the link being cleared. */
  syncedBefore: number;
  usageAfter?: string;
  usageDone: boolean;
  doctorsAfter?: string;
  doctorsDone: boolean;
};

/**
 * Delete one batch of the usage and doctor rows written under a clinic before
 * `syncedBefore`, and say where the next batch starts. A row written at or
 * after that time belongs to a later run and stays. Done when both reads come
 * back short.
 */
async function dropAppLinkBatch(ctx: MutationCtx, args: DropAppLink): Promise<DropAppLink | null> {
  let { usageAfter, usageDone, doctorsAfter, doctorsDone } = args;
  if (!usageDone) {
    const usage = await ctx.db
      .query("customerUsage")
      .withIndex("by_customerId_and_weekStart", (q) =>
        usageAfter === undefined
          ? q.eq("customerId", args.customerId)
          : q.eq("customerId", args.customerId).gt("weekStart", usageAfter),
      )
      .take(DROP_APP_LINK_BATCH);
    for (const row of usage) {
      if (row.syncedAt < args.syncedBefore) await ctx.db.delete(row._id);
    }
    if (usage.length < DROP_APP_LINK_BATCH) usageDone = true;
    else {
      const last = usage[usage.length - 1]!.weekStart;
      // A cursor that does not move would schedule the same read forever.
      if (usageAfter !== undefined && last <= usageAfter) usageDone = true;
      else usageAfter = last;
    }
  }
  if (!doctorsDone) {
    const doctors = await ctx.db
      .query("customerDoctors")
      .withIndex("by_customerId_and_doctorId", (q) =>
        doctorsAfter === undefined
          ? q.eq("customerId", args.customerId)
          : q.eq("customerId", args.customerId).gt("doctorId", doctorsAfter),
      )
      .take(DROP_APP_LINK_BATCH);
    for (const row of doctors) {
      if (row.syncedAt < args.syncedBefore) await ctx.db.delete(row._id);
    }
    if (doctors.length < DROP_APP_LINK_BATCH) doctorsDone = true;
    else {
      const last = doctors[doctors.length - 1]!.doctorId;
      if (doctorsAfter !== undefined && last <= doctorsAfter) doctorsDone = true;
      else doctorsAfter = last;
    }
  }
  if (usageDone && doctorsDone) return null;
  return { customerId: args.customerId, syncedBefore: args.syncedBefore, usageAfter, usageDone, doctorsAfter, doctorsDone };
}

/** The rest of `setAppClinic`'s cleanup, one batch at a time, until both tables are done. */
export const dropAppLinkRows = internalMutation({
  args: {
    customerId: v.id("customers"),
    syncedBefore: v.number(),
    usageAfter: v.optional(v.string()),
    usageDone: v.boolean(),
    doctorsAfter: v.optional(v.string()),
    doctorsDone: v.boolean(),
  },
  handler: async (ctx, args) => {
    const next = await dropAppLinkBatch(ctx, args);
    if (next !== null) await ctx.scheduler.runAfter(0, internal.customers.dropAppLinkRows, next);
    return null;
  },
});

/** App clinic ids a clinic remembers as unlinked by hand, newest kept. */
const MAX_APP_UNLINKED = 20;

/**
 * Link a Kazakhstan clinic to its clinic in Globex's app, by the app's id
 * for it (`kzProduct.appClinics` lists the ones not linked), or unlink it
 * with null. Its usage and doctors are written under the link from the next
 * PostHog run. Changing or clearing the link removes what was written under
 * it, in batches until every row from before the change is gone. A link let
 * go here is remembered (`appOrgUnlinked`), so the next PostHog run does not
 * make it again by name.
 */
export const setAppClinic = memberMutation("customers", "kz")({
  args: { id: v.id("customers"), org: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    requireFeature("kzProduct");
    const customer = await ctx.db.get(args.id);
    if (!customer) throw new ConvexError("That clinic is no longer in the list.");
    requireCompany(ctx.member, customer.market);
    if (customer.market !== "kz") throw new ConvexError(`Only a clinic in Kazakhstan uses ${COMPANIES.kz.name}'s app.`);
    if (args.org !== null) {
      if (!APP_ORG_ID.test(args.org)) throw new ConvexError("That is not a clinic's id in the app.");
      const known = await ctx.db
        .query("kzAppClinics")
        .withIndex("by_org", (q) => q.eq("org", args.org!))
        .unique();
      if (known === null) throw new ConvexError("The app has no clinic with that id.");
      const taken = await ctx.db
        .query("customers")
        .withIndex("by_appOrgId", (q) => q.eq("appOrgId", args.org!))
        .first();
      if (taken !== null && taken._id !== args.id) throw new ConvexError("That app clinic is linked to another clinic.");
      await ctx.db.patch(known._id, { customerId: args.id });
    }
    // The link it had before, if another, is let go, with what was written under
    // it before this change. A full batch schedules the rest.
    if (customer.appOrgId !== undefined && customer.appOrgId !== args.org) {
      const before = await ctx.db
        .query("kzAppClinics")
        .withIndex("by_org", (q) => q.eq("org", customer.appOrgId!))
        .unique();
      if (before !== null) await ctx.db.patch(before._id, { customerId: undefined });
      const next = await dropAppLinkBatch(ctx, {
        customerId: args.id,
        syncedBefore: Date.now(),
        usageDone: false,
        doctorsDone: false,
      });
      if (next !== null) await ctx.scheduler.runAfter(0, internal.customers.dropAppLinkRows, next);
    }
    // A link let go by hand stays let go: the PostHog run does not make it
    // again by name. Linking an id by hand takes it off that list.
    const unlinked = (customer.appOrgUnlinked ?? []).filter((org) => org !== args.org);
    if (customer.appOrgId !== undefined && customer.appOrgId !== args.org && !unlinked.includes(customer.appOrgId)) {
      unlinked.push(customer.appOrgId);
    }
    await ctx.db.patch(args.id, {
      appOrgId: args.org ?? undefined,
      appOrgUnlinked: unlinked.length > 0 ? unlinked.slice(-MAX_APP_UNLINKED) : undefined,
    });
    return null;
  },
});

const registerRow = v.object({
  name: v.string(),
  market: marketValidator,
  status: customerStatusValidator,
  monthlyFee: v.optional(v.number()),
  lastPaymentDate: v.optional(v.string()),
  amountOwed: v.optional(v.number()),
  lastUsageDate: v.optional(v.string()),
  contractDate: v.optional(v.string()),
  baaDate: v.optional(v.string()),
});

// What a push owns. `note` and `nextTouch` are deliberately not here.
const SOURCE_FIELDS = [
  "name",
  "market",
  "status",
  "monthlyFee",
  "lastPaymentDate",
  "amountOwed",
  "lastUsageDate",
  "contractDate",
  "baaDate",
] as const;

/**
 * The register now carries a clinic Sales won: the row Sales made (same name
 * key and market, of the `deals` source, on the list) is archived, and its
 * deal link, note and next touch move to the register's row where that has
 * none. The register's own figures stand.
 */
async function supersedeWon(ctx: MutationCtx, clinic: Doc<"customers">, now: number) {
  const won = await ctx.db
    .query("customers")
    .withIndex("by_nameKey_and_market", (q) => q.eq("nameKey", clinic.nameKey).eq("market", clinic.market))
    .take(20);
  for (const row of won) {
    if (row.source !== SALES_SOURCE || row.archivedAt !== undefined) continue;
    await ctx.db.patch(row._id, { archivedAt: now });
    const carried = {
      ...(clinic.dealId === undefined && row.dealId !== undefined ? { dealId: row.dealId } : null),
      ...(clinic.note === undefined && row.note !== undefined ? { note: row.note } : null),
      ...(clinic.nextTouch === undefined && row.nextTouch !== undefined ? { nextTouch: row.nextTouch } : null),
    };
    if (Object.keys(carried).length > 0) {
      await ctx.db.patch(clinic._id, carried);
      Object.assign(clinic, carried);
    }
  }
}

/**
 * Store one push of the client register: the whole list. Rows, the run-log
 * entry and the source's status land in one transaction.
 *
 * A clinic the push does not carry is archived, never deleted, so the owner's
 * note is kept. Only the register's own rows are read for that: a clinic won
 * on the Sales board (the `deals` source) is never archived or deleted by a
 * push that does not mention it, and one it does carry supersedes it
 * (`supersedeWon`). A push that would archive more than a quarter of the live
 * clinics (more than two, while there are fewer than eight) is refused
 * (returned, not thrown, and with nothing written) unless it says
 * `allowShrink`: a sheet cut short must not empty the list.
 */
export const applyRegister = internalMutation({
  args: {
    source: v.string(),
    batchId: v.optional(v.string()),
    observedAt: v.optional(v.string()),
    startedAt: v.number(),
    rows: v.array(registerRow),
    allowShrink: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const keys = args.rows.map((row) => nameKeyOf(row.name));
    const incoming = new Set(keys);
    // The endpoint checks this first and names the rows; this is the backstop.
    // Fixed words: the clinic is not named.
    if (incoming.size !== keys.length) throw new Error("The same clinic appears twice in one push.");

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_source_and_nameKey", (q) => q.eq("source", args.source))
      .collect();
    const byKey = new Map(existing.map((c) => [c.nameKey, c]));
    const live = existing.filter((c) => c.archivedAt === undefined);
    const leaving = live.filter((c) => !incoming.has(c.nameKey));
    if (!args.allowShrink && shrinksTooFar(live.length, leaving.length)) {
      return { ok: false as const, leaving: leaving.length, of: live.length };
    }

    const counts = { inserted: 0, updated: 0, unchanged: 0, archived: 0 };
    for (const [index, row] of args.rows.entries()) {
      const nameKey = keys[index]!;
      // Every source field is named, so one the push left out is removed
      // (unknown again) rather than kept from an earlier push.
      const fields = {
        name: row.name,
        market: row.market,
        status: row.status,
        currency: MARKET_CURRENCY[row.market],
        monthlyFee: row.monthlyFee,
        lastPaymentDate: row.lastPaymentDate,
        amountOwed: row.amountOwed,
        lastUsageDate: row.lastUsageDate,
        contractDate: row.contractDate,
        baaDate: row.baaDate,
      };
      const current = byKey.get(nameKey);
      if (current === undefined) {
        const id = await ctx.db.insert("customers", { source: args.source, nameKey, ...fields, syncedAt: now });
        await supersedeWon(ctx, (await ctx.db.get(id))!, now);
        counts.inserted += 1;
        continue;
      }
      const same =
        current.archivedAt === undefined &&
        SOURCE_FIELDS.every((field) => current[field] === row[field]);
      await ctx.db.patch(current._id, { ...fields, syncedAt: now, archivedAt: undefined });
      await supersedeWon(ctx, (await ctx.db.get(current._id))!, now);
      if (same) counts.unchanged += 1;
      else counts.updated += 1;
    }
    for (const gone of leaving) {
      await ctx.db.patch(gone._id, { archivedAt: now });
      counts.archived += 1;
    }

    // Counts only. The run log has three columns; an archived clinic is an update.
    await ctx.db.insert("syncRuns", {
      source: args.source,
      batchId: args.batchId,
      observedAt: args.observedAt,
      startedAt: args.startedAt,
      finishedAt: now,
      status: "ok",
      inserted: counts.inserted,
      updated: counts.updated + counts.archived,
      unchanged: counts.unchanged,
    });
    await setSourceStatus(ctx, args.source, { state: "ok", at: now });
    return { ok: true as const, ...counts };
  },
});
