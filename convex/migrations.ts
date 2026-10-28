// One-off data changes, each an internal mutation the owner runs by hand
// (`npx convex run migrations:<name>`), idempotent, returning a count and
// logging nothing but numbers.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { isOwnerEmail } from "./authOwner";
import { contactCount, importRecordContact } from "./contacts";
import { companyIds, type CompanyId } from "./lib/company";
import {
  BOT_WORDS,
  MAX_BOTS,
  botAreaRefusal,
  holdsLevel,
  isBotId,
  isProfileId,
  levelOf,
  withLevel,
} from "./lib/botRules";
import { importCategory, parseContactText } from "./lib/contactImport";
import { MAX_CONTACTS } from "./lib/contacts";
import {
  HANDOFF_OPEN_ROWS,
  HANDOFF_REPAIR_BY,
  HANDOFF_REPAIR_NOTE,
  repairedAddressee,
  withEntry,
} from "./lib/handoffs";
import { keyProposer } from "./lib/proposals";
import { MAX_ROLES } from "./lib/roleRules";
import { MAX_MEMBERS, isPayOrCosts } from "./lib/roles";
import { agentTaskOrigin } from "./lib/taskOrigin";
import { customersFromWonDeals as applyWonRule } from "./lib/wonCustomers";

/** Decided proposals read while stamping bots onto the tasks they made. */
const DECIDED_READ = 2_000;

/** At most this many open proposals are read: more than the open caps allow together. */
const OPEN_READ = 2_000;

/**
 * Bot Loop v3, A: open proposals filed under one of the four (the shared
 * Grok client's agent ids) whose dedupeKey names a bot the owner keeps a
 * profile of are re-attributed to that bot: `bot` set, `agent` kept (the
 * bucket it was counted in). A second run finds nothing to change. Returns
 * how many were changed. Approval rates per bot (`bots.weeklyStats`) are
 * worked out at read time, so they follow at once.
 */
export const reattributeOpenProposals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const open = await ctx.db
      .query("proposals")
      .withIndex("by_status_and_createdAt", (q) => q.eq("status", "open"))
      .take(OPEN_READ);
    let changed = 0;
    for (const row of open) {
      const { id } = keyProposer(row.dedupeKey);
      if (!isBotId(id) || row.bot === id) continue;
      const profile = await ctx.db
        .query("bots")
        .withIndex("by_botId", (q) => q.eq("botId", id))
        .first();
      if (profile === null) continue;
      await ctx.db.patch(row._id, { bot: id });
      changed += 1;
    }
    return { changed, read: open.length };
  },
});

/**
 * Stamp the creating bot onto agent-made tasks that a decided proposal still
 * names. Reliable only there: the proposal's `bot` was the authenticated
 * caller, and `result.taskId` is the card approving it made. A task with no
 * such proposal, or whose proposal names no bot, is left without one (a
 * direct `task_create` from before this was recorded cannot be told apart).
 * A task that already records a bot is left as it is. A second run finds
 * nothing to change. Returns how many were stamped and how many proposals
 * were read, and nothing else.
 */
export const stampBotOnAgentTasks = internalMutation({
  args: {},
  handler: async (ctx) => {
    let stamped = 0;
    let read = 0;
    for (const status of ["approved", "auto_approved"] as const) {
      const rows = await ctx.db
        .query("proposals")
        .withIndex("by_status_and_createdAt", (q) => q.eq("status", status))
        .take(DECIDED_READ);
      read += rows.length;
      for (const row of rows) {
        if (row.bot === undefined || !isProfileId(row.bot)) continue;
        const result = row.result;
        if (result === undefined || !("taskId" in result)) continue;
        const task = await ctx.db.get(result.taskId);
        if (task?.origin?.source !== "agent" || task.origin.bot !== undefined) continue;
        await ctx.db.patch(task._id, {
          origin: agentTaskOrigin({ agent: task.origin.agent, bot: row.bot }),
        });
        stamped += 1;
      }
    }
    return { stamped, read };
  },
});

/**
 * Payroll and costs became the owner's alone. `effectiveAreas` already reads
 * every row without them; this takes them out of what is stored, so no row
 * of `members` or `roles` says a teammate or a role has one. A row with no
 * list of its own (from before pages could be picked) is left as it is: its
 * role's set never held either. A second run finds nothing to change.
 * Returns how many rows were changed, and nothing else: no address, name or
 * area. Bounded: at most MAX_MEMBERS rows and MAX_ROLES roles exist.
 */
export const dropOwnerOnlyAreas = internalMutation({
  args: {},
  handler: async (ctx) => {
    let membersChanged = 0;
    for (const row of await ctx.db.query("members").take(MAX_MEMBERS * 2)) {
      if (row.areas === undefined || !row.areas.some(isPayOrCosts)) continue;
      await ctx.db.patch(row._id, { areas: row.areas.filter((area) => !isPayOrCosts(area)) });
      membersChanged += 1;
    }
    let rolesChanged = 0;
    for (const row of await ctx.db.query("roles").take(MAX_ROLES * 2)) {
      if (!row.areas.some(isPayOrCosts)) continue;
      await ctx.db.patch(row._id, { areas: row.areas.filter((area) => !isPayOrCosts(area)) });
      rolesChanged += 1;
    }
    return { membersChanged, rolesChanged };
  },
});

/**
 * A won deal is a customer (convex/lib/wonCustomers.ts). The rule runs on
 * every write of a deal from now on; this applies it once to the deals that
 * were at Won before it: a clinic the client register already carries is
 * linked, any other is added as won on the Sales board, contracted on the day
 * its deal closed. Archived deals are left alone. A second run finds nothing
 * to change. Returns counts only: won deals read, rows made, links added,
 * left as they were.
 */
export const customersFromWonDeals = internalMutation({
  args: {},
  handler: (ctx) => applyWonRule(ctx, Date.now()),
});

/**
 * Open handoffs addressed to a bare external-agent id (`engineering`,
 * `chief_of_staff`, `finance`) are the bot profile's, stored as `bot:<id>`.
 * Rows from before that resolution were stored under the bare id, which the
 * Mac agent used to own, so the profile could not accept them. This rewrites
 * those open rows. A second run finds nothing to change. Returns how many
 * were rewritten and how many open rows were read: no title, name or address.
 */
export const repairOpenHandoffAddressees = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let read = 0;
    let changed = 0;
    for (const company of companyIds()) {
      const rows = await ctx.db
        .query("handoffs")
        .withIndex("by_company_and_status", (q) => q.eq("company", company).eq("status", "open"))
        .take(HANDOFF_OPEN_ROWS);
      read += rows.length;
      for (const row of rows) {
        const next = repairedAddressee(row.toKey, row.toKind);
        if (next === null || (next.to === row.to && next.toKey === row.toKey)) continue;
        await ctx.db.patch(row._id, {
          to: next.to,
          toKey: next.toKey,
          updatedAt: now,
          history: withEntry(row.history, {
            at: now,
            by: HANDOFF_REPAIR_BY,
            action: "reassign",
            note: HANDOFF_REPAIR_NOTE,
          }),
        });
        changed += 1;
      }
    }
    return { changed, read };
  },
});

/** Records read by one call of `contactsFromRecords` unless told otherwise; at most `IMPORT_BATCH_MAX`. */
const IMPORT_BATCH = 400;
const IMPORT_BATCH_MAX = 500;
export const IMPORT_WORDS = {
  badBatch: `A batch is 1 to ${IMPORT_BATCH_MAX} records.`,
  tooManyBots: `At most ${MAX_BOTS} bots at once.`,
} as const;

const importTotals = v.object({ read: v.number(), created: v.number(), linked: v.number(), skipped: v.number() });
type ImportTotals = { read: number; created: number; linked: number; skipped: number };

/**
 * Fill the Contacts book from the people the pipelines already name: every
 * deal's and investor's free-text `contact` that is not archived, read as
 * "Name, Role", "Name — Role" or "Name (Role)" (`parseContactText`; a part
 * that looks like an email address or a phone number is never kept). The
 * person lands in the record's company (a deal's market; investors are
 * Startup's), as a customer, a Kazakhstan clinic or an investor, at the
 * record's name as organisation, linked to the record, through the contacts
 * module's own matching for a person with no address (the same normalized
 * name at the same organisation: `importRecordContact`). The records' text
 * is left as it is.
 *
 * Idempotent: a second run finds every person linked already and changes
 * nothing. Bounded: `batch` records a call (deals, then investors, in the
 * order they were made); a longer list schedules the next call itself, and
 * `more` says one was scheduled. Returns counts only, so far: records read,
 * contacts made, links added (a new contact's own included), and records
 * that changed nothing (archived, no contact, naming nobody, already linked,
 * two contacts of that name there, or a full book). Logs nothing.
 *
 *   npx convex run migrations:contactsFromRecords
 */
export const contactsFromRecords = internalMutation({
  args: {
    batch: v.optional(v.number()),
    after: v.optional(
      v.object({ table: v.union(v.literal("deals"), v.literal("investors")), creationTime: v.number() }),
    ),
    totals: v.optional(importTotals),
  },
  handler: async (ctx, args): Promise<ImportTotals & { more: boolean }> => {
    const batch = args.batch ?? IMPORT_BATCH;
    if (!Number.isInteger(batch) || batch < 1 || batch > IMPORT_BATCH_MAX) throw new ConvexError(IMPORT_WORDS.badBatch);
    const now = Date.now();
    const totals: ImportTotals = { ...(args.totals ?? { read: 0, created: 0, linked: 0, skipped: 0 }) };
    const room = new Map<CompanyId, number>();
    for (const company of companyIds()) room.set(company, MAX_CONTACTS - (await contactCount(ctx, company)));

    let cursor = args.after ?? { table: "deals" as const, creationTime: 0 };
    let budget = batch;
    while (budget > 0) {
      const after = cursor.creationTime;
      const page: (Doc<"deals"> | Doc<"investors">)[] =
        cursor.table === "deals"
          ? await ctx.db
              .query("deals")
              .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
              .take(budget)
          : await ctx.db
              .query("investors")
              .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
              .take(budget);
      for (const record of page) {
        totals.read += 1;
        const parsed =
          record.archivedAt === undefined && record.contact !== undefined ? parseContactText(record.contact) : null;
        if (parsed === null) {
          totals.skipped += 1;
        } else {
          const isDeal = cursor.table === "deals";
          const company: CompanyId = isDeal ? (record as Doc<"deals">).market : "us";
          const outcome = await importRecordContact(
            ctx,
            {
              company,
              category: importCategory(isDeal ? "deal" : "investor", company),
              name: parsed.name,
              ...(parsed.title === undefined ? null : { title: parsed.title }),
              org: record.name,
              link: { type: isDeal ? "deal" : "investor", id: record._id },
            },
            now,
            room,
          );
          if (outcome === "skipped") totals.skipped += 1;
          else totals.linked += 1;
          if (outcome === "created") totals.created += 1;
        }
        cursor = { table: cursor.table, creationTime: record._creationTime };
      }
      budget -= page.length;
      if (page.length > 0 && budget === 0) break;
      if (cursor.table === "investors") return { ...totals, more: false };
      cursor = { table: "investors", creationTime: 0 };
    }
    await ctx.scheduler.runAfter(0, internal.migrations.contactsFromRecords, { batch, after: cursor, totals });
    return { ...totals, more: true };
  },
});

/**
 * Give the owner's named bots the contacts area at one level, so the
 * coordinator can run it for the bots the owner chose after a deploy:
 *
 *   npx convex run migrations:grantContactsToBots \
 *     '{"bots":["growth","globex_ai_sales","fundraising","partnerships"],"level":"write"}'
 *
 * Only a bot profile the owner keeps (its `users` row is an OWNER_EMAILS
 * address); never a locked area (the rule every grant follows,
 * `botAreaRefusal`); a level held already, or a higher one, is left as it is,
 * so a second run changes nothing and write is never lowered to read. A bot
 * switched off is counted and left alone, as the Bots tab's Grant refuses
 * one. The "Suggested" mark stays. Returns counts only: no name, no area.
 */
export const grantContactsToBots = internalMutation({
  args: { bots: v.array(v.string()), level: v.union(v.literal("read"), v.literal("write")) },
  handler: async (ctx, { bots, level }) => {
    if (bots.length > MAX_BOTS) throw new ConvexError(IMPORT_WORDS.tooManyBots);
    if (bots.some((id) => !isProfileId(id))) throw new ConvexError(BOT_WORDS.gone);
    const refusal = botAreaRefusal("contacts");
    if (refusal === "locked") throw new ConvexError(BOT_WORDS.locked);
    if (refusal !== null) throw new ConvexError(BOT_WORDS.gone);
    const now = Date.now();
    const counts = { granted: 0, unchanged: 0, off: 0, notFound: 0 };
    for (const botId of new Set(bots)) {
      const rows = await ctx.db
        .query("bots")
        .withIndex("by_botId", (q) => q.eq("botId", botId))
        .take(MAX_BOTS);
      const owned: Doc<"bots">[] = [];
      for (const row of rows) {
        const user = await ctx.db.get(row.userId);
        if (user !== null && isOwnerEmail(user.email)) owned.push(row);
      }
      if (owned.length === 0) {
        counts.notFound += 1;
        continue;
      }
      for (const row of owned) {
        if (holdsLevel(levelOf(row.permissions, "contacts"), level)) counts.unchanged += 1;
        else if (!row.enabled) counts.off += 1;
        else {
          await ctx.db.patch(row._id, { permissions: withLevel(row.permissions, "contacts", level), updatedAt: now });
          counts.granted += 1;
        }
      }
    }
    return counts;
  },
});
