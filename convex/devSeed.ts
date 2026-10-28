// `pnpm dev:seed`: fill a LOCAL backend with a made-up data set, so every
// page shows something without anyone holding a real number or name. The data
// is convex/lib/devSeedData.ts; every word of it is invented.
//
// THIS EMPTIES EVERY TABLE BUT THE SIGN-IN ONES before it writes, which is
// what makes a second run land on the same state. So it refuses to run
// anywhere but a local development backend, by the backend's own environment
// (convex/lib/devLocal.ts), whoever calls it and with whatever flag: on a
// cloud deployment it throws before reading a row. It is internal, so no
// browser can call it at all.

import { ConvexError, v } from "convex/values";
import type { Id, TableNames } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { linkContact, upsertContact } from "./contacts";
import { createDecision } from "./decisions";
import { addStats, savePost } from "./linkedin";
import { ownerMember } from "./lib/agentStore";
import { writeBrief } from "./lib/briefs";
import { DURATION_BUCKETS_MS, bucketOf } from "./lib/botTelemetry";
import { isMonth, looksLikeAccountNumber } from "./lib/costs";
import { cleanIntelEdit } from "./lib/dealIntel";
import { MARKET_CURRENCY } from "./lib/customerShape";
import { SECOND_COMPANY, companyIds, companyOfMetric, isCompanyId } from "./lib/company";
import { PRODUCT } from "./lib/identity";
import { customersFromWonDeals } from "./lib/wonCustomers";
import { LOCAL_OWNER_EMAIL, refusalHere } from "./lib/devLocal";
import {
  SEED_AGENT_CALLS,
  SEED_BOT_CALL_DAYS,
  SEED_BRIEFS,
  SEED_NOTIFICATIONS,
  SEED_COSTS,
  SEED_SCENARIOS,
  seedBudgetActuals,
  seedBudgets,
  SEED_PAY_LINES,
  SEED_PAY_PEOPLE,
  SEED_PEOPLE,
  SEED_CHAT,
  SEED_DEAL_INTEL,
  SEED_ROLES,
  SEED_TARGETS,
  SEED_TASKS,
  SEED_SUPPORT_APP,
  SEED_WORK_TOOL_SETTINGS,
  TODAY_TEAMMATE,
  emailOf,
  isSeedRole,
  seedBreakdowns,
  seedCustomerDoctors,
  seedCustomerUsage,
  seedCustomers,
  seedDeals,
  seedGithub,
  seedGoals,
  seedInvestors,
  seedMember,
  type SeedRoleKey,
  seedMirror,
  seedObligations,
  seedCostMonth,
  seedPayMonth,
  seedPlan,
  seedShared,
  seedSnapshots,
  seedSourceStatus,
  seedSupport,
  seedStandup,
  seedSyncRuns,
  type SeedHolder,
} from "./lib/devSeedData";
import { keyOf, refusal } from "./lib/mirrorRules";
import {
  SEED_AGENT_CHANGES,
  SEED_AGENT_CONFIG,
  SEED_BUILT,
  SEED_STARTUP_OS,
  seedStartupOsRuns,
  SEED_CATALOG,
  SEED_HARNESS,
  seedBuiltRuns,
  SEED_PROJECTS,
  seedAgentProviders,
  seedAgentUsage,
  seedNoTokenHash,
} from "./lib/devSeedAgents";
import { defaultsFromWire, harnessDefaultsWire, jobHarnessOf, promptPartOf } from "./lib/agentHarness";
import { resultPassed } from "./lib/agentJobs";
import { pendingApprovalsOf, type Definition } from "./lib/agentBuilder";
import { SEED_CONTACTS } from "./lib/devSeedContacts";
import { SEED_DECISIONS, SEED_MEETINGS } from "./lib/devSeedMemory";
import { SEED_LINKEDIN, SEED_LINKEDIN_TARGETS } from "./lib/devSeedLinkedin";
import { draftRows } from "./lib/payroll";
import { approveProposal, dismiss, propose } from "./lib/proposals";
import {
  answerInProgress,
  claimNext,
  finishAnswer,
  linkProposal,
  sendMessage,
} from "./lib/chat";
import { roleNameKey } from "./lib/roleRules";
import { sharedKeyOf, sharedRefusal } from "./lib/sharedRecords";
import { validateSnapshots } from "./lib/snapshotRules";
import { assignablePeople } from "./lib/teamDirectory";
import schema from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

// Who is signed in survives a re-seed: the people are kept (and brought back
// to their seeded names), and nothing else in these tables is touched.
const KEPT = new Set<string>([
  "users",
  "authSessions",
  "authAccounts",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
]);

/** Every table the seed empties: all of the schema's but the sign-in ones. */
/**
 * The seed's named roles, made where they are missing, by the key
 * `pnpm dev:signin` knows each by. Called only by the seed and by the local
 * sign-in, both of which have already refused anything but a local backend.
 */
export async function seedRoles(ctx: MutationCtx, createdBy: Id<"users">) {
  const ids = {} as Record<SeedRoleKey, Id<"roles">>;
  for (const key of Object.keys(SEED_ROLES) as SeedRoleKey[]) {
    const role = SEED_ROLES[key];
    const nameKey = roleNameKey(role.name);
    const row = await ctx.db
      .query("roles")
      .withIndex("by_nameKey", (q) => q.eq("nameKey", nameKey))
      .first();
    ids[key] =
      row?._id ??
      (await ctx.db.insert("roles", {
        name: role.name,
        nameKey,
        focus: role.focus,
        areas: [...role.areas],
        createdBy,
      }));
  }
  return ids;
}

export const SEEDED_TABLES = (Object.keys(schema.tables) as TableNames[]).filter(
  (table) => !KEPT.has(table),
);

/** The `users` row of a made-up local person, made or brought back to its seeded name. */
export async function localUser(ctx: MutationCtx, email: string, name: string): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  if (existing === null) {
    return await ctx.db.insert("users", { email, name, emailVerificationTime: Date.now() });
  }
  if (existing.name !== name || existing.emailVerificationTime === undefined) {
    await ctx.db.patch(existing._id, {
      name,
      emailVerificationTime: existing.emailVerificationTime ?? Date.now(),
    });
  }
  return existing._id;
}

/**
 * A seeded row as one-company mode keeps it: null for a row of a company the
 * OS is not run for (its `company` or `market`, or a figure of its scope),
 * the row with that company taken out of its `companies`, or the row itself.
 */
function keptInUse<Row extends object>(row: Row): Partial<Row> | Row | null {
  const fields = row as { company?: unknown; market?: unknown; key?: unknown; scope?: unknown; companies?: unknown };
  const notInUse = (value: unknown) => (value === "us" || value === "kz") && !isCompanyId(value);
  if (notInUse(fields.company) || notInUse(fields.market)) return null;
  if (typeof fields.key === "string" && typeof fields.scope === "string" && !isCompanyId(companyOfMetric(fields.key, fields.scope))) {
    return null;
  }
  if (Array.isArray(fields.companies) && fields.companies.some(notInUse)) {
    const companies = fields.companies.filter((company) => !notInUse(company));
    return companies.length === 0 ? null : ({ companies } as unknown as Partial<Row>);
  }
  return row;
}

/**
 * Tables that hold the second company's alone, with no company on the row:
 * Globex's app (its clinics, their usage and doctors, the breakdowns) and
 * its Intercom inbox. Seeded empty in one-company mode.
 */
const SECOND_COMPANY_TABLES: ReadonlySet<string> = new Set([
  "kzAppClinics",
  "customerUsage",
  "customerDoctors",
  "kzBreakdowns",
  "supportConversations",
]);

/** Rows one "empty" step deletes: the local backend reads at most 4,096 a call. */
const EMPTY_BATCH = 3000;

export const run = internalMutation({
  // `step: "empty"` deletes a batch of the seeded tables' rows and says
  // whether more are left (`more: 1`): the made-up data is more than one
  // call may read, so `pnpm dev:seed` empties in steps, then seeds.
  args: { step: v.optional(v.literal("empty")) },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, args) => {
    const refused = refusalHere();
    if (refused !== null) throw new ConvexError(refused);
    const now = Date.now();

    if (args.step === "empty") {
      let deleted = 0;
      for (const table of SEEDED_TABLES) {
        for (const row of await ctx.db.query(table).take(EMPTY_BATCH - deleted)) {
          await ctx.db.delete(row._id);
          deleted += 1;
        }
        if (deleted >= EMPTY_BATCH) return { deleted, more: 1 };
      }
      return { deleted, more: 0 };
    }

    for (const table of SEEDED_TABLES) {
      for await (const row of ctx.db.query(table)) await ctx.db.delete(row._id);
    }

    // ── People ──
    const userIds = new Map<string, Id<"users">>();
    for (const person of SEED_PEOPLE) {
      userIds.set(emailOf(person), await localUser(ctx, emailOf(person), person.name));
    }
    const ownerId = userIds.get(LOCAL_OWNER_EMAIL)!;
    // The roles the made-up owner named: two, with different focuses.
    const roleIds = await seedRoles(ctx, ownerId);
    for (const person of SEED_PEOPLE) {
      if (person.role === "owner") continue;
      await ctx.db.insert("members", {
        ...seedMember(person, isSeedRole(person.role) ? roleIds[person.role] : person.role),
        addedAt: now - 30 * DAY_MS,
        addedBy: ownerId,
      });
    }

    // ── Numbers ──
    for (const { source, rows } of seedSnapshots(now)) {
      // The registry's own check, as every write path runs it.
      const issues = validateSnapshots(source, rows, undefined, { now });
      if (issues.length > 0) throw new ConvexError("The seed's figures no longer fit the registry.");
      for (const row of rows) await ctx.db.insert("metricSnapshots", { ...row, source, syncedAt: now });
    }
    for (const row of seedSourceStatus(now)) await ctx.db.insert("sourceStatus", row);
    for (const row of seedSyncRuns(now)) await ctx.db.insert("syncRuns", row);
    for (const row of SEED_TARGETS) await ctx.db.insert("metricTargets", row);
    for (const row of seedPlan(now)) await ctx.db.insert("planFigures", row);

    // ── Pipelines, customers, compliance ──
    const usDealIds = new Map<string, Id<"deals">>();
    for (const { native, ...deal } of seedDeals(now)) {
      const id = await ctx.db.insert("deals", deal);
      if (native) await ctx.db.patch(id, { externalId: id });
      if (native && deal.market === "us") usDealIds.set(deal.name, id);
    }
    // A few US deals' sales intelligence, held to the server's own cleaning.
    for (const { deal, intel } of SEED_DEAL_INTEL) {
      const cleaned = cleanIntelEdit(intel);
      const dealId = usDealIds.get(deal);
      if (!cleaned.ok || dealId === undefined) {
        throw new ConvexError("The seed's deal intelligence no longer passes its checks.");
      }
      await ctx.db.insert("dealIntel", { dealId, ...intel, updatedAt: now });
    }
    for (const { native, ...investor } of seedInvestors(now)) {
      const id = await ctx.db.insert("investors", investor);
      if (native) await ctx.db.patch(id, { externalId: id });
    }
    const clinics: { id: Id<"customers">; name: string }[] = [];
    for (const row of seedCustomers(now)) {
      const id = await ctx.db.insert("customers", row);
      if (row.archivedAt === undefined && row.status === "active") clinics.push({ id, name: row.name });
    }
    // A won deal is a customer (convex/lib/wonCustomers.ts): the seed's won
    // deals are clinics the register carries, so this links them.
    await customersFromWonDeals(ctx, now);
    const usage = seedCustomerUsage(now, clinics);
    for (const row of usage) await ctx.db.insert("customerUsage", row);
    for (const row of seedCustomerDoctors(now, clinics, usage)) await ctx.db.insert("customerDoctors", row);
    // Each clinic with usage is linked to a made-up clinic id in the app, as
    // the PostHog run links one whose name matches; one app clinic is left
    // unlinked, as one whose name matched none would be.
    const linkedIds = [...new Set(usage.map((u) => u.customerId))];
    for (const [i, customerId] of linkedIds.entries()) {
      const org = `org_sample_${String(i + 1).padStart(2, "0")}`;
      await ctx.db.patch(customerId, { appOrgId: org });
      const theirs = usage.filter((u) => u.customerId === customerId).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
      const newest = theirs.at(-1);
      await ctx.db.insert("kzAppClinics", {
        org,
        customerId,
        weeks: theirs.length,
        actions: newest?.actions ?? 0,
        doctors: newest?.doctors ?? 0,
        lastActiveOn: newest?.lastActiveOn,
        syncedAt: now,
      });
    }
    await ctx.db.insert("kzAppClinics", { org: "org_sample_unlinked", weeks: 3, actions: 14, doctors: 2, syncedAt: now });
    for (const row of seedBreakdowns(now)) await ctx.db.insert("kzBreakdowns", row);
    for (const row of seedObligations(now)) await ctx.db.insert("obligations", row);

    // ── Goals, the board, the weekly review ──
    const goalIds: Id<"goals">[] = [];
    for (const goal of seedGoals(now)) goalIds.push(await ctx.db.insert("goals", goal));
    const standup = seedStandup(now);
    const nextOrder = new Map<string, number>();
    const taskIds = new Map<string, Id<"tasks">>();
    for (const [index, task] of SEED_TASKS.entries()) {
      const order = nextOrder.get(task.column) ?? 0;
      nextOrder.set(task.column, order + 1);
      const taskId = await ctx.db.insert("tasks", {
        title: task.title,
        kind: task.kind ?? "task",
        column: task.column,
        order,
        ...(task.notes ? { notes: task.notes } : null),
        ...(task.goal === undefined ? null : { goalId: goalIds[task.goal]! }),
        ...(task.due === undefined
          ? null
          : { due: new Date(now + task.due * DAY_MS).toISOString().slice(0, 10) }),
        ...(task.done === undefined ? null : { doneAt: now - task.done * DAY_MS }),
        ...(task.assignee ? { assignee: emailOf(task.assignee) } : null),
        ...(task.company ? { company: task.company } : null),
        ...(task.mentions
          ? { mentioned: task.mentions.map((person) => userIds.get(emailOf(person))!) }
          : null),
        ...(task.from === "standup"
          ? { origin: { source: "standup" as const, ...standup } }
          : task.from === "suggestion"
            ? {
                origin: { source: "suggestion" as const },
                createdBy: userIds.get(emailOf(task.by!))!,
              }
            : { createdBy: ownerId }),
      });
      taskIds.set(task.title, taskId);
      if (task.from === "standup") {
        await ctx.db.insert("standupItems", {
          meetingId: standup.meetingId,
          key: `seed-item-${index}`,
          day: standup.meetingDate,
          acceptedAt: now - DAY_MS,
        });
      }
    }

    // ── What each person has been told (the bell) ──
    for (const told of SEED_NOTIFICATIONS) {
      const task = SEED_TASKS.find((one) => one.title === told.task);
      const taskId = taskIds.get(told.task);
      if (task === undefined || taskId === undefined) {
        throw new ConvexError("The seed's notifications name a task it does not have.");
      }
      const at = now - Math.round(told.hoursAgo * 60 * 60 * 1000);
      await ctx.db.insert("notifications", {
        recipient: userIds.get(emailOf(told.to))!,
        kind: told.kind,
        actor:
          told.by === "standup"
            ? { type: "system", source: "standup" }
            : { type: "user", userId: userIds.get(emailOf(told.by))! },
        taskId,
        ...(task.company ? { company: task.company } : null),
        title: task.title,
        ...(told.column ? { column: told.column } : null),
        ...(told.now ? { to: userIds.get(emailOf(told.now))! } : null),
        ...(told.due === undefined
          ? null
          : {
              due:
                told.due === null
                  ? null
                  : new Date(now + told.due * DAY_MS).toISOString().slice(0, 10),
            }),
        createdAt: at,
        ...(told.read ? { readAt: at + 60 * 60 * 1000 } : null),
      });
    }

    // ── Payroll: people, lines, and this month prepared for each company ──
    const lineIds = new Map<string, Id<"payrollLines">>();
    const lineOrder = new Map<string, number>();
    for (const line of SEED_PAY_LINES) {
      const slot = `${line.company}:${line.appliesTo}`;
      const order = lineOrder.get(slot) ?? 0;
      lineOrder.set(slot, order + 1);
      lineIds.set(
        line.key,
        await ctx.db.insert("payrollLines", {
          company: line.company,
          appliesTo: line.appliesTo,
          name: line.name,
          paidBy: line.paidBy,
          rateBp: line.rateBp,
          lessLineIds: (line.less ?? []).map((key) => lineIds.get(key)!),
          allowance: 0,
          order,
          active: true,
        }),
      );
    }
    const month = seedPayMonth(now);
    for (const company of companyIds()) {
      const people = [];
      for (const [order, person] of SEED_PAY_PEOPLE.filter((p) => p.company === company).entries()) {
        const pay =
          person.net === undefined
            ? { payBasis: "gross" as const, monthlyGross: person.gross! }
            : { payBasis: "net" as const, monthlyNet: person.net };
        const id = await ctx.db.insert("payrollPeople", {
          company,
          name: person.name,
          title: person.title,
          kind: person.kind,
          currency: person.currency,
          ...pay,
          ...(person.cogsPercent ? { cogsPercent: person.cogsPercent } : null),
          ...(person.salesPercent ? { salesPercent: person.salesPercent } : null),
          order,
        });
        people.push({ id, ...person, ...pay, order });
      }
      const lines = SEED_PAY_LINES.filter((line) => line.company === company).map((line, order) => ({
        id: lineIds.get(line.key)! as string,
        name: line.name,
        paidBy: line.paidBy,
        rateBp: line.rateBp,
        lessLineIds: (line.less ?? []).map((key) => lineIds.get(key)! as string),
        allowance: 0,
        baseCap: null,
        appliesTo: line.appliesTo,
        order,
        active: true,
      }));
      // The same arithmetic the page shows a month with and marking it paid
      // freezes it with (convex/lib/payroll.ts).
      const rows = draftRows({ people, lines, month, companyCurrency: MARKET_CURRENCY[company] });
      await ctx.db.insert("payrollRuns", {
        company,
        month,
        status: "draft",
        preparedAt: now - DAY_MS,
        rows,
      });
    }

    // ── Costs: a dozen lines for each company, held to the page's own checks ──
    for (const line of SEED_COSTS) {
      const startsOn = seedCostMonth(now, line.startsIn);
      const endsOn = line.endsIn === undefined ? undefined : seedCostMonth(now, line.endsIn);
      if ([line.name, line.paidBy ?? "", line.note ?? ""].some(looksLikeAccountNumber)) {
        throw new Error("devSeed: a cost line holds what looks like an account number");
      }
      if (!isMonth(startsOn) || (endsOn !== undefined && (!isMonth(endsOn) || endsOn < startsOn))) {
        throw new Error("devSeed: a cost line's months are not in order");
      }
      await ctx.db.insert("costs", {
        company: line.company,
        name: line.name,
        category: line.category,
        amount: line.amount,
        currency: MARKET_CURRENCY[line.company],
        cadence: line.cadence,
        startsOn,
        endsOn,
        variable: line.variable ?? false,
        ...(line.bucket ? { bucket: line.bucket } : null),
        paidBy: line.paidBy,
        note: line.note,
        createdAt: now - DAY_MS,
        updatedAt: now - DAY_MS,
      });
    }

    // ── Budget and runway: a made-up plan, Globex's typed actuals, two scenarios each ──
    for (const row of seedBudgets(now)) {
      await ctx.db.insert("budgets", { ...row, currency: MARKET_CURRENCY[row.company], updatedAt: now });
    }
    for (const row of seedBudgetActuals(now)) {
      await ctx.db.insert("budgetActuals", { ...row, currency: "KZT", updatedAt: now });
    }
    for (const scenario of SEED_SCENARIOS) {
      await ctx.db.insert("scenarios", {
        company: scenario.company,
        name: scenario.name,
        changes: scenario.changes.map(({ startsIn, endsIn, ...change }) => ({
          ...change,
          startMonth: seedCostMonth(now, startsIn),
          ...(endsIn === undefined ? {} : { endMonth: seedCostMonth(now, endsIn) }),
          currency: MARKET_CURRENCY[scenario.company],
        })),
        createdAt: now,
        updatedAt: now,
      });
    }

    // ── Work tools: the owner's mirror, one teammate's own, Apollo's lists ──
    const teammate = { email: emailOf(TODAY_TEAMMATE), userId: userIds.get(emailOf(TODAY_TEAMMATE))! };
    for (const holder of ["owner", "teammate"] as const satisfies readonly SeedHolder[]) {
      const whose = holder === "owner" ? {} : { owner: teammate.email, userId: teammate.userId };
      for (const { source, rows } of seedMirror(now, holder)) {
        // The mirror's own check, as `mirror.apply` runs it.
        if (refusal(source, rows) !== null) {
          throw new ConvexError("The seed's records no longer fit the mirror's rules.");
        }
        for (const record of rows) {
          await ctx.db.insert("mirrorRecords", {
            ...whose,
            source,
            ...keyOf(record),
            syncedAt: now,
            record,
          });
        }
        if (holder === "teammate") {
          await ctx.db.insert("personalSourceStatus", {
            owner: teammate.email,
            userId: teammate.userId,
            source,
            state: "ok",
            lastRunAt: now - 20 * 60_000,
            lastOkAt: now - 20 * 60_000,
          });
        }
      }
    }
    const shared = seedShared(now);
    for (const kind of ["sequence", "stage_count"] as const) {
      const rows = shared.filter((record) => record.kind === kind);
      if (sharedRefusal(kind, rows) !== null) {
        throw new ConvexError("The seed's shared lists no longer fit their rules.");
      }
      for (const record of rows) {
        await ctx.db.insert("mirrorRecords", {
          source: "apollo",
          ...sharedKeyOf(record),
          syncedAt: now,
          record,
        });
      }
    }
    // GitHub's two lists, for the Engineering page: the same check a push gets.
    const github = seedGithub(now);
    for (const kind of ["repo", "pull_request"] as const) {
      const rows = github.filter((record) => record.kind === kind);
      if (sharedRefusal(kind, rows) !== null) {
        throw new ConvexError("The seed's shared lists no longer fit their rules.");
      }
      for (const record of rows) {
        await ctx.db.insert("mirrorRecords", {
          source: "github",
          ...sharedKeyOf(record),
          syncedAt: now - 20 * 60_000,
          record,
        });
      }
    }
    await ctx.db.insert("workToolSettings", SEED_WORK_TOOL_SETTINGS);

    // Globex's Intercom inbox (the Support page), as the daily push left it.
    for (const row of seedSupport(now)) await ctx.db.insert("supportConversations", { ...row, syncedAt: now });
    await ctx.db.insert("supportWorkspace", { appId: SEED_SUPPORT_APP, readAt: now - 10 * 60 * 1000 });

    // The projects' agents (the Agents page): made-up projects, what each
    // says it can run, usage, providers, and what was steered or launched
    // from here, some of it still waiting to be applied.
    for (const [index, { lastSeenMinutesAgo, ...project }] of SEED_PROJECTS.entries()) {
      await ctx.db.insert("agentProjects", {
        ...project,
        allowedProviders: [...project.allowedProviders],
        status: "active",
        ...(lastSeenMinutesAgo === null
          ? {}
          : {
              tokenHash: seedNoTokenHash(index),
              tokenCreatedAt: now - 20 * 24 * 60 * 60_000,
              lastSeenAt: now - lastSeenMinutesAgo * 60_000,
              lastUsageAt: now - (lastSeenMinutesAgo + 5) * 60_000,
            }),
        createdAt: now - 30 * 24 * 60 * 60_000,
        createdBy: ownerId,
      });
    }
    for (const entry of SEED_CATALOG) {
      await ctx.db.insert("agentCatalog", {
        ...entry,
        firstReportedAt: now - 20 * 24 * 60 * 60_000,
        lastReportedAt: now - 10 * 60_000,
      });
    }
    for (const { costUsd, p50Ms, p95Ms, ...row } of seedAgentUsage(now)) {
      await ctx.db.insert("agentUsage", {
        ...row,
        ...(costUsd === null ? {} : { costUsd }),
        p50Ms,
        p95Ms,
        syncedAt: now - 10 * 60_000,
      });
    }
    for (const { checkedAt, lastErrorClass, ...row } of seedAgentProviders(now)) {
      await ctx.db.insert("agentProviders", {
        ...row,
        checkedAt: Date.parse(checkedAt),
        ...(lastErrorClass === null ? {} : { lastErrorClass }),
        syncedAt: now - 10 * 60_000,
      });
    }
    const steered = new Map<string, (typeof SEED_AGENT_CHANGES)[number]>();
    for (const seeded of SEED_AGENT_CHANGES) {
      const { hoursAgo, name: _name, ...change } = seeded;
      await ctx.db.insert("agentControlChanges", {
        ...change,
        by: ownerId,
        at: now - hoursAgo * 60 * 60_000,
        push: "pull",
      });
      // Oldest first, so an agent's desired state is its latest change.
      steered.set(`${change.project}|${change.agentId}`, seeded);
    }
    for (const change of steered.values()) {
      await ctx.db.insert("agentControls", {
        project: change.project,
        agentId: change.agentId,
        ...(change.name === undefined ? {} : { name: change.name }),
        ...change.after,
        version: change.version,
        updatedAt: now - change.hoursAgo * 60 * 60_000,
        updatedBy: ownerId,
      });
    }
    for (const config of SEED_AGENT_CONFIG) {
      await ctx.db.insert("agentConfig", {
        ...config,
        ...(config.appliedVersion > 0 ? { appliedAt: now - 5 * 24 * 60 * 60_000 + 60_000 } : {}),
      });
    }

    // One agent's harness (Protocol v1.1): the code's defaults, a draft, two
    // made-up cases and a finished run that passed, so its tabs show.
    {
      const { project, agentId, draft, run } = SEED_HARNESS;
      const defaults = defaultsFromWire(harnessDefaultsWire.parse(SEED_HARNESS.defaults));
      await ctx.db.insert("agentHarnessDefaults", { project, agentId, harness: defaults, reportedAt: now - 10 * 60_000 });
      const draftAt = now - draft.hoursAgo * 60 * 60_000;
      const versionId = await ctx.db.insert("agentHarnessVersions", {
        project,
        agentId,
        number: draft.number,
        status: "draft",
        revision: draft.revision,
        prompt: draft.prompt,
        note: draft.note,
        createdBy: ownerId,
        createdAt: draftAt,
        updatedBy: ownerId,
        updatedAt: draftAt,
      });
      const runAt = now - run.hoursAgo * 60 * 60_000;
      const cases = [];
      for (const seeded of SEED_HARNESS.cases) {
        const row = {
          name: seeded.name,
          variables: { ...seeded.variables } as Record<string, string>,
          expect: seeded.expect.map((assertion) => ({ ...assertion })),
        };
        const id = await ctx.db.insert("agentHarnessCases", {
          project,
          agentId,
          ...row,
          createdBy: ownerId,
          createdAt: draftAt,
          updatedBy: ownerId,
          updatedAt: draftAt,
          madeUpAt: draftAt,
        });
        cases.push({ id, ...row });
      }
      const runId = await ctx.db.insert("agentHarnessRuns", {
        project,
        agentId,
        versionId,
        number: draft.number,
        revision: draft.revision,
        harness: JSON.stringify(jobHarnessOf(draft.number, draft.revision, { prompt: promptPartOf(draft.prompt) }, defaults)),
        models: [{ ...run.model }],
        status: "done",
        leases: 1,
        expected: cases.length,
        received: cases.length,
        passed: cases.length,
        createdBy: ownerId,
        createdAt: runAt,
        finishedAt: runAt + 90_000,
      });
      for (const [position, seeded] of cases.entries()) {
        await ctx.db.insert("agentHarnessRunCases", {
          run: runId,
          caseId: seeded.id,
          name: seeded.name,
          variables: seeded.variables,
          expect: seeded.expect,
          position,
        });
        const assertions = seeded.expect.map((_, index) => ({ index, passed: true }));
        await ctx.db.insert("agentHarnessResults", {
          run: runId,
          caseId: seeded.id,
          ...run.model,
          output: JSON.stringify(run.outputs[position]),
          schemaValid: true,
          assertions,
          passed: resultPassed({ schemaValid: true, assertions }, assertions.length),
          latencyMs: 820 + position * 140,
          inputTokens: 1_150 + position * 40,
          outputTokens: 60 + position * 8,
          costUsd: 0.0004,
        });
      }
    }

    // Agents built here (Protocol v1.3): the research project's tool catalogue,
    // two published agents (a lookup offered as a sub-agent, and a weekday
    // sweep that calls it), and the sweep's runs, made up.
    {
      const { project } = SEED_BUILT;
      for (const tool of SEED_BUILT.tools) {
        await ctx.db.insert("agentTools", {
          project,
          toolId: tool.id,
          name: tool.name,
          description: tool.description,
          phi: tool.phi,
          kind: tool.kind,
          effect: tool.effect,
          approvable: tool.approvable,
          inputSchema: JSON.stringify(tool.inputSchema),
          firstReportedAt: now - 2 * 24 * 60 * 60_000,
          lastReportedAt: now - 10 * 60_000,
        });
      }
      for (const agent of SEED_BUILT.agents) {
        const at = now - agent.hoursAgo * 60 * 60_000;
        const definition = JSON.parse(JSON.stringify(agent.definition)) as Definition;
        await ctx.db.insert("agentDeclared", { project, agentId: agent.agentId, createdBy: ownerId, createdAt: at });
        const versionId = await ctx.db.insert("agentHarnessVersions", {
          project,
          agentId: agent.agentId,
          number: 1,
          status: "published",
          revision: 1,
          promptVariants: ["default"],
          tools: [...agent.tools],
          definition,
          note: "Made-up: the first version.",
          createdBy: ownerId,
          createdAt: at,
          updatedBy: ownerId,
          updatedAt: at,
          publishedBy: ownerId,
          publishedAt: at + 60 * 60_000,
        });
        await ctx.db.insert("agentHarnessPrompts", { versionId, variants: JSON.parse(JSON.stringify(agent.prompt.variants)) });
        await ctx.db.insert("agentHarnessEvents", {
          project,
          agentId: agent.agentId,
          number: 1,
          action: "publish",
          by: ownerId,
          at: at + 60 * 60_000,
          configVersion: 1,
          override: { reason: "Made-up: published in the local data set." },
        });
        await ctx.db.insert("agentControls", {
          project,
          agentId: agent.agentId,
          name: definition.name,
          enabled: true,
          provider: definition.model!.provider,
          model: definition.model!.model,
          ...(definition.limits.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: definition.limits.monthlyBudgetUsd }),
          harnessVersion: "h1",
          version: 1,
          updatedAt: at + 60 * 60_000,
          updatedBy: ownerId,
        });
      }
      for (const run of seedBuiltRuns(now)) {
        await ctx.db.insert("agentRuns", {
          project,
          runId: run.runId,
          agentId: run.agentId,
          version: run.version,
          trigger: run.trigger,
          ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
          status: run.status,
          startedAt: Date.parse(run.startedAt),
          durationMs: run.durationMs,
          steps: run.steps,
          ...(run.costUsd === null ? {} : { costUsd: run.costUsd }),
          ...(run.errorClass === null ? {} : { errorClass: run.errorClass }),
          toolCalls: run.toolCalls,
          pendingApprovals: pendingApprovalsOf(run.toolCalls),
          receivedAt: now - 10 * 60_000,
        });
      }
    }

    // An agent Startup OS runs itself (the project `startup-os`): published, one
    // run done with its answer and one waiting for the owner's approval of a
    // made-up card. Locally no provider is configured: Run now says so.
    {
      const project = "startup-os";
      const agent = SEED_STARTUP_OS;
      const at = now - agent.hoursAgo * 60 * 60_000;
      const definition = JSON.parse(JSON.stringify(agent.definition)) as Definition;
      await ctx.db.insert("agentDeclared", { project, agentId: agent.agentId, createdBy: ownerId, createdAt: at });
      const versionId = await ctx.db.insert("agentHarnessVersions", {
        project,
        agentId: agent.agentId,
        number: 1,
        status: "published",
        revision: 1,
        promptVariants: ["default"],
        tools: [...agent.tools],
        definition,
        note: "Made-up: the first version.",
        createdBy: ownerId,
        createdAt: at,
        updatedBy: ownerId,
        updatedAt: at,
        publishedBy: ownerId,
        publishedAt: at + 60 * 60_000,
      });
      await ctx.db.insert("agentHarnessPrompts", { versionId, variants: JSON.parse(JSON.stringify(agent.prompt.variants)) });
      await ctx.db.insert("agentHarnessEvents", {
        project,
        agentId: agent.agentId,
        number: 1,
        action: "publish",
        by: ownerId,
        at: at + 60 * 60_000,
        configVersion: 1,
        override: { reason: "Made-up: published in the local data set." },
      });
      await ctx.db.insert("agentControls", {
        project,
        agentId: agent.agentId,
        name: definition.name,
        enabled: true,
        provider: definition.model!.provider,
        model: definition.model!.model,
        harnessVersion: "h1",
        version: 1,
        updatedAt: at + 60 * 60_000,
        updatedBy: ownerId,
      });
      const seeded = seedStartupOsRuns(now);
      for (const { output, ...run } of seeded.runs) {
        await ctx.db.insert("agentRuns", {
          project,
          runId: run.runId,
          agentId: run.agentId,
          version: run.version,
          trigger: run.trigger,
          status: run.status,
          startedAt: run.startedAt,
          durationMs: run.durationMs,
          steps: run.steps,
          toolCalls: run.toolCalls,
          pendingApprovals: pendingApprovalsOf(run.toolCalls),
          receivedAt: run.startedAt + run.durationMs,
        });
        const waiting = run.status === "awaiting_approval";
        await ctx.db.insert("agentRuntimeRuns", {
          project,
          runId: run.runId,
          agentId: run.agentId,
          versionNumber: 1,
          trigger: "api",
          state: waiting ? "awaiting_approval" : "done",
          actAs: ownerId,
          startedBy: ownerId,
          input: JSON.stringify({ variables: { focus: "made-up stuck cards" } }),
          ...(waiting ? { resume: seeded.waiting.state } : { finishedAt: run.startedAt + run.durationMs }),
          createdAt: run.startedAt,
          claimedAt: run.startedAt,
        });
        if (output !== null) {
          await ctx.db.insert("agentRunOutputs", {
            project,
            runId: run.runId,
            agentId: run.agentId,
            format: "text",
            text: output,
            truncated: false,
            // Its tools read the board: who may read it, kept with it.
            ownerOnly: false,
            areas: ["board"],
            createdAt: run.startedAt + run.durationMs,
          });
        }
      }
      await ctx.db.insert("agentApprovals", {
        project,
        rootAgentId: agent.agentId,
        rootRunId: seeded.waiting.runId,
        agentId: agent.agentId,
        runId: seeded.waiting.runId,
        toolId: seeded.waiting.toolId,
        arguments: seeded.waiting.arguments,
        state: "pending",
        createdAt: seeded.waiting.createdAt,
      });
    }

    // What the owner's Claude called (the Assistant page). Rows only: no token.
    for (const { minutesAgo, ...row } of SEED_AGENT_CALLS) {
      await ctx.db.insert("agentCalls", { userId: ownerId, at: now - minutesAgo * 60_000, ...row });
    }

    // The suggested bots' days (the Bots tab's last seven days), by the ids the tab adds them under.
    for (const day of SEED_BOT_CALL_DAYS) {
      const buckets = Array.from({ length: DURATION_BUCKETS_MS.length + 1 }, () => 0);
      buckets[bucketOf(day.typicalMs)] = day.calls;
      const at = now - day.daysAgo * 24 * 60 * 60_000;
      await ctx.db.insert("botCallDays", {
        userId: ownerId,
        bot: day.bot,
        day: new Date(at).toISOString().slice(0, 10),
        calls: day.calls,
        errors: day.errors,
        invalid: day.invalid,
        refused: day.refused,
        buckets,
        maxMs: day.typicalMs,
        costUsd: day.costUsd ?? 0,
        costCalls: day.costUsd === null ? 0 : day.calls,
        lastAt: at,
        provider: "external_grok",
      });
    }

    // What the owner's agents wrote (the Assistant page, and the owner's
    // Dashboard): a brief a company and proposals of each kind.
    // Each goes in through the function a tool or the page itself calls, so
    // the seed is held to the same limits and the same live data.
    const owner = ownerMember((await ctx.db.get(ownerId))!);
    const clock = { now: now - 40 * 60_000, today: new Date(now).toISOString().slice(0, 10) };
    for (const company of companyIds()) {
      await writeBrief(ctx, { agent: "chief_of_staff", company, bullets: SEED_BRIEFS[company] }, clock);
    }
    const tasks = await ctx.db.query("tasks").collect();
    const openTask = tasks.find((task) => task.column !== "done" && task.company !== "kz");
    const deals = await ctx.db.query("deals").collect();
    const dealOf = (market: "us" | "kz") =>
      deals.find((deal) => deal.market === market && deal.archivedAt === undefined);
    // The Contacts book, through the page's own functions (so its checks hold):
    // made-up people of each company, an introduction and links to a seeded
    // investor and deal.
    const investor = await ctx.db.query("investors").first();
    const contactIds = new Map<string, Id<"contacts">>();
    for (const row of SEED_CONTACTS.filter((contact) => isCompanyId(contact.company))) {
      const { key, link, introducedBy, lastContactDaysAgo, ...fields } = row;
      const made = await upsertContact(
        ctx,
        owner,
        {
          ...fields,
          ...(introducedBy === undefined || !contactIds.has(introducedBy)
            ? null
            : { introducedBy: contactIds.get(introducedBy)! }),
          ...(lastContactDaysAgo === undefined ? null : { lastContactAt: now - lastContactDaysAgo * 24 * 60 * 60 * 1000 }),
        },
        now,
      );
      contactIds.set(key, made.id);
      const record = link === "investor" ? investor?._id : link === "deal" ? dealOf(row.company)?._id : undefined;
      if (link !== undefined && record !== undefined) {
        await linkContact(ctx, owner, { contactId: made.id, type: link, id: record, linked: true }, now);
      }
    }
    const assignee = (await assignablePeople(ctx, owner, "us")).find(
      (person) => person.email !== LOCAL_OWNER_EMAIL,
    );
    const day = (ahead: number) => new Date(now + ahead * DAY_MS).toISOString().slice(0, 10);
    const proposed: Parameters<typeof propose>[2][] = [
      {
        agent: "engineering",
        company: "us",
        kind: "task_create",
        reason: "Made-up reason: a sample pull request has waited four days for a review.",
        urgency: "high",
        goalId: goalIds[1],
        dedupeKey: "engineering:task_create:sample-pull-1",
        payload: {
          title: "Made-up task: review the sample pull request",
          notes: "Made-up note: it is approved by nobody and blocks a sample release.",
          ...(assignee === undefined ? null : { assignee: assignee.email }),
          due: day(2),
          column: "this_week",
        },
      },
      {
        agent: "finance",
        company: "us",
        kind: "task_create",
        reason: "Made-up reason: a sample filing with a confirmed date comes due in two weeks.",
        urgency: "critical",
        goalId: goalIds[2],
        dedupeKey: "finance:task_create:sample-filing-1",
        payload: { title: "Made-up task: prepare the sample filing", due: day(10) },
      },
      {
        agent: "chief_of_staff",
        company: "us",
        kind: "draft",
        reason: "Made-up reason: it is the first run of the month.",
        dedupeKey: "chief_of_staff:draft:update-sample-month",
        payload: {
          title: "Made-up investor update",
          body: "Hello,\n\nA made-up month: every figure in this draft is invented.\n\nMRR: not read yet.\n\nThank you,\nSample Founder",
          about: { type: "update" },
        },
      },
    ];
    if (openTask !== undefined) {
      proposed.push({
        agent: "engineering",
        company: "us",
        kind: "task_change",
        reason: "Made-up reason: this sample task has no date and nobody on it.",
        dedupeKey: "engineering:task_change:sample-task-1",
        payload: { taskId: openTask._id, due: day(5), column: "this_week" },
      });
    }
    for (const market of (["kz", "us"] as const).filter(isCompanyId)) {
      const deal = dealOf(market);
      if (deal === undefined) continue;
      proposed.push({
        agent: "sales",
        company: market,
        kind: "deal_next_step",
        reason: "Made-up reason: this sample deal has been quiet for two weeks with no next step.",
        dedupeKey: `sales:deal_next_step:sample-${market}-1`,
        payload: { dealId: deal._id, nextStep: "Made-up next step: send the sample pricing" },
      });
      proposed.push({
        agent: "sales",
        company: market,
        kind: "draft",
        reason: "Made-up reason: a follow-up is due on this sample deal.",
        dedupeKey: `sales:draft:sample-${market}-1`,
        payload: {
          title: "Made-up follow-up",
          body: `Hello,\n\nA made-up follow-up: nothing here is sent from ${PRODUCT.name}.\n\nBest,\nSample Founder`,
          about: { type: "deal", id: deal._id },
        },
      });
    }
    const proposalIds = [];
    for (const input of proposed) proposalIds.push((await propose(ctx, owner, input, clock)).id);
    // Two already decided, so "Decided lately" is not empty: the last two made.
    const [keptId, refusedId] = proposalIds.slice(-2).reverse();
    if (keptId !== undefined) await approveProposal(ctx, owner, keptId, { now: now - 30 * 60_000 });
    if (refusedId !== undefined) {
      await dismiss(ctx, refusedId, { code: "wrong_data", reason: "Made-up reason: already done by hand." }, now - 25 * 60_000);
    }

    // Company memory: meetings and decisions for each company, written the
    // way the page writes them (decisions through `createDecision`, held to
    // the same owner check), one of the owner's due for a revisit today.
    {
      const meetingIds = new Map<string, Id<"meetingNotes">>();
      for (const meeting of SEED_MEETINGS.filter((seeded) => isCompanyId(seeded.company))) {
        const { key, daysAgo, ...row } = meeting;
        meetingIds.set(
          key,
          await ctx.db.insert("meetingNotes", {
            ...row,
            heldOn: day(-daysAgo),
            attendees: [LOCAL_OWNER_EMAIL],
            actionItems: row.actionItems.map((text) => ({ text })),
            createdBy: ownerId,
            createdAt: now - daysAgo * DAY_MS,
            updatedAt: now - daysAgo * DAY_MS,
          }),
        );
      }
      for (const seeded of SEED_DECISIONS.filter((decision) => isCompanyId(decision.company))) {
        await createDecision(ctx, owner, {
          company: seeded.company,
          title: seeded.title,
          decision: seeded.decision,
          context: seeded.context,
          status: seeded.status,
          decidedOn: day(-seeded.daysAgo),
          revisitOn: seeded.revisitIn === undefined ? null : day(seeded.revisitIn),
          tags: seeded.tags,
          owner: seeded.ownedByOwner ? LOCAL_OWNER_EMAIL : null,
          meetingId: seeded.meeting === undefined ? null : meetingIds.get(seeded.meeting)!,
        });
      }
    }

    // The LinkedIn calendar, written the way the page writes it (`savePost`,
    // `addStats`): posts of both companies, four weeks of figures, a target.
    {
      const startOfToday = now - (now % DAY_MS);
      for (const seeded of SEED_LINKEDIN.filter((post) => isCompanyId(post.company))) {
        const at = seeded.at === undefined ? undefined : startOfToday + seeded.at * DAY_MS + 9 * 60 * 60_000;
        const { id } = await savePost(
          ctx,
          owner,
          {
            company: seeded.company,
            account: seeded.account,
            person: seeded.person ?? null,
            status: seeded.status,
            title: seeded.title,
            body: seeded.body ?? null,
            pillar: seeded.pillar ?? null,
            owner: seeded.ownedByOwner ? LOCAL_OWNER_EMAIL : null,
            plannedAt: at ?? null,
            publishedAt: seeded.status === "published" ? (at ?? null) : null,
            link: seeded.link ?? null,
          },
          now,
        );
        for (const { after, ...figures } of seeded.figures ?? []) {
          await addStats(ctx, owner, { postId: id, day: day(seeded.at! + after), ...figures }, now);
        }
      }
      for (const company of companyIds()) {
        await ctx.db.insert("linkedinTargets", {
          company,
          postsPerWeek: SEED_LINKEDIN_TARGETS[company],
          updatedBy: ownerId,
          updatedAt: now,
        });
      }
    }

    // One conversation of the chat, made the way a real one is: asked,
    // claimed, a proposal put under the answer, and finished. The check-in
    // the claim wrote is taken out again: no Mac answered this.
    {
      const asked = now - 35 * 60_000;
      const sent = await sendMessage(ctx, { company: "us", text: SEED_CHAT.question }, asked);
      const runner = "seed-runner-0000";
      await claimNext(ctx, { runner }, { now: asked + 2_000, today: clock.today });
      for (const row of await ctx.db.query("chatRunner").collect()) await ctx.db.delete(row._id);
      const answer = await answerInProgress(ctx, sent.messageId);
      const made = await propose(
        ctx,
        owner,
        {
          agent: "chief_of_staff",
          company: "us",
          kind: "task_create",
          reason: SEED_CHAT.proposal.reason,
          dedupeKey: SEED_CHAT.proposal.dedupeKey,
          payload: { title: SEED_CHAT.proposal.title },
        },
        { now: asked + 9_000 },
      );
      await linkProposal(ctx, answer, made.id);
      await finishAnswer(
        ctx,
        { messageId: sent.messageId, runner, text: SEED_CHAT.answer, steps: [...SEED_CHAT.steps] },
        asked + 14_000,
      );
    }

    // Counts only: what the command prints. In one-company mode (the
    // `secondCompany` switch off) a row of the second company written above
    // is taken out here, in the same read: the seed holds nothing of it.
    const counts: Record<string, number> = {};
    for (const table of ["users", ...SEEDED_TABLES] as TableNames[]) {
      let count = 0;
      const secondCompanyOnly = SECOND_COMPANY_TABLES.has(table) && !isCompanyId(SECOND_COMPANY);
      for await (const row of ctx.db.query(table)) {
        const kept = secondCompanyOnly ? null : keptInUse(row);
        if (kept === null) {
          await ctx.db.delete(row._id);
          continue;
        }
        if (kept !== row) await ctx.db.patch(row._id, kept);
        count += 1;
      }
      if (count > 0) counts[table] = count;
    }
    return counts;
  },
});
