import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { Gate } from "./lib/owner";
import {
  ANY_AREA,
  AREAS,
  GRANTABLE_AREAS,
  MEMBER_ROLES,
  PAY_AND_COSTS,
  SENSITIVE_AREAS,
  areasOf,
  effectiveAreas,
  isSensitiveArea,
  may,
  type Area,
  type GrantableArea,
  type MemberRole,
  type StoredArea,
} from "./lib/roles";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsMember,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// The owner's access table, tested from the server's side: what each role may
// call, and what a teammate on one company is sent of the other's. The UI
// hides what these refuse, but nothing here depends on the UI.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Client = Awaited<ReturnType<typeof signInAsOwner>>;

// A made-up name and salary for the payroll rows: what must reach no teammate.
const PAYROLL_NAME = "SECRET PAYROLL PERSON";
const PAYROLL_GROSS = 987_654_321;
// Startup's own made-up person, for what a payroll holder on Globex must not reach.
const US_PAYROLL_NAME = "SECRET PAYROLL US PERSON";
const US_PAYROLL_GROSS = 876_543_219;
const SEP = "2026-09-01";
const KZ_SEP = { company: "kz", month: SEP } as const;
const US_SEP = { company: "us", month: SEP } as const;

// Made-up rows, one per company wherever a table is split by company. Every
// name carries its company, so an assertion can look for the other one's.
async function seed(t: TestBackend) {
  return await t.run(async (ctx) => {
    const snap = (key: string, scope: string, period: "week" | "month", source: string) =>
      ctx.db.insert("metricSnapshots", {
        key,
        scope,
        period,
        periodStart: period === "week" ? "2026-09-28" : "2026-09-01",
        value: 7,
        source,
        syncedAt: 1,
      });
    await snap("cash_in", "us", "month", "mercury"); // finance, Startup
    await snap("paying_clinics", "kz", "month", "cfo_workbook"); // finance, Globex
    await snap("fx_usd_kzt", "company", "month", "cfo_workbook"); // finance, Globex
    await snap("searches", "startup_insights", "week", "posthog"); // product, Startup
    await snap("clinics_using", "kz_product", "month", "cfo_workbook"); // product, Globex
    await snap("search_clicks", "company", "week", "search_console"); // marketing, Startup
    await snap("outbound_delivered", "us", "week", "apollo"); // gtm, Startup
    for (const source of [
      "mercury",
      "cfo_workbook",
      "posthog",
      "posthog_globex",
      "search_console",
      "apollo",
      "gmail",
      "linear",
    ]) {
      await ctx.db.insert("sourceStatus", { source, state: "ok", lastRunAt: 1, lastOkAt: 1 });
    }
    for (const [key, scope] of [
      ["cash_in", "us"],
      ["paying_clinics", "kz"],
      ["searches", "startup_insights"],
      ["clinics_using", "kz_product"],
    ] as const) {
      await ctx.db.insert("metricTargets", { key, scope, target: 100 });
    }
    // One figure of the financial model's plan, which is Startup's.
    await ctx.db.insert("planFigures", {
      scenario: "base",
      year: 2027,
      key: "arr",
      value: 7,
      modelVersion: "a1b2c3d",
      syncedAt: 1,
    });

    const deal = (market: "us" | "kz") =>
      ctx.db.insert("deals", {
        source: "manual",
        externalId: `deal-${market}`,
        market,
        name: `SECRET ${market} DEAL`,
        stage: "lead",
        order: 0,
      });
    const clinic = (market: "us" | "kz") =>
      ctx.db.insert("customers", {
        source: "client_register",
        nameKey: `secret ${market} clinic`,
        name: `SECRET ${market} CLINIC`,
        market,
        status: "active",
        currency: market === "us" ? "USD" : "KZT",
        syncedAt: 1,
      });
    const obligation = (category: "hipaa" | "kz_data" | "corporate_tax") =>
      ctx.db.insert("obligations", {
        category,
        title: `Item ${category}`,
        dueConfirmed: false,
        recurrence: "none",
        status: "open",
      });
    const task = (title: string, company?: "us" | "kz") =>
      ctx.db.insert("tasks", { title, kind: "issue", column: "backlog", order: 0, company });

    // Payroll: a person, a line and a saved month, all the owner's alone. The
    // name and the salary are ones no other test row holds.
    const payPerson = await ctx.db.insert("payrollPeople", {
      company: "kz",
      name: PAYROLL_NAME,
      kind: "employee",
      monthlyGross: PAYROLL_GROSS,
      currency: "KZT",
      notes: `${PAYROLL_NAME} note`,
      order: 0,
    });
    const payLine = await ctx.db.insert("payrollLines", {
      company: "kz",
      appliesTo: "employee",
      name: `${PAYROLL_NAME} LINE`,
      paidBy: "employee",
      rateBp: 1000,
      lessLineIds: [],
      allowance: 0,
      order: 0,
      active: true,
    });
    await ctx.db.insert("payrollRuns", {
      company: "kz",
      month: SEP,
      status: "draft",
      preparedAt: 1,
      rows: [
        {
          personId: payPerson,
          name: PAYROLL_NAME,
          kind: "employee",
          currency: "KZT",
          gross: PAYROLL_GROSS,
          lines: [],
          net: PAYROLL_GROSS,
          cost: PAYROLL_GROSS,
        },
      ],
    });

    const usPayPerson = await ctx.db.insert("payrollPeople", {
      company: "us",
      name: US_PAYROLL_NAME,
      kind: "employee",
      monthlyGross: US_PAYROLL_GROSS,
      currency: "USD",
      order: 0,
    });
    const usPayLine = await ctx.db.insert("payrollLines", {
      company: "us",
      appliesTo: "employee",
      name: `${US_PAYROLL_NAME} LINE`,
      paidBy: "employee",
      rateBp: 1000,
      lessLineIds: [],
      allowance: 0,
      order: 0,
      active: true,
    });
    await ctx.db.insert("payrollRuns", {
      company: "us",
      month: SEP,
      status: "draft",
      preparedAt: 1,
      rows: [
        {
          personId: usPayPerson,
          name: US_PAYROLL_NAME,
          kind: "employee",
          currency: "USD",
          gross: US_PAYROLL_GROSS,
          lines: [],
          net: US_PAYROLL_GROSS,
          cost: US_PAYROLL_GROSS,
        },
      ],
    });

    // Costs: one made-up line, Globex's, for the gate table's calls.
    const costLine = await ctx.db.insert("costs", {
      company: "kz",
      name: "Made-up cost line",
      category: "other",
      amount: 1_00,
      currency: "KZT",
      cadence: "monthly",
      startsOn: "2026-09",
      variable: false,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: 1,
    });
    // Budget and runway: one made-up scenario, Globex's.
    const scenario = await ctx.db.insert("scenarios", {
      company: "kz",
      name: "Made-up scenario",
      changes: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const control = await ctx.db.insert("complianceControls", {
      framework: "soc2",
      controlId: "CC1.1",
      title: "Seed control",
      updatedAt: 1,
    });
    return {
      costLine,
      scenario,
      questionnaire: await ctx.db.insert("securityQuestionnaires", {
        requester: "Seed",
        company: "us",
        status: "todo",
        updatedAt: 1,
      }),
      answer: await ctx.db.insert("answerBank", { question: "q", answer: "a", tags: [], updatedAt: 1 }),
      agreement: await ctx.db.insert("vendorAgreements", {
        vendor: "Seed",
        type: "nda",
        company: "us",
        status: "draft",
        updatedAt: 1,
      }),
      control,
      evidenceItem: await ctx.db.insert("evidenceItems", {
        controlId: control,
        title: "Seed",
        status: "missing",
        updatedAt: 1,
      }),
      payPerson,
      payLine,
      usPayPerson,
      usPayLine,
      usDeal: await deal("us"),
      kzDeal: await deal("kz"),
      usClinic: await clinic("us"),
      kzClinic: await clinic("kz"),
      hipaa: await obligation("hipaa"),
      kzData: await obligation("kz_data"),
      corporate: await obligation("corporate_tax"),
      investor: await ctx.db.insert("investors", {
        source: "manual",
        externalId: "inv-1",
        name: "SECRET FUND",
        stage: "lead",
        order: 0,
      }),
      usPartner: await ctx.db.insert("partners", {
        company: "us",
        name: "SECRET US PARTNER",
        type: "channel",
        stage: "identified",
        order: 0,
      }),
      kzPartner: await ctx.db.insert("partners", {
        company: "kz",
        name: "SECRET KZ PARTNER",
        type: "referral",
        stage: "identified",
        order: 0,
      }),
      usContact: await (async () => {
        const id = await ctx.db.insert("contacts", {
          name: "SECRET US CONTACT",
          emails: ["secret.us@example.test"],
          company: "us",
          category: "advisor",
          linkedRecords: [],
          canIntroTo: [],
          interactionCount: 0,
          normalizedName: "secret us contact",
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("contactEmails", {
          company: "us",
          email: "secret.us@example.test",
          contactId: id,
        });
        return id;
      })(),
      kzContact: await (async () => {
        const id = await ctx.db.insert("contacts", {
          name: "SECRET KZ CONTACT",
          emails: ["secret.kz@example.test"],
          company: "kz",
          category: "kz_clinic",
          linkedRecords: [],
          canIntroTo: [],
          interactionCount: 0,
          normalizedName: "secret kz contact",
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("contactEmails", {
          company: "kz",
          email: "secret.kz@example.test",
          contactId: id,
        });
        return id;
      })(),
      goal: await ctx.db.insert("goals", {
        quarter: "2026-Q4",
        title: "A goal",
        status: "on_track",
        order: 0,
      }),
      sharedTask: await task("Shared task"),
      usTask: await task("SECRET us task", "us"),
      kzTask: await task("SECRET kz task", "kz"),
      // Somebody else's notification, about a task that is gone: what no
      // caller here may read or mark.
      notification: await ctx.db.insert("notifications", {
        recipient: await ctx.db.insert("users", {}),
        kind: "assigned",
        actor: { type: "system", source: "standup" },
        taskId: await (async () => {
          const gone = await task("SECRET kz told task", "kz");
          await ctx.db.delete(gone);
          return gone;
        })(),
        company: "kz",
        title: "SECRET kz told task",
        createdAt: 1,
      }),
      member: await ctx.db.insert("members", {
        email: "someone.else@gmail.com",
        role: "engineer",
        companies: ["us"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
      }),
      // Company memory: a Startup decision and a Startup meeting's notes.
      ...(await (async () => {
        const createdBy = await ctx.db.insert("users", {});
        const meeting = await ctx.db.insert("meetingNotes", {
          company: "us",
          kind: "leadership",
          heldOn: "2026-10-01",
          title: "SECRET us meeting",
          attendees: [],
          outsideAttendees: [],
          notes: "SECRET us notes",
          actionItems: [{ text: "SECRET us action" }],
          createdBy,
          createdAt: 1,
          updatedAt: 1,
        });
        const decision = await ctx.db.insert("decisions", {
          company: "us",
          title: "SECRET us decision",
          decision: "SECRET us decided",
          decidedOn: "2026-10-01",
          status: "decided",
          taskIds: [],
          dealIds: [],
          goalIds: [],
          tags: [],
          createdBy,
          createdAt: 1,
          updatedAt: 1,
        });
        const handoff = await ctx.db.insert("handoffs", {
          company: "us",
          from: "research",
          fromKey: "research",
          to: "growth",
          toKey: "growth",
          title: "SECRET us handoff",
          summary: "SECRET us handoff summary",
          links: [],
          status: "open",
          openSince: 1,
          createdAt: 1,
          updatedAt: 1,
          history: [],
        });
        // A Startup LinkedIn post that went out, with a snapshot of its figures.
        const linkedinPost = await ctx.db.insert("linkedinPosts", {
          company: "us",
          account: "page",
          status: "published",
          title: "SECRET us post",
          publishedAt: Date.UTC(2026, 9, 14),
          sortAt: Date.UTC(2026, 9, 14),
          createdBy,
          createdAt: 1,
          updatedAt: 1,
        });
        const linkedinStat = await ctx.db.insert("linkedinStats", {
          postId: linkedinPost,
          company: "us",
          day: "2026-10-15",
          impressions: 4242,
          createdBy,
          createdAt: 1,
          updatedAt: 1,
        });
        return { meeting, decision, handoff, linkedinPost, linkedinStat };
      })()),
      // A role the owner named, that nobody has.
      role: await ctx.db.insert("roles", {
        name: "Made-up role",
        nameKey: "made-up role",
        focus: "general",
        areas: ["board"],
        createdBy: await ctx.db.insert("users", {}),
      }),
      // What the owner's agents wrote: a proposal waiting and a question
      // asked. The owner's alone to read, approve, dismiss or remove.
      // A client the owner added by hand for OAuth: a teammate may not remove it.
      oauthClient: await ctx.db.insert("oauthClients", {
        clientId: "sosc_SECRET-made-up",
        name: "SECRET oauth client",
        redirectUris: ["https://a.example.test/cb"],
        secretHash: "SECRET-hash",
        createdBy: "owner",
        createdAt: 1,
      }),
      // A client the owner connected: a teammate may neither see nor revoke it.
      agentToken: await ctx.db.insert("agentTokens", {
        userId: await ctx.db.insert("users", {}),
        tokenHash: "SECRET-token-hash",
        scope: "read",
        name: "SECRET client name",
        runner: false,
        createdAt: 1,
      }),
      // One of the owner's bots: a teammate may neither see nor change it.
      bot: await ctx.db.insert("bots", {
        userId: await ctx.db.insert("users", {}),
        botId: "made_up_bot",
        name: "SECRET bot name",
        role: "Made-up",
        clients: "any",
        permissions: [{ area: "board", level: "write" }],
        limits: { proposalsPerDay: 1, changesPer10Min: 1, callsPer10Min: 1 },
        enabled: true,
        suggested: false,
        createdAt: 1,
        updatedAt: 1,
      }),
      proposal: await ctx.db.insert("proposals", {
        agent: "sales",
        kind: "draft",
        company: "us",
        reason: "SECRET proposal reason",
        payload: { title: "SECRET draft", body: "SECRET draft text" },
        dedupeKey: "sales:draft:made-up",
        status: "open",
        createdAt: 1,
        editedBeforeApprove: false,
      }),
      question: await ctx.db.insert("questions", {
        company: "us",
        text: "SECRET question?",
        askedAt: 1,
      }),
      // A conversation of the owner's chat, with an answer still waiting.
      ...(await (async () => {
        const thread = await ctx.db.insert("chatThreads", {
          company: "us",
          title: "SECRET conversation",
          createdAt: 1,
          updatedAt: 1,
        });
        const message = await ctx.db.insert("chatMessages", {
          threadId: thread,
          role: "assistant",
          text: "SECRET answer",
          status: "queued",
          steps: [],
          proposalIds: [],
          askedAt: 1,
        });
        return { thread, message };
      })()),
      // A harness version put away (never published), a made-up test case
      // and a run of it, in a project nobody connected.
      ...(await (async () => {
        const by = await ctx.db.insert("users", {});
        const where = { project: "made-up-missing", agentId: "made-up.agent" };
        const harnessVersion = await ctx.db.insert("agentHarnessVersions", {
          ...where,
          number: 1,
          status: "archived",
          revision: 1,
          note: "",
          createdBy: by,
          createdAt: 1,
          updatedBy: by,
          updatedAt: 1,
        });
        const harnessCase = await ctx.db.insert("agentHarnessCases", {
          ...where,
          name: "Made-up case",
          variables: {},
          expect: [],
          createdBy: by,
          createdAt: 1,
          updatedBy: by,
          updatedAt: 1,
          madeUpAt: 1,
        });
        const harnessRun = await ctx.db.insert("agentHarnessRuns", {
          ...where,
          versionId: harnessVersion,
          number: 1,
          revision: 1,
          harness: '{"version":"draft-h1.1"}',
          models: [],
          status: "done",
          leases: 1,
          expected: 0,
          received: 0,
          passed: 0,
          createdBy: by,
          createdAt: 1,
        });
        // A decided approval of a Startup OS run that no longer waits: deciding it again is refused in words.
        const agentApproval = await ctx.db.insert("agentApprovals", {
          project: "startup-os",
          rootAgentId: "made-up.agent",
          rootRunId: "os-made-up",
          agentId: "made-up.agent",
          runId: "os-made-up",
          toolId: "tasks",
          arguments: "{}",
          state: "denied",
          createdAt: 1,
        });
        return { harnessVersion, harnessCase, harnessRun, agentApproval };
      })()),
    };
  });
}
type Ids = Awaited<ReturnType<typeof seed>>;

const areas = (...list: Area[]): Gate => ({ areas: list });
const FUNDRAISING: Gate = { areas: ["fundraising"], company: "us" };
// A US deal's sales intelligence (convex/dealIntel.ts): Sales, on Startup only.
const SALES_US: Gate = { areas: ["sales"], company: "us" };
const PLAN: Gate = { areas: ["finance"], company: "us" };
const GTM_US: Gate = { areas: ["gtm"], company: "us" };
// Globex's Intercom inbox (convex/support.ts): Support, on Globex only.
const SUPPORT_KZ: Gate = { areas: ["support"], company: "kz" };
// Globex's ISO 27001 pack (convex/isoPack.ts): Compliance, on Globex only.
const COMPLIANCE_KZ: Gate = { areas: ["compliance"], company: "kz" };
const ANYONE: Gate = { areas: ANY_AREA };
// Payroll and costs: the owner's alone (no teammate holds them, whatever a row says).
const PAYROLL_AREA: Gate = { areas: ["payroll"] };
const COSTS_AREA: Gate = { areas: ["costs"] };
// The two sensitive areas: ticked for a person by name, in no role's starting set.
const SETTINGS_AREA: Gate = { areas: ["settings"] };
const TEAM_AREA: Gate = { areas: ["team"] };

/**
 * Every public function: the gate it must carry, and a call with arguments
 * that pass validation. A new public function fails the first test below
 * until it has a line here.
 */
const SURFACE: Record<string, { gate: Gate; call: (c: Client, ids: Ids) => Promise<unknown> }> = {
  "metrics:scorecard": { gate: ANYONE, call: (c) => c.query(api.metrics.scorecard, {}) },
  // Each source is gated inside as the page's own data is (convex/freshness.test.ts).
  "freshness:forPage": {
    gate: ANYONE,
    call: (c) => c.query(api.freshness.forPage, { page: "finance", company: "us" }),
  },
  "metrics:series": {
    gate: ANYONE,
    call: (c) => c.query(api.metrics.series, { key: "cash_in", scope: "us" }),
  },
  // Read with the scorecard, and by whoever sets them (the `settings` area).
  "targets:list": {
    gate: areas("scorecard", "settings"),
    call: (c) => c.query(api.targets.list, {}),
  },
  "targets:set": {
    gate: SETTINGS_AREA,
    call: (c) => c.mutation(api.targets.set, { key: "cash_in", scope: "us", target: 1 }),
  },
  "targets:clear": {
    gate: SETTINGS_AREA,
    call: (c) => c.mutation(api.targets.clear, { key: "cash_in", scope: "us" }),
  },
  "snapshots:setManual": {
    gate: SETTINGS_AREA,
    call: (c) =>
      c.mutation(api.snapshots.setManual, {
        key: "cash",
        scope: "kz",
        date: "2026-10-01",
        value: 1,
        currency: "KZT",
      }),
  },
  "snapshots:removeManual": {
    gate: SETTINGS_AREA,
    call: (c) =>
      c.mutation(api.snapshots.removeManual, { key: "cash", scope: "kz", periodStart: SEP }),
  },
  "sources:list": { gate: SETTINGS_AREA, call: (c) => c.query(api.sources.list, {}) },
  "sources:recentRuns": { gate: SETTINGS_AREA, call: (c) => c.query(api.sources.recentRuns, {}) },
  "sources:runNow": {
    gate: SETTINGS_AREA,
    call: (c) => c.mutation(api.sources.runNow, { source: "mercury" }),
  },

  "deals:board": {
    gate: areas("sales"),
    call: (c) => c.query(api.deals.board, { market: "us" }),
  },
  "deals:createdSince": {
    gate: areas("sales"),
    call: (c) => c.query(api.deals.createdSince, { since: 0 }),
  },
  "deals:create": {
    gate: areas("sales"),
    call: (c) => c.mutation(api.deals.create, { market: "us", name: "New Co" }),
  },
  "deals:move": {
    gate: areas("sales"),
    call: (c, ids) => c.mutation(api.deals.move, { id: ids.usDeal, stage: "qualified", index: 0 }),
  },
  "deals:update": {
    gate: areas("sales"),
    call: (c, ids) => c.mutation(api.deals.update, { id: ids.usDeal, notes: "x" }),
  },
  "deals:setGoal": {
    gate: areas("sales"),
    call: (c, ids) => c.mutation(api.deals.setGoal, { id: ids.usDeal, goalId: null }),
  },
  "deals:remove": {
    gate: areas("sales"),
    call: (c, ids) => c.mutation(api.deals.remove, { id: ids.usDeal }),
  },
  "deals:archive": {
    gate: areas("sales"),
    call: (c, ids) => c.mutation(api.deals.archive, { id: ids.usDeal }),
  },
  "deals:restore": {
    gate: areas("sales"),
    call: (c, ids) => c.mutation(api.deals.restore, { id: ids.usDeal }),
  },
  "deals:archived": {
    gate: areas("sales"),
    call: (c) => c.query(api.deals.archived, { market: "us" }),
  },
  "dealIntel:get": {
    gate: SALES_US,
    call: (c, ids) => c.query(api.dealIntel.get, { dealId: ids.usDeal }),
  },
  "dealIntel:list": { gate: SALES_US, call: (c) => c.query(api.dealIntel.list, {}) },
  "dealIntel:update": {
    gate: SALES_US,
    call: (c, ids) => c.mutation(api.dealIntel.update, { dealId: ids.usDeal, summary: "x" }),
  },

  // Handoffs between bots (convex/handoffs.ts).
  "handoffs:list": { gate: areas("board"), call: (c) => c.query(api.handoffs.list, {}) },
  "handoffs:waiting": { gate: areas("board"), call: (c) => c.query(api.handoffs.waiting, {}) },
  "handoffs:recipients": { gate: areas("board"), call: (c) => c.query(api.handoffs.recipients, { company: "us" }) },
  "handoffs:reassign": {
    gate: areas("board"),
    call: (c, ids) => c.mutation(api.handoffs.reassign, { id: ids.handoff, to: "Ops" }),
  },
  // Closing one that will not be answered is the owner's alone (reassigning stays the board's).
  "handoffs:close": { gate: "owner", call: (c, ids) => c.mutation(api.handoffs.close, { id: ids.handoff }) },
  // A person answering a handoff a bot made to them (the fixture's is a bot's: past the gate it is refused as not theirs).
  "handoffs:answer": {
    gate: areas("board"),
    call: (c, ids) => c.mutation(api.handoffs.answer, { id: ids.handoff, action: "accept" }),
  },
  // The LinkedIn content calendar (convex/linkedin.ts): Go to market, either company.
  "linkedin:list": { gate: areas("gtm"), call: (c) => c.query(api.linkedin.list, {}) },
  "linkedin:people": {
    gate: areas("gtm"),
    call: (c) => c.query(api.linkedin.people, { company: "us" }),
  },
  "linkedin:save": {
    gate: areas("gtm"),
    call: (c, ids) =>
      c.mutation(api.linkedin.save, {
        id: ids.linkedinPost,
        company: "us",
        account: "page",
        person: null,
        status: "idea",
        title: "A post",
        body: null,
        pillar: null,
        owner: null,
        plannedAt: null,
        publishedAt: null,
        link: null,
      }),
  },
  "linkedin:remove": {
    gate: areas("gtm"),
    call: (c, ids) => c.mutation(api.linkedin.remove, { id: ids.linkedinPost }),
  },
  "linkedin:addSnapshot": {
    gate: areas("gtm"),
    call: (c, ids) =>
      c.mutation(api.linkedin.addSnapshot, { postId: ids.linkedinPost, day: "2026-10-16", impressions: 1 }),
  },
  "linkedin:removeSnapshot": { // gitleaks:allow (a function name, not a client id)
    gate: areas("gtm"),
    call: (c, ids) => c.mutation(api.linkedin.removeSnapshot, { id: ids.linkedinStat }),
  },
  "linkedin:setTarget": {
    gate: areas("gtm"),
    call: (c) => c.mutation(api.linkedin.setTarget, { company: "us", postsPerWeek: 2 }),
  },

  // Company memory: decisions (convex/decisions.ts).
  "decisions:list": { gate: areas("memory"), call: (c) => c.query(api.decisions.list, {}) },
  "decisions:create": {
    gate: areas("memory"),
    call: (c) =>
      c.mutation(api.decisions.create, {
        company: "us",
        title: "A decision",
        decision: "Decided",
        decidedOn: "2026-10-01",
        status: "decided",
      }),
  },
  "decisions:update": {
    gate: areas("memory"),
    call: (c, ids) =>
      c.mutation(api.decisions.update, {
        id: ids.decision,
        company: "us",
        title: "A decision",
        decision: "Decided",
        decidedOn: "2026-10-01",
        status: "revisit",
      }),
  },
  "decisions:remove": {
    gate: areas("memory"),
    call: (c, ids) => c.mutation(api.decisions.remove, { id: ids.decision }),
  },
  "decisions:mineToRevisit": {
    gate: areas("memory"),
    call: (c) => c.query(api.decisions.mineToRevisit, { today: "2026-10-14" }),
  },
  "decisions:people": {
    gate: areas("memory"),
    call: (c) => c.query(api.decisions.people, { company: "us" }),
  },
  "decisions:linkable": {
    gate: areas("memory"),
    call: (c) => c.query(api.decisions.linkable, { company: "us", quarter: "2026-Q4" }),
  },

  // Company memory: meeting notes (convex/meetingNotes.ts).
  "meetingNotes:list": { gate: areas("memory"), call: (c) => c.query(api.meetingNotes.list, {}) },
  "notes:list": { gate: areas("memory"), call: (c) => c.query(api.notes.list, {}) },
  "notes:create": {
    gate: areas("memory"),
    call: (c) => c.mutation(api.notes.create, { company: "us", title: "A note", body: "Made up." }),
  },
  "comments:list": {
    gate: areas("board", "sales"),
    call: (c, ids) => c.query(api.comments.list, { subjectKind: "task", subjectId: ids.sharedTask }),
  },
  "comments:create": {
    gate: areas("board", "sales"),
    call: (c, ids) =>
      c.mutation(api.comments.create, { subjectKind: "task", subjectId: ids.sharedTask, body: "A comment." }),
  },
  "meetingNotes:get": {
    gate: areas("memory"),
    call: (c, ids) => c.query(api.meetingNotes.get, { id: ids.meeting }),
  },
  "meetingNotes:create": {
    gate: areas("memory"),
    call: (c) =>
      c.mutation(api.meetingNotes.create, {
        company: "us",
        kind: "other",
        heldOn: "2026-10-01",
        title: "A meeting",
        notes: "",
        attendees: [],
        outsideAttendees: [],
        actionItems: [],
      }),
  },
  "meetingNotes:update": {
    gate: areas("memory"),
    call: (c, ids) =>
      c.mutation(api.meetingNotes.update, {
        id: ids.meeting,
        company: "us",
        kind: "other",
        heldOn: "2026-10-01",
        title: "A meeting",
        notes: "",
        attendees: [],
        outsideAttendees: [],
        actionItems: [],
      }),
  },
  // The import from the owner's own Fireflies: the owner's alone.
  "workTools:importableMeetings": {
    gate: "owner",
    call: (c) => c.query(api.workTools.importableMeetings, {}),
  },
  "workTools:meetingToImport": {
    gate: "owner",
    call: (c) => c.query(api.workTools.meetingToImport, { meetingId: "ff-1" }),
  },
  "meetingNotes:remove": {
    gate: areas("memory"),
    call: (c, ids) => c.mutation(api.meetingNotes.remove, { id: ids.meeting }),
  },
  "meetingNotes:addActionToBoard": {
    gate: areas("memory"),
    call: (c, ids) => c.mutation(api.meetingNotes.addActionToBoard, { id: ids.meeting, index: 0 }),
  },

  "customers:list": { gate: areas("customers"), call: (c) => c.query(api.customers.list, {}) },
  "customers:usage": { gate: areas("customers"), call: (c) => c.query(api.customers.usage, {}) },
  "kzProduct:breakdowns": {
    gate: { areas: ["product"], company: "kz" },
    call: (c) => c.query(api.kzProduct.breakdowns, { kind: "hour" }),
  },
  "kzProduct:history": {
    gate: { areas: ["product"], company: "kz" },
    call: (c) => c.query(api.kzProduct.history, {}),
  },
  "kzProduct:appClinics": {
    gate: { areas: ["product"], company: "kz" },
    call: (c) => c.query(api.kzProduct.appClinics, {}),
  },
  "customers:setAppClinic": {
    gate: { areas: ["customers"], company: "kz" },
    call: (c, ids) => c.mutation(api.customers.setAppClinic, { id: ids.kzClinic, org: null }),
  },
  "customers:doctorRoster": { gate: areas("customers"), call: (c) => c.query(api.customers.doctorRoster, {}) },
  "customers:doctors": {
    gate: areas("customers"),
    call: (c, ids) => c.query(api.customers.doctors, { customerId: ids.usClinic }),
  },
  "customers:setOwnerFields": {
    gate: areas("customers"),
    call: (c, ids) => c.mutation(api.customers.setOwnerFields, { id: ids.usClinic, note: "x" }),
  },
  // Whether a deal is on Customers: asked by the deal's page, so Sales.
  "customers:ofDeal": {
    gate: areas("sales"),
    call: (c, ids) => c.query(api.customers.ofDeal, { dealId: ids.usDeal }),
  },

  "obligations:list": {
    gate: areas("compliance"),
    call: (c) => c.query(api.obligations.list, {}),
  },
  "obligations:create": {
    gate: areas("compliance"),
    call: (c) => c.mutation(api.obligations.create, { category: "contracts", title: "x" }),
  },
  "obligations:update": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.obligations.update, { id: ids.corporate, title: "x" }),
  },
  "obligations:complete": {
    gate: areas("compliance"),
    call: (c, ids) =>
      c.mutation(api.obligations.complete, {
        id: ids.corporate,
        today: "2026-10-12",
        expectedDue: null,
      }),
  },
  "obligations:remove": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.obligations.remove, { id: ids.corporate }),
  },
  "starterChecklist:add": {
    gate: areas("compliance"),
    call: (c) => c.mutation(api.starterChecklist.add, { today: "2026-10-12" }),
  },
  "isoPack:add": {
    gate: COMPLIANCE_KZ,
    call: (c) => c.mutation(api.isoPack.add, {}),
  },

  "evidence:questionnaires": {
    gate: areas("compliance"),
    call: (c) => c.query(api.evidence.questionnaires, {}),
  },
  "evidence:answers": {
    gate: areas("compliance"),
    call: (c) => c.query(api.evidence.answers, {}),
  },
  "evidence:agreements": {
    gate: areas("compliance"),
    call: (c) => c.query(api.evidence.agreements, {}),
  },
  "evidence:controls": {
    gate: areas("compliance"),
    call: (c) => c.query(api.evidence.controls, {}),
  },
  "evidence:questionnaireUpsert": {
    gate: areas("compliance"),
    call: (c) => c.mutation(api.evidence.questionnaireUpsert, { requester: "x", company: "us" }),
  },
  "evidence:answerUpsert": {
    gate: areas("compliance"),
    call: (c) => c.mutation(api.evidence.answerUpsert, { question: "x", answer: "y" }),
  },
  "evidence:agreementUpsert": {
    gate: areas("compliance"),
    call: (c) => c.mutation(api.evidence.agreementUpsert, { vendor: "x", type: "nda", company: "us" }),
  },
  "evidence:controlUpsert": {
    gate: areas("compliance"),
    call: (c) => c.mutation(api.evidence.controlUpsert, { framework: "soc2", controlId: "CC1.1", title: "x" }),
  },
  "evidence:questionnaireRemove": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.evidence.questionnaireRemove, { id: ids.questionnaire }),
  },
  "evidence:answerRemove": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.evidence.answerRemove, { id: ids.answer }),
  },
  "evidence:agreementRemove": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.evidence.agreementRemove, { id: ids.agreement }),
  },
  "evidence:controlRemove": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.evidence.controlRemove, { id: ids.control }),
  },
  "evidence:evidenceItemUpsert": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.evidence.evidenceItemUpsert, { controlId: ids.control, title: "x" }),
  },
  "evidence:evidenceItemRemove": {
    gate: areas("compliance"),
    call: (c, ids) => c.mutation(api.evidence.evidenceItemRemove, { id: ids.evidenceItem }),
  },
  // Partnerships: the area, and the company of each row (checked inside).
  "partnerships:board": {
    gate: areas("partnerships"),
    call: (c) => c.query(api.partnerships.board, { company: "us" }),
  },
  "partnerships:create": {
    gate: areas("partnerships"),
    call: (c) =>
      c.mutation(api.partnerships.create, { company: "us", name: "New Partner", type: "referral" }),
  },
  "partnerships:move": {
    gate: areas("partnerships"),
    call: (c, ids) =>
      c.mutation(api.partnerships.move, { id: ids.usPartner, stage: "contacted", index: 0 }),
  },
  "partnerships:update": {
    gate: areas("partnerships"),
    call: (c, ids) => c.mutation(api.partnerships.update, { id: ids.usPartner, notes: "x" }),
  },
  "partnerships:remove": {
    gate: areas("partnerships"),
    call: (c, ids) => c.mutation(api.partnerships.remove, { id: ids.usPartner }),
  },
  // Contacts: the area, and the company of each row (checked inside).
  "contacts:list": {
    gate: areas("contacts"),
    call: (c) => c.query(api.contacts.list, { company: "us" }),
  },
  "contacts:get": {
    gate: areas("contacts"),
    call: (c, ids) => c.query(api.contacts.get, { id: ids.usContact }),
  },
  "contacts:forRecord": {
    gate: areas("contacts"),
    call: (c, ids) => c.query(api.contacts.forRecord, { type: "investor", id: ids.investor }),
  },
  "contacts:introPaths": {
    gate: areas("contacts"),
    call: (c) => c.query(api.contacts.introPaths, { company: "us", target: "clinic" }),
  },
  "contacts:upsert": {
    gate: areas("contacts"),
    call: (c) =>
      c.mutation(api.contacts.upsert, {
        company: "us",
        name: "New Contact",
        emails: ["new.contact@example.test"],
      }),
  },
  "contacts:addNote": {
    gate: areas("contacts"),
    call: (c, ids) => c.mutation(api.contacts.addNote, { id: ids.usContact, text: "x" }),
  },
  "contacts:link": {
    gate: areas("contacts"),
    call: (c, ids) =>
      c.mutation(api.contacts.link, {
        contactId: ids.usContact,
        type: "investor",
        id: ids.investor,
        linked: true,
      }),
  },
  "contacts:merge": {
    gate: areas("contacts"),
    call: (c) => c.mutation(api.contacts.merge, { dryRun: true, company: "us" }),
  },
  "investors:board": { gate: FUNDRAISING, call: (c) => c.query(api.investors.board, {}) },
  "support:overview": { gate: SUPPORT_KZ, call: (c) => c.query(api.support.overview, {}) },
  "investors:create": {
    gate: FUNDRAISING,
    call: (c) => c.mutation(api.investors.create, { name: "New Fund" }),
  },
  "investors:move": {
    gate: FUNDRAISING,
    call: (c, ids) =>
      c.mutation(api.investors.move, { id: ids.investor, stage: "contacted", index: 0 }),
  },
  "investors:update": {
    gate: FUNDRAISING,
    call: (c, ids) => c.mutation(api.investors.update, { id: ids.investor, notes: "x" }),
  },
  "investors:remove": {
    gate: FUNDRAISING,
    call: (c, ids) => c.mutation(api.investors.remove, { id: ids.investor }),
  },
  "investors:get": {
    gate: FUNDRAISING,
    call: (c, ids) => c.query(api.investors.get, { id: ids.investor }),
  },
  "investors:syncHistory": {
    gate: FUNDRAISING,
    call: (c, ids) => c.query(api.investors.syncHistory, { id: ids.investor }),
  },
  "investors:retrySync": {
    gate: FUNDRAISING,
    call: (c, ids) => c.mutation(api.investors.retrySync, { id: ids.investor }),
  },
  "investors:archive": {
    gate: FUNDRAISING,
    call: (c, ids) => c.mutation(api.investors.archive, { id: ids.investor }),
  },
  "investors:restore": {
    gate: FUNDRAISING,
    call: (c, ids) => c.mutation(api.investors.restore, { id: ids.investor }),
  },
  "investors:archived": { gate: FUNDRAISING, call: (c) => c.query(api.investors.archived, {}) },
  "investors:bulk": {
    gate: FUNDRAISING,
    call: (c, ids) =>
      c.mutation(api.investors.bulk, { ids: [ids.investor], action: { kind: "nextStep", text: "x" } }),
  },
  "plan:get": { gate: PLAN, call: (c) => c.query(api.plan.get, {}) },

  "goals:list": {
    gate: areas("scorecard", "board"),
    call: (c) => c.query(api.goals.list, { quarter: "2026-Q4" }),
  },
  "goals:links": {
    gate: areas("scorecard", "board"),
    call: (c) => c.query(api.goals.links, { quarter: "2026-Q4" }),
  },
  "goals:create": {
    gate: areas("review"),
    call: (c) => c.mutation(api.goals.create, { quarter: "2026-Q4", title: "x" }),
  },
  "goals:update": {
    gate: areas("review"),
    call: (c, ids) => c.mutation(api.goals.update, { id: ids.goal, title: "x" }),
  },
  "goals:remove": {
    gate: areas("review"),
    call: (c, ids) => c.mutation(api.goals.remove, { id: ids.goal }),
  },
  "tasks:board": { gate: areas("board"), call: (c) => c.query(api.tasks.board, {}) },
  "tasks:openIssues": {
    gate: areas("scorecard", "board"),
    call: (c) => c.query(api.tasks.openIssues, {}),
  },
  "tasks:create": {
    gate: areas("board"),
    call: (c) => c.mutation(api.tasks.create, { title: "x" }),
  },
  "tasks:move": {
    gate: areas("board"),
    call: (c, ids) =>
      c.mutation(api.tasks.move, { id: ids.sharedTask, column: "doing", index: 0 }),
  },
  "tasks:update": {
    gate: areas("board"),
    call: (c, ids) => c.mutation(api.tasks.update, { id: ids.sharedTask, title: "y" }),
  },
  "tasks:remove": {
    gate: areas("board"),
    call: (c, ids) => c.mutation(api.tasks.remove, { id: ids.sharedTask }),
  },
  "tasks:archive": {
    gate: areas("board"),
    call: (c, ids) => c.mutation(api.tasks.archive, { id: ids.usTask }),
  },

  // "Suggest a change": anyone with a page, the board or not.
  "suggestions:create": {
    gate: ANYONE,
    call: (c) => c.mutation(api.suggestions.create, { text: "Make the numbers bigger" }),
  },

  // The notification center: anyone with a page, each their own rows alone
  // (convex/notifications.test.ts). Marking somebody else's is refused past
  // the gate, in the words for a row that is gone.
  "notifications:mine": { gate: ANYONE, call: (c) => c.query(api.notifications.mine, {}) },
  "notifications:unreadCount": {
    gate: ANYONE,
    call: (c) => c.query(api.notifications.unreadCount, {}),
  },
  "notifications:markRead": {
    gate: ANYONE,
    call: (c, ids) => c.mutation(api.notifications.markRead, { id: ids.notification }),
  },
  "notifications:markAllRead": {
    gate: ANYONE,
    call: (c) => c.mutation(api.notifications.markAllRead, {}),
  },

  "workTools:issues": { gate: areas("board"), call: (c) => c.query(api.workTools.issues, {}) },
  // Apollo's shared lists for the go-to-market page. Apollo is Startup's.
  "workTools:outbound": { gate: GTM_US, call: (c) => c.query(api.workTools.outbound, {}) },
  // GitHub's repositories for the Engineering page: each company's own rows only.
  "workTools:engineering": {
    gate: areas("engineering"),
    call: (c) => c.query(api.workTools.engineering, {}),
  },
  // GitHub's pull requests, with their titles and authors: the same page, the same rule.
  "workTools:pullRequests": {
    gate: areas("engineering"),
    call: (c) => c.query(api.workTools.pullRequests, {}),
  },
  // Today: each caller's own mail, calendar, meeting notes and issues.
  "workTools:needsReply": {
    gate: areas("today"),
    call: (c) => c.query(api.workTools.needsReply, {}),
  },
  "workTools:events": {
    gate: areas("today"),
    call: (c) => c.query(api.workTools.events, { from: 0, to: 1000 }),
  },
  "workTools:meetings": {
    gate: areas("today"),
    call: (c) => c.query(api.workTools.meetings, {}),
  },
  "workTools:myIssues": {
    gate: areas("today"),
    call: (c) => c.query(api.workTools.myIssues, {}),
  },
  // "Connect your Claude": the caller's own token and what is held for them.
  "connect:status": { gate: areas("today"), call: (c) => c.query(api.connect.status, {}) },
  "connect:createToken": {
    gate: areas("today"),
    call: (c) => c.mutation(api.connect.createToken, { entropy: "e".repeat(43) }),
  },
  "connect:revokeToken": {
    gate: areas("today"),
    call: (c) => c.mutation(api.connect.revokeToken, {}),
  },
  "connect:forget": {
    gate: areas("today"),
    call: (c) => c.mutation(api.connect.forget, { source: "gmail" }),
  },
  "connect:forgetAll": {
    gate: areas("today"),
    call: (c) => c.mutation(api.connect.forgetAll, {}),
  },
  "workTools:settings": { gate: "owner", call: (c) => c.query(api.workTools.settings, {}) },
  "workTools:setDomains": {
    gate: "owner",
    call: (c) => c.mutation(api.workTools.setDomains, { investor: [], customer: [] }),
  },
  "workTools:turnOff": {
    gate: "owner",
    call: (c) => c.mutation(api.workTools.turnOff, { source: "linear" }),
  },
  "workTools:turnOn": {
    gate: "owner",
    call: (c) => c.mutation(api.workTools.turnOn, { source: "linear" }),
  },
  "google:connection": { gate: "owner", call: (c) => c.query(api.google.connection, {}) },
  "google:begin": {
    gate: "owner",
    call: (c) =>
      c.mutation(api.google.begin, {
        state: "s".repeat(43),
        verifier: "v".repeat(43),
        challenge: "c".repeat(43),
      }),
  },
  "google:disconnect": { gate: "owner", call: (c) => c.mutation(api.google.disconnect, {}) },

  // The owner's assistant (convex/assistant.ts): the clients the owner
  // connected to POST /mcp/v1, each with its own token, and the record of what
  // they called. No teammate has one, whatever their pages.
  "assistant:clients": { gate: "owner", call: (c) => c.query(api.assistant.clients, {}) },
  "assistant:createToken": {
    gate: "owner",
    call: (c) =>
      c.mutation(api.assistant.createToken, { entropy: "e".repeat(43), scope: "act", name: "Made-up client" }),
  },
  "assistant:setBotsOnly": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.assistant.setBotsOnly, { kind: "token", id: ids.agentToken as string, on: true }),
  },
  "assistant:setScope": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.assistant.setScope, { kind: "token", id: ids.agentToken as string, scope: "read" }),
  },
  "assistant:revokeClient": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.assistant.revokeClient, { kind: "token", id: ids.agentToken as string }),
  },
  // OAuth for that endpoint (convex/oauth.ts): the consent page's two, and
  // the clients the owner adds by hand. Owner only: a teammate can approve
  // nothing, and is told so on the page.
  "oauth:describe": {
    gate: "owner",
    call: (c) => c.query(api.oauth.describe, { clientId: "sosc_made-up", redirectUri: "https://a.example.test/cb" }),
  },
  "oauth:approve": {
    gate: "owner",
    call: (c) =>
      c.mutation(api.oauth.approve, {
        clientId: "sosc_made-up",
        redirectUri: "https://a.example.test/cb",
        granted: "read",
        entropy: "e".repeat(43),
      }),
  },
  "oauth:handClients": { gate: "owner", call: (c) => c.query(api.oauth.handClients, {}) },
  "oauth:createClient": {
    gate: "owner",
    call: (c) =>
      c.mutation(api.oauth.createClient, {
        name: "Made-up",
        redirectUris: ["https://a.example.test/cb"],
        entropy: "e".repeat(43),
      }),
  },
  "oauth:removeClient": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.oauth.removeClient, { id: ids.oauthClient }),
  },
  // The owner's bots (convex/bots.ts): external bots' profiles, permissions and limits.
  "bots:list": { gate: "owner", call: (c) => c.query(api.bots.list, { today: "2026-10-18" }) },
  "bots:weeklyStats": { gate: "owner", call: (c) => c.query(api.bots.weeklyStats, { since: 0 }) },
  "bots:telemetry": { gate: "owner", call: (c) => c.query(api.bots.telemetry, { today: "2026-10-14" }) },
  // What came of the bots' plays (Bot Loop v3): a subject's timeline on the
  // outcomes area; the Bots tab's per-bot plays, the owner's.
  "outcomes:forSubject": {
    gate: areas("outcomes"),
    call: (c) => c.query(api.outcomes.forSubject, { kind: "deal", id: "x" }),
  },
  "outcomes:playsByBot": { gate: "owner", call: (c) => c.query(api.outcomes.playsByBot, { since: 0 }) },
  // A bot's requests for a fix (convex/devRequests.ts): the Bots tab's, the owner's alone.
  "devRequests:forBot": { gate: "owner", call: (c) => c.query(api.devRequests.forBot, { botId: "growth" }) },
  "devRequests:openCount": { gate: "owner", call: (c) => c.query(api.devRequests.openCount, {}) },
  "bots:create": {
    gate: "owner",
    call: (c) => c.mutation(api.bots.create, { botId: "made_up_new", name: "Made-up", role: "" }),
  },
  "bots:update": { gate: "owner", call: (c, ids) => c.mutation(api.bots.update, { id: ids.bot, enabled: false }) },
  "bots:makeToken": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.bots.makeToken, { id: ids.bot, entropy: "e".repeat(43) }),
  },
  "bots:remove": { gate: "owner", call: (c, ids) => c.mutation(api.bots.remove, { id: ids.bot }) },
  "bots:addSuggested": { gate: "owner", call: (c) => c.mutation(api.bots.addSuggested, {}) },
  "bots:addExternalProfile": { gate: "owner", call: (c) => c.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" }) },
  "duplicates:settings": { gate: "owner", call: (c) => c.query(api.duplicates.settings, {}) },
  "duplicates:setThreshold": { gate: "owner", call: (c) => c.mutation(api.duplicates.setThreshold, { threshold: 0.9 }) },
  "bots:rules": { gate: "owner", call: (c) => c.query(api.bots.rules, {}) },
  "bots:publishRules": {
    gate: "owner",
    call: (c) => c.mutation(api.bots.publishRules, { rules: "Made-up rules.", notes: [] }),
  },
  "bots:activity": { gate: "owner", call: (c) => c.query(api.bots.activity, { since: 0 }) },
  "bots:refusedLately": { gate: "owner", call: (c) => c.query(api.bots.refusedLately, { since: 0 }) },
  "bots:grant": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.bots.grant, { id: ids.bot, area: "sales", level: "read" }),
  },
  "assistant:recentCalls": {
    gate: "owner",
    call: (c) => c.query(api.assistant.recentCalls, {}),
  },
  // What the owner's agents write and the owner decides: the brief, the
  // proposals, the questions, the switches and the week's counts.
  "assistant:agents": { gate: "owner", call: (c) => c.query(api.assistant.agents, {}) },
  "assistant:setAgent": {
    gate: "owner",
    call: (c) => c.mutation(api.assistant.setAgent, { agent: "sales", on: false }),
  },
  "assistant:brief": {
    gate: "owner",
    call: (c) => c.query(api.assistant.brief, { company: "us" }),
  },
  "assistant:briefArchive": {
    gate: "owner",
    call: (c) => c.query(api.assistant.briefArchive, { company: "us" }),
  },
  // The approvals inbox (/approvals): every open proposal and paused tool call, and what became of them.
  "assistant:inbox": { gate: "owner", call: (c) => c.query(api.assistant.inbox, {}) },
  "assistant:decided": { gate: "owner", call: (c) => c.query(api.assistant.decided, { since: 0 }) },
  "assistant:approve": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.assistant.approve, { id: ids.proposal }),
  },
  "assistant:dismiss": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.assistant.dismiss, { id: ids.proposal, code: "wrong_timing" }),
  },
  // Earned autonomy (convex/trust.ts): the owner's alone.
  "trust:offers": { gate: "owner", call: (c) => c.query(api.trust.offers, {}) },
  "trust:grants": { gate: "owner", call: (c) => c.query(api.trust.grants, {}) },
  "trust:grant": {
    gate: "owner",
    call: (c) => c.mutation(api.trust.grant, { proposer: "engineering", kind: "task_create" }),
  },
  "trust:notYet": {
    gate: "owner",
    call: (c) => c.mutation(api.trust.notYet, { proposer: "engineering", kind: "task_create" }),
  },
  "trust:revoke": {
    gate: "owner",
    call: (c) => c.mutation(api.trust.revoke, { proposer: "engineering", kind: "task_create" }),
  },
  "trust:flag": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.trust.flag, { id: ids.proposal }),
  },
  "assistant:measure": {
    gate: "owner",
    call: (c) => c.query(api.assistant.measure, { since: 0 }),
  },
  // The owner's live chat (convex/chat.ts): answered by Claude on the owner's
  // Mac. The owner's alone, like the rest of the Assistant.
  "chat:threads": { gate: "owner", call: (c) => c.query(api.chat.threads, {}) },
  "chat:messages": {
    gate: "owner",
    call: (c, ids) => c.query(api.chat.messages, { threadId: ids.thread }),
  },
  "chat:runner": { gate: "owner", call: (c) => c.query(api.chat.runner, {}) },
  "chat:send": {
    gate: "owner",
    call: (c) => c.mutation(api.chat.send, { company: "us", text: "A question?" }),
  },
  "chat:rename": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.chat.rename, { threadId: ids.thread, title: "A name" }),
  },
  "chat:remove": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.chat.remove, { threadId: ids.thread }),
  },
  "chat:stop": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.chat.stop, { messageId: ids.message }),
  },

  // The team goes with the `team` area: its holder is in effect a second
  // owner, within their own companies (convex/teamManager.test.ts). What they
  // changed is the owner's alone to read.
  "team:list": { gate: TEAM_AREA, call: (c) => c.query(api.team.list, {}) },
  "team:changes": { gate: "owner", call: (c) => c.query(api.team.changes, {}) },
  "team:add": {
    gate: TEAM_AREA,
    call: (c) =>
      c.mutation(api.team.add, {
        email: "new.person@gmail.com",
        role: "sales",
        companies: ["us"],
        areas: ["sales"],
      }),
  },
  "team:update": {
    gate: TEAM_AREA,
    call: (c, ids) =>
      c.mutation(api.team.update, {
        id: ids.member,
        role: "sales",
        companies: ["us"],
        areas: ["sales"],
      }),
  },
  "team:remove": {
    gate: TEAM_AREA,
    call: (c, ids) => c.mutation(api.team.remove, { id: ids.member }),
  },
  "team:resetTelegram": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.team.resetTelegram, { id: ids.member }),
  },
  "team:assignable": { gate: areas("board"), call: (c) => c.query(api.team.assignable, {}) },
  // A person's own GitHub username, for "my pull requests": the caller's and
  // nobody else's. Setting the owner's own is the owner's.
  "team:myGithub": { gate: areas("engineering"), call: (c) => c.query(api.team.myGithub, {}) },
  "team:setMyGithub": {
    gate: "owner",
    call: (c) => c.mutation(api.team.setMyGithub, { github: "made-up-login" }),
  },

  // Roles: read with the Team page, to give someone one that exists. Naming,
  // changing and deleting one are the owner's alone (convex/roles.test.ts).
  "roles:list": { gate: TEAM_AREA, call: (c) => c.query(api.roles.list, {}) },
  "roles:create": {
    gate: "owner",
    call: (c) =>
      c.mutation(api.roles.create, { name: "Another role", focus: "sales", areas: ["sales"] }),
  },
  "roles:update": {
    gate: "owner",
    call: (c, ids) =>
      c.mutation(api.roles.update, {
        id: ids.role,
        name: "Renamed role",
        focus: "general",
        areas: [],
      }),
  },
  "roles:remove": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.roles.remove, { id: ids.role }),
  },

  // The Telegram bot's settings go with the `settings` area (a teammate on
  // one company gets their own company's part: convex/telegramArea.test.ts).
  // The owner's own username is the owner's own record. With no token set (as
  // here) the two that would ask Telegram refuse before starting anything.
  "telegram:settings": { gate: SETTINGS_AREA, call: (c) => c.query(api.telegram.settings, {}) },
  "telegram:save": {
    gate: SETTINGS_AREA,
    // The switch: which group is a company's is the owner's alone to say.
    call: (c) => c.mutation(api.telegram.save, { enabled: false }),
  },
  "telegram:setMine": {
    gate: "owner",
    call: (c) => c.mutation(api.telegram.setMine, { telegram: "owner_handle" }),
  },
  "telegram:resetMine": { gate: "owner", call: (c) => c.mutation(api.telegram.resetMine, {}) },
  "telegram:findChats": { gate: "owner", call: (c) => c.mutation(api.telegram.findChats, {}) },
  "telegram:sendTest": {
    gate: SETTINGS_AREA,
    call: (c) => c.mutation(api.telegram.sendTest, { company: "us" }),
  },
  // Whether people can add tasks from the Telegram group. As above: with no
  // token set, each refuses before asking Telegram anything.
  "telegramInbound:commandsOn": {
    gate: SETTINGS_AREA,
    call: (c) => c.mutation(api.telegramInbound.commandsOn, {}),
  },
  "telegramInbound:commandsOff": {
    gate: SETTINGS_AREA,
    call: (c) => c.mutation(api.telegramInbound.commandsOff, {}),
  },
  "telegramInbound:checkCommands": {
    gate: SETTINGS_AREA,
    call: (c) => c.mutation(api.telegramInbound.checkCommands, {}),
  },

  // Payroll: salaries. For the owner and whoever the owner ticked it for, and
  // each call only for the companies the caller is on (tested further down).
  "payroll:listPeople": {
    gate: PAYROLL_AREA,
    call: (c) => c.query(api.payroll.listPeople, { company: "kz" }),
  },
  "payroll:createPerson": {
    gate: PAYROLL_AREA,
    call: (c) =>
      c.mutation(api.payroll.createPerson, {
        company: "kz",
        name: "Someone New",
        kind: "contractor",
        monthlyGross: 1,
      }),
  },
  "payroll:updatePerson": {
    gate: PAYROLL_AREA,
    call: (c, ids) => c.mutation(api.payroll.updatePerson, { id: ids.payPerson, title: "x" }),
  },
  "payroll:archivePerson": {
    gate: PAYROLL_AREA,
    call: (c, ids) =>
      c.mutation(api.payroll.archivePerson, { id: ids.payPerson, archived: true }),
  },
  "payroll:removePerson": {
    gate: PAYROLL_AREA,
    call: (c, ids) => c.mutation(api.payroll.removePerson, { id: ids.payPerson }),
  },
  "payroll:listLines": {
    gate: PAYROLL_AREA,
    call: (c) => c.query(api.payroll.listLines, { company: "kz" }),
  },
  "payroll:createLine": {
    gate: PAYROLL_AREA,
    call: (c) =>
      c.mutation(api.payroll.createLine, {
        company: "kz",
        appliesTo: "employee",
        name: "A line",
        paidBy: "company",
      }),
  },
  "payroll:updateLine": {
    gate: PAYROLL_AREA,
    call: (c, ids) => c.mutation(api.payroll.updateLine, { id: ids.payLine, rateBp: 1 }),
  },
  "payroll:reorderLines": {
    gate: PAYROLL_AREA,
    call: (c, ids) =>
      c.mutation(api.payroll.reorderLines, {
        company: "kz",
        appliesTo: "employee",
        ids: [ids.payLine],
      }),
  },
  "payroll:removeLine": {
    gate: PAYROLL_AREA,
    call: (c, ids) => c.mutation(api.payroll.removeLine, { id: ids.payLine }),
  },
  "payroll:addUsualLines": {
    gate: PAYROLL_AREA,
    call: (c) => c.mutation(api.payroll.addUsualLines, { company: "kz" }),
  },
  "payroll:getRun": { gate: PAYROLL_AREA, call: (c) => c.query(api.payroll.getRun, KZ_SEP) },
  "payroll:listRuns": {
    gate: PAYROLL_AREA,
    call: (c) => c.query(api.payroll.listRuns, { company: "kz" }),
  },
  "payroll:prepareRun": {
    gate: PAYROLL_AREA,
    call: (c) => c.mutation(api.payroll.prepareRun, KZ_SEP),
  },
  "payroll:setAdjustment": {
    gate: PAYROLL_AREA,
    call: (c, ids) =>
      c.mutation(api.payroll.setAdjustment, { ...KZ_SEP, personId: ids.payPerson, amount: 1 }),
  },
  "payroll:markPaid": {
    gate: PAYROLL_AREA,
    call: (c) => c.mutation(api.payroll.markPaid, { ...KZ_SEP, paidOn: "2026-10-05" }),
  },
  "payroll:reopenRun": {
    gate: PAYROLL_AREA,
    call: (c) => c.mutation(api.payroll.reopenRun, KZ_SEP),
  },
  "payroll:removeRun": {
    gate: PAYROLL_AREA,
    call: (c) => c.mutation(api.payroll.removeRun, KZ_SEP),
  },
  // Costs: what a company pays for besides pay. Sensitive like payroll, and
  // every function one company's (convex/costs.test.ts aims each at the other).
  "costs:list": { gate: COSTS_AREA, call: (c) => c.query(api.costs.list, { company: "kz" }) },
  "costs:summary": {
    gate: COSTS_AREA,
    call: (c) => c.query(api.costs.summary, { company: "kz", month: "2026-09" }),
  },
  "costs:add": {
    gate: COSTS_AREA,
    call: (c) =>
      c.mutation(api.costs.add, {
        company: "kz",
        name: "Made-up line",
        category: "other",
        amount: 1_00,
        cadence: "monthly",
        startsOn: "2026-09",
      }),
  },
  "costs:update": {
    gate: COSTS_AREA,
    call: (c, ids) => c.mutation(api.costs.update, { id: ids.costLine, name: "x" }),
  },
  "costs:archive": {
    gate: COSTS_AREA,
    call: (c, ids) => c.mutation(api.costs.archive, { id: ids.costLine }),
  },
  "costs:restore": {
    gate: COSTS_AREA,
    call: (c, ids) => c.mutation(api.costs.restore, { id: ids.costLine }),
  },
  "costs:remove": {
    gate: COSTS_AREA,
    call: (c, ids) => c.mutation(api.costs.remove, { id: ids.costLine }),
  },
  // Budget and runway: the Finance area's, one company's throughout
  // (convex/budget.test.ts and scenarios.test.ts aim each at the other).
  "budget:view": {
    gate: areas("finance"),
    call: (c) => c.query(api.budget.view, { company: "kz", first: "2026-09", count: 12 }),
  },
  // An empty save: each row also needs its register's page (Payroll, Costs),
  // which convex/budget.test.ts tests; the gate itself is Finance.
  "budget:setCells": {
    gate: areas("finance"),
    call: (c) => c.mutation(api.budget.setCells, { company: "kz", cells: [] }),
  },
  "budget:setActual": {
    gate: areas("finance"),
    call: (c) => c.mutation(api.budget.setActual, { company: "kz", month: "2026-09", amount: 1_00 }),
  },
  "scenarios:list": {
    gate: areas("finance"),
    call: (c) => c.query(api.scenarios.list, { company: "kz" }),
  },
  "scenarios:save": {
    gate: areas("finance"),
    call: (c) => c.mutation(api.scenarios.save, { company: "kz", name: "Made-up", changes: [] }),
  },
  "scenarios:remove": {
    gate: areas("finance"),
    call: (c, ids) => c.mutation(api.scenarios.remove, { id: ids.scenario }),
  },
  // Vertical Startup's agents (convex/agentControl.ts): a product's, on no company,
  // so the gate names none. The change names an agent nobody has heard of, so
  // it is refused in its own words and starts no push here.
  "agentControl:overview": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentControl.overview, { today: "2026-10-16" }),
  },
  "agentControl:providers": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentControl.providers, {}),
  },
  "agentControl:changes": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentControl.changes, {}),
  },
  "agentControl:agent": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentControl.agent, { agentId: "made-up.agent", today: "2026-10-16" }),
  },
  "agentControl:change": {
    gate: areas("agents"),
    call: (c) => c.mutation(api.agentControl.change, { agentId: "made-up.agent", enabled: false }),
  },
  "agentControl:resend": {
    gate: areas("agents"),
    call: (c) => c.mutation(api.agentControl.resend, {}),
  },
  // Launching names a project nobody connected, so it is refused in its own words.
  "agentControl:launch": {
    gate: areas("agents"),
    call: (c) =>
      c.mutation(api.agentControl.launch, {
        project: "made-up-missing",
        agentId: "made-up.agent",
        enabled: true,
        provider: "vertex",
        model: "made-up-pro",
      }),
  },
  // The projects (convex/agentProjects.ts): the agents area's, on no company.
  // Connecting returns a token once; rotating and disconnecting name a
  // project nobody connected. Startup OS's own agents are the owner's.
  "agentProjects:list": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentProjects.list, { today: "2026-10-16" }),
  },
  "agentProjects:launchOptions": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentProjects.launchOptions, { project: "made-up-missing" }),
  },
  "agentProjects:connect": {
    gate: areas("agents"),
    call: (c) =>
      c.mutation(api.agentProjects.connect, {
        name: "Made-up Project",
        slug: "made-up-project",
        region: "US",
        holdsPatientData: false,
        allowedProviders: ["vertex"],
        entropy: "a".repeat(43),
      }),
  },
  "agentProjects:rotateToken": {
    gate: areas("agents"),
    call: (c) => c.mutation(api.agentProjects.rotateToken, { slug: "made-up-missing", entropy: "a".repeat(43) }),
  },
  "agentProjects:disconnect": {
    gate: areas("agents"),
    call: (c) => c.mutation(api.agentProjects.disconnect, { slug: "made-up-missing" }),
  },
  "agentProjects:startupOs": {
    gate: "owner",
    call: (c) => c.query(api.agentProjects.startupOs, { today: "2026-10-16" }),
  },
  // Harnesses (convex/agentHarness.ts): the agents area's, on no company. Each
  // names a project nobody connected or a version, case or run that is not
  // there, so it is refused in its own words. Publishing and rolling back also
  // ask for engineering (the owner's and engineers'), which every role with
  // `agents` starts with; convex/agentHarness.test.ts tests a teammate without it.
  "agentHarness:harness": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentHarness.harness, { project: "made-up-missing", agentId: "made-up.agent" }),
  },
  "agentHarness:tests": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentHarness.tests, { project: "made-up-missing", agentId: "made-up.agent" }),
  },
  "agentHarness:run": {
    gate: areas("agents"),
    call: (c, ids) => c.query(api.agentHarness.run, { id: ids.harnessRun }),
  },
  "agentHarness:version": {
    gate: areas("agents"),
    call: (c, ids) => c.query(api.agentHarness.version, { id: ids.harnessVersion }),
  },
  "agentHarness:newDraft": {
    gate: areas("agents"),
    call: (c) =>
      c.mutation(api.agentHarness.newDraft, { project: "made-up-missing", agentId: "made-up.agent", from: "default" }),
  },
  "agentHarness:saveDraft": {
    gate: areas("agents"),
    call: (c, ids) =>
      c.mutation(api.agentHarness.saveDraft, {
        id: ids.harnessVersion,
        revision: 1,
        prompt: null,
        params: null,
        tools: null,
        outputSchema: null,
        note: "",
      }),
  },
  "agentHarness:discardDraft": {
    gate: areas("agents"),
    call: (c, ids) => c.mutation(api.agentHarness.discardDraft, { id: ids.harnessVersion }),
  },
  "agentHarness:saveCase": {
    gate: areas("agents"),
    call: (c) =>
      c.mutation(api.agentHarness.saveCase, {
        project: "made-up-missing",
        agentId: "made-up.agent",
        name: "Made-up case",
        variables: {},
        expect: [],
        madeUp: true,
      }),
  },
  "agentHarness:removeCase": {
    gate: areas("agents"),
    call: (c, ids) => c.mutation(api.agentHarness.removeCase, { id: ids.harnessCase }),
  },
  "agentHarness:startRun": {
    gate: areas("agents"),
    call: (c, ids) => c.mutation(api.agentHarness.startRun, { draftId: ids.harnessVersion, models: [], caseIds: [] }),
  },
  "agentHarness:publish": {
    gate: areas("agents"),
    call: (c, ids) => c.mutation(api.agentHarness.publish, { id: ids.harnessVersion }),
  },
  "agentHarness:rollback": {
    gate: areas("agents"),
    call: (c, ids) => c.mutation(api.agentHarness.rollback, { id: ids.harnessVersion }),
  },
  // Agents built here (convex/agentBuilder.ts, Protocol v1.3): the agents
  // area's, on no company. Each names a project nobody connected, or a version
  // that is not an agent built here, so it is refused in its own words.
  // Publishing is agentHarness:publish's; an owner-only agent's runs are tested
  // in convex/agentBuilder.test.ts.
  "agentBuilder:create": {
    gate: areas("agents"),
    call: (c) =>
      c.mutation(api.agentBuilder.create, {
        project: "made-up-missing",
        agentId: "made-up.agent",
        name: "Made-up agent",
        description: "Does a made-up thing.",
        mode: "text",
      }),
  },
  "agentBuilder:saveDefinition": {
    gate: areas("agents"),
    call: (c, ids) =>
      c.mutation(api.agentBuilder.saveDefinition, {
        id: ids.harnessVersion,
        revision: 1,
        definition: {
          name: "Made-up agent",
          description: "Does a made-up thing.",
          input: { mode: "text", variables: [] },
          triggers: { api: true },
          approvals: [],
          limits: { maxSteps: 10, timeoutMs: 120_000 },
        },
        prompt: { variants: { default: { system: "", user: "" } } },
        params: null,
        tools: [],
        outputSchema: null,
        note: "",
      }),
  },
  "agentBuilder:builder": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentBuilder.builder, { project: "made-up-missing", agentId: "made-up.agent" }),
  },
  "agentBuilder:runs": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentBuilder.runs, { project: "made-up-missing", agentId: "made-up.agent" }),
  },
  "agentBuilder:tools": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentBuilder.tools, { project: "made-up-missing" }),
  },
  // Agents Startup OS runs itself (convex/agentRuntime.ts): starting one and
  // deciding a waiting call are the owner's, and so is reading the call's
  // arguments; a run's answer is the agents area's, held further to the
  // pages its tools read (convex/agentRuntime.test.ts).
  "agentRuntime:runNow": {
    gate: "owner",
    call: (c) => c.mutation(api.agentRuntime.runNow, { agentId: "made-up.agent", variables: {} }),
  },
  "agentRuntime:approvals": {
    gate: "owner",
    call: (c) => c.query(api.agentRuntime.approvals, { agentId: "made-up.agent" }),
  },
  "agentRuntime:decide": {
    gate: "owner",
    call: (c, ids) => c.mutation(api.agentRuntime.decide, { id: ids.agentApproval, decision: "deny", reason: "Made-up" }),
  },
  "agentRuntime:output": {
    gate: areas("agents"),
    call: (c) => c.query(api.agentRuntime.output, { runId: "os-made-up" }),
  },
};

const UNGATED = ["auth:isAuthenticated", "auth:signIn", "auth:signOut", "viewer:me"];

/** Every public function a deployment would expose, with the gate its builder stamped on it. */
async function exposed() {
  const found = new Map<string, Gate | undefined>();
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes("/_generated/")) continue;
    const file = path.replace(/^\.\//, "").replace(/\.ts$/, "");
    for (const [name, value] of Object.entries((await load()) as Record<string, unknown>)) {
      const fn = value as { isPublic?: boolean; gate?: Gate };
      if (typeof value === "function" && fn.isPublic === true) {
        found.set(`${file}:${name}`, fn.gate);
      }
    }
  }
  return found;
}

/** Which refusal a call met, or "let in" when it met none (whatever else it did). */
async function outcome(call: Promise<unknown>): Promise<"let in" | "not_allowed" | "not_owner"> {
  try {
    await call;
    return "let in";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not_allowed")) return "not_allowed";
    if (message.includes("not_owner")) return "not_owner";
    return "let in";
  }
}

const SIGN_IN = {
  cofounder: signInAsCofounder,
  sales: signInAsSales,
  engineer: signInAsEngineer,
} satisfies Record<MemberRole, unknown>;

/** What the table says a role on both companies gets from a gate. */
function expected(role: MemberRole, gate: Gate) {
  if (gate === "owner") return "not_owner";
  return may({ areas: areasOf(role) }, gate.areas) ? "let in" : "not_allowed";
}

describe("the gate each public function carries", () => {
  test("every public function is in the table, with the gate the table gives it", async () => {
    const found = await exposed();
    for (const name of UNGATED) found.delete(name);
    expect([...found.keys()].sort()).toEqual(Object.keys(SURFACE).sort());
    for (const [name, gate] of found) expect([name, gate]).toEqual([name, SURFACE[name]!.gate]);
  });
});

describe.each(MEMBER_ROLES)("what a %s on both companies may call", (role) => {
  test.each(Object.entries(SURFACE))("%s", async (_name, { gate, call }) => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const client = await SIGN_IN[role](t);
    expect(await outcome(call(client, ids))).toBe(expected(role, gate));
  });
});

describe("the owner and strangers", () => {
  // What only the owner may call is tested where it lives (and some of it
  // starts a sync, which no test here should).
  const shared = Object.entries(SURFACE).filter(([, entry]) => entry.gate !== "owner");
  test.each(shared)("the owner is let in to %s", async (_name, { call }) => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    expect(await outcome(call(await signInAsOwner(t), ids))).toBe("let in");
  });

  test.each(Object.entries(SURFACE))("a signed-out caller is refused %s", async (_n, entry) => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    expect(await outcome(entry.call(t as unknown as Client, ids))).toBe(
      entry.gate === "owner" ? "not_owner" : "not_allowed",
    );
  });
});

// ── One company ─────────────────────────────────────────────────────────────

const start = async (role: MemberRole, companies: ("us" | "kz")[]) => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  return { t, ids, client: await signInAsMember(t, role, companies) };
};
const tileIds = (tiles: { key: string; scope: string }[]) =>
  tiles.map((tile) => `${tile.key}:${tile.scope}`).sort();

describe("scorecard figures", () => {
  test("a co-founder on Startup gets Startup's figures and none of Globex's", async () => {
    const { client } = await start("cofounder", ["us"]);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    const ids = tileIds(tiles);
    expect(ids).toContain("cash_in:us");
    expect(ids).toContain("searches:startup_insights");
    expect(ids).toContain("search_clicks:company");
    expect(ids).not.toContain("paying_clinics:kz");
    expect(ids).not.toContain("clinics_using:kz_product");
    expect(ids).not.toContain("fx_usd_kzt:company");
    expect(ids.some((id) => /:kz/.test(id))).toBe(false);
    expect(Object.keys(sources).sort()).toEqual(["apollo", "mercury", "posthog", "search_console"]);
  });

  test("a co-founder on Globex gets its figures and none of Startup's", async () => {
    const { client } = await start("cofounder", ["kz"]);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    const ids = tileIds(tiles);
    expect(ids).toContain("paying_clinics:kz");
    expect(ids).toContain("fx_usd_kzt:company");
    expect(ids).toContain("clinics_using:kz_product");
    expect(ids).not.toContain("cash_in:us");
    expect(ids).not.toContain("searches:startup_insights");
    expect(ids).not.toContain("search_clicks:company");
    expect(ids).not.toContain("outbound_delivered:us");
    // Globex's own PostHog project feeds its product, so its state is this view's too.
    expect(Object.keys(sources)).toEqual(["cfo_workbook", "posthog_globex"]);
    expect(ids).toContain("checks_completed:kz_product");
  });

  test("sales gets no finance or product figure, on either company", async () => {
    const { client } = await start("sales", ["us", "kz"]);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    const ids = tileIds(tiles);
    expect(ids).toContain("search_clicks:company");
    expect(ids).toContain("outbound_delivered:us");
    for (const hidden of ["cash_in:us", "paying_clinics:kz", "fx_usd_kzt:company", "mrr:us"]) {
      expect(ids).not.toContain(hidden);
    }
    expect(ids).not.toContain("searches:startup_insights");
    // Nor the state of the feeds behind them: the bank's is not theirs to hear.
    expect(Object.keys(sources).sort()).toEqual(["apollo", "search_console"]);
  });

  test("an engineer gets product figures only, and only their company's", async () => {
    const { client } = await start("engineer", ["us"]);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    const ids = tileIds(tiles);
    expect(ids).toContain("searches:startup_insights");
    expect(ids).not.toContain("clinics_using:kz_product");
    expect(ids).not.toContain("cash_in:us");
    expect(ids).not.toContain("search_clicks:company");
    expect(Object.keys(sources)).toEqual(["posthog"]);
  });

  test("the owner still gets every figure and every source", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const { tiles, sources } = await owner.query(api.metrics.scorecard, {});
    expect(tileIds(tiles)).toEqual(
      expect.arrayContaining(["cash_in:us", "paying_clinics:kz", "fx_usd_kzt:company"]),
    );
    expect(Object.keys(sources).sort()).toEqual([
      "apollo",
      "cfo_workbook",
      "gmail",
      "linear",
      "mercury",
      "posthog",
      "posthog_globex",
      "search_console",
    ]);
  });
});

describe("a series", () => {
  const ask = (client: Client, key: string, scope: string) =>
    client.query(api.metrics.series, { key, scope });

  test("the other company's figure answers with an empty list, and never throws", async () => {
    const { client } = await start("cofounder", ["us"]);
    expect(await ask(client, "cash_in", "us")).toHaveLength(1);
    expect(await ask(client, "paying_clinics", "kz")).toEqual([]);
    expect(await ask(client, "fx_usd_kzt", "company")).toEqual([]);
  });

  test("a figure of an area the role lacks answers with an empty list", async () => {
    const { client } = await start("sales", ["us", "kz"]);
    expect(await ask(client, "cash_in", "us")).toEqual([]);
    expect(await ask(client, "searches", "startup_insights")).toEqual([]);
    expect(await ask(client, "outbound_delivered", "us")).toHaveLength(1);
  });

  test("it is the same answer an unknown figure gets", async () => {
    const { client } = await start("engineer", ["kz"]);
    expect(await ask(client, "no_such_metric", "us")).toEqual([]);
    expect(await ask(client, "searches", "startup_insights")).toEqual([]);
    expect(await ask(client, "clinics_using", "kz_product")).toHaveLength(1);
  });
});

describe("targets", () => {
  const keys = async (client: Client) =>
    (await client.query(api.targets.list, {})).map((t) => `${t.key}:${t.scope}`).sort();

  test("only the targets of figures the caller may see", async () => {
    expect(await keys((await start("cofounder", ["us"])).client)).toEqual([
      "cash_in:us",
      "searches:startup_insights",
    ]);
    expect(await keys((await start("cofounder", ["kz"])).client)).toEqual([
      "clinics_using:kz_product",
      "paying_clinics:kz",
    ]);
    // Sales has the scorecard, but neither finance nor product.
    expect(await keys((await start("sales", ["us", "kz"])).client)).toEqual([]);
  });
});

describe("deals", () => {
  test("the other market's board is refused, as a missing permission is", async () => {
    const { client } = await start("sales", ["us"]);
    await expect(client.query(api.deals.board, { market: "kz" })).rejects.toThrow("not_allowed");
    const board = await client.query(api.deals.board, { market: "us" });
    expect(JSON.stringify(board)).toContain("SECRET us DEAL");
    expect(JSON.stringify(board)).not.toContain("SECRET kz DEAL");
  });

  test("a deal of the other market can be neither moved, edited nor deleted", async () => {
    const { t, ids, client } = await start("sales", ["us"]);
    await expect(
      client.mutation(api.deals.move, { id: ids.kzDeal, stage: "qualified", index: 0 }),
    ).rejects.toThrow("not_allowed");
    await expect(
      client.mutation(api.deals.update, { id: ids.kzDeal, notes: "theirs" }),
    ).rejects.toThrow("not_allowed");
    await expect(client.mutation(api.deals.remove, { id: ids.kzDeal })).rejects.toThrow(
      "not_allowed",
    );
    const deal = await t.run((ctx) => ctx.db.get(ids.kzDeal));
    expect(deal).toMatchObject({ stage: "lead", name: "SECRET kz DEAL" });
    expect(deal?.notes).toBeUndefined();
  });

  test("a deal cannot be created on the other market", async () => {
    const { t, client } = await start("sales", ["kz"]);
    await expect(
      client.mutation(api.deals.create, { market: "us", name: "Sneaked in" }),
    ).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.query("deals").collect())).toHaveLength(2);
  });

  test("a deal of the other market can be neither archived, restored nor given details", async () => {
    const { t, ids, client } = await start("sales", ["us"]);
    await expect(client.mutation(api.deals.archive, { id: ids.kzDeal })).rejects.toThrow(
      "not_allowed",
    );
    await expect(client.mutation(api.deals.restore, { id: ids.kzDeal })).rejects.toThrow(
      "not_allowed",
    );
    await expect(
      client.mutation(api.deals.update, { id: ids.kzDeal, priority: "high" }),
    ).rejects.toThrow("not_allowed");
    const deal = await t.run((ctx) => ctx.db.get(ids.kzDeal));
    expect(deal).not.toHaveProperty("archivedAt");
    expect(deal).not.toHaveProperty("priority");
  });

  test("someone on Globex alone gets nothing new: no US archive, and their board as it was", async () => {
    const { t, ids, client } = await start("sales", ["kz"]);
    // A US deal with every detail, archived: none of it may reach them.
    await t.run((ctx) =>
      ctx.db.patch(ids.usDeal, { priority: "high", region: "TX", sources: ["SECRET us SOURCE"] }),
    );
    await expect(client.query(api.deals.archived, { market: "us" })).rejects.toThrow(
      "not_allowed",
    );
    await expect(client.mutation(api.deals.archive, { id: ids.usDeal })).rejects.toThrow(
      "not_allowed",
    );
    expect(await client.query(api.deals.archived, { market: "kz" })).toEqual([]);
    const board = await client.query(api.deals.board, { market: "kz" });
    expect(JSON.stringify(board)).not.toMatch(/SECRET us|priority|region|physicians|sources/);
  });

  test("someone on Globex alone is refused the US deals' intelligence, and their board is as it was", async () => {
    const { t, ids, client } = await start("sales", ["kz"]);
    await t.run((ctx) =>
      ctx.db.insert("dealIntel", { dealId: ids.usDeal, summary: "SECRET us INTEL", updatedAt: 1 }),
    );
    await expect(client.query(api.dealIntel.get, { dealId: ids.usDeal })).rejects.toThrow("not_allowed");
    await expect(client.query(api.dealIntel.get, { dealId: ids.kzDeal })).rejects.toThrow("not_allowed");
    await expect(client.query(api.dealIntel.list, {})).rejects.toThrow("not_allowed");
    await expect(
      client.mutation(api.dealIntel.update, { dealId: ids.kzDeal, summary: "theirs" }),
    ).rejects.toThrow("not_allowed");
    const board = await client.query(api.deals.board, { market: "kz" });
    expect(JSON.stringify(board)).not.toMatch(/SECRET us|intel|summary/i);
    const rows = await t.run((ctx) => ctx.db.query("dealIntel").collect());
    expect(rows.map((row) => row.dealId)).toEqual([ids.usDeal]);
  });

  test("someone on Startup alone reads the US deals' intelligence and never a Kazakhstan row", async () => {
    const { t, ids, client } = await start("sales", ["us"]);
    await t.run(async (ctx) => {
      await ctx.db.insert("dealIntel", { dealId: ids.usDeal, ehr: "Made-up EHR", updatedAt: 1 });
      // A row that should never exist: a Kazakhstan deal's.
      await ctx.db.insert("dealIntel", { dealId: ids.kzDeal, ehr: "SECRET kz INTEL", updatedAt: 1 });
    });
    expect((await client.query(api.dealIntel.list, {})).map((row) => row.ehr)).toEqual(["Made-up EHR"]);
    expect(await client.query(api.dealIntel.get, { dealId: ids.kzDeal })).toBeNull();
  });

  test("createdSince counts nothing for a market the caller is not on", async () => {
    const { client } = await start("sales", ["us"]);
    expect(await client.query(api.deals.createdSince, { since: 0 })).toEqual({
      us: { native: 1, mirrored: 0 },
      kz: { native: 0, mirrored: 0 },
    });
  });
});

describe("customers", () => {
  test("only the clinics of the caller's companies are sent", async () => {
    const us = await (await start("sales", ["us"])).client.query(api.customers.list, {});
    expect(us.customers.map((c) => c.market)).toEqual(["us"]);
    expect(JSON.stringify(us)).not.toContain("SECRET kz CLINIC");
    const kz = await (await start("sales", ["kz"])).client.query(api.customers.list, {});
    expect(kz.customers.map((c) => c.market)).toEqual(["kz"]);
    expect(JSON.stringify(kz)).not.toContain("SECRET us CLINIC");
  });

  test("the other company's clinic cannot be written to", async () => {
    const { t, ids, client } = await start("cofounder", ["us"]);
    await expect(
      client.mutation(api.customers.setOwnerFields, { id: ids.kzClinic, note: "theirs" }),
    ).rejects.toThrow("not_allowed");
    expect((await t.run((ctx) => ctx.db.get(ids.kzClinic)))?.note).toBeUndefined();
    await client.mutation(api.customers.setOwnerFields, { id: ids.usClinic, note: "ours" });
    expect((await t.run((ctx) => ctx.db.get(ids.usClinic)))?.note).toBe("ours");
  });
});

describe("obligations", () => {
  const categories = async (client: Client) =>
    (await client.query(api.obligations.list, {})).map((o) => o.category).sort();

  test("the list holds the shared categories and the caller's companies' own", async () => {
    expect(await categories((await start("cofounder", ["us"])).client)).toEqual([
      "corporate_tax",
      "hipaa",
    ]);
    expect(await categories((await start("cofounder", ["kz"])).client)).toEqual([
      "corporate_tax",
      "kz_data",
    ]);
  });

  test("an item cannot be created in a category the caller's companies do not have", async () => {
    const { t, client } = await start("cofounder", ["kz"]);
    await expect(
      client.mutation(api.obligations.create, { category: "hipaa", title: "Sneaked in" }),
    ).rejects.toThrow("not_allowed");
    await expect(
      client.mutation(api.obligations.create, { category: "soc2", title: "Sneaked in" }),
    ).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.query("obligations").collect())).toHaveLength(3);
    await client.mutation(api.obligations.create, { category: "kz_data", title: "Ours" });
  });

  test("the other company's item can be neither edited, finished nor deleted", async () => {
    const { t, ids, client } = await start("cofounder", ["kz"]);
    await expect(
      client.mutation(api.obligations.update, { id: ids.hipaa, title: "Theirs" }),
    ).rejects.toThrow("not_allowed");
    await expect(
      client.mutation(api.obligations.complete, {
        id: ids.hipaa,
        today: "2026-10-12",
        expectedDue: null,
      }),
    ).rejects.toThrow("not_allowed");
    await expect(client.mutation(api.obligations.remove, { id: ids.hipaa })).rejects.toThrow(
      "not_allowed",
    );
    expect(await t.run((ctx) => ctx.db.get(ids.hipaa))).toMatchObject({
      title: "Item hipaa",
      status: "open",
    });
  });

  test("an item cannot be moved into a category the caller's companies do not have", async () => {
    const { t, ids, client } = await start("cofounder", ["kz"]);
    await expect(
      client.mutation(api.obligations.update, { id: ids.corporate, category: "hipaa" }),
    ).rejects.toThrow("not_allowed");
    expect((await t.run((ctx) => ctx.db.get(ids.corporate)))?.category).toBe("corporate_tax");
  });

  test("the starter checklist adds only the caller's companies' items", async () => {
    const { t, client } = await start("cofounder", ["kz"]);
    const { added } = await client.mutation(api.starterChecklist.add, { today: "2026-10-12" });
    const seeded = (await t.run((ctx) => ctx.db.query("obligations").collect())).filter(
      (o) => o.seedKey !== undefined,
    );
    expect(added).toBe(seeded.length);
    expect(added).toBeGreaterThan(0);
    expect(seeded.some((o) => o.category === "hipaa" || o.category === "soc2")).toBe(false);
    // The owner pressing the button afterwards adds the rest, and nothing twice.
    const owner = await signInAsOwner(t);
    const rest = await owner.mutation(api.starterChecklist.add, { today: "2026-10-12" });
    expect(rest.added).toBeGreaterThan(0);
    expect((await owner.mutation(api.starterChecklist.add, { today: "2026-10-12" })).added).toBe(0);
  });
});

describe("fundraising", () => {
  test("a co-founder who is not on Startup is refused all of it", async () => {
    const { t, ids, client } = await start("cofounder", ["kz"]);
    const calls = [
      client.query(api.investors.board, {}),
      client.mutation(api.investors.create, { name: "Sneaked in" }),
      client.mutation(api.investors.update, { id: ids.investor, notes: "theirs" }),
      client.mutation(api.investors.move, { id: ids.investor, stage: "contacted", index: 0 }),
      client.mutation(api.investors.remove, { id: ids.investor }),
    ];
    for (const call of calls) await expect(call).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.query("investors").collect())).toHaveLength(1);
  });

  test("a co-founder on Startup reads the board", async () => {
    const { client } = await start("cofounder", ["us"]);
    expect(JSON.stringify(await client.query(api.investors.board, {}))).toContain("SECRET FUND");
  });
});

describe("partnerships", () => {
  test("a co-founder on Globex alone reads and writes Globex's partners and none of Startup's", async () => {
    const { t, ids, client } = await start("cofounder", ["kz"]);
    expect(JSON.stringify(await client.query(api.partnerships.board, { company: "kz" }))).toContain(
      "SECRET KZ PARTNER",
    );
    const calls = [
      client.query(api.partnerships.board, { company: "us" }),
      client.mutation(api.partnerships.create, { company: "us", name: "Sneaked in", type: "referral" }),
      client.mutation(api.partnerships.update, { id: ids.usPartner, notes: "theirs" }),
      client.mutation(api.partnerships.move, { id: ids.usPartner, stage: "live", index: 0 }),
      client.mutation(api.partnerships.remove, { id: ids.usPartner }),
    ];
    for (const call of calls) await expect(call).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.query("partners").collect())).toHaveLength(2);
  });

  test("an engineer, whose starting set has no partnerships, is refused all of it", async () => {
    const { client } = await start("engineer", ["us", "kz"]);
    await expect(client.query(api.partnerships.board, { company: "us" })).rejects.toThrow("not_allowed");
  });
});

describe("contacts", () => {
  test("a co-founder on Globex alone, ticked Contacts, reads and writes Globex's contacts and none of Startup's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const client = await signInWithAreas(t, "cofounder", ["contacts"], ["kz"]);
    expect(JSON.stringify(await client.query(api.contacts.list, { company: "kz" }))).toContain(
      "SECRET KZ CONTACT",
    );
    const calls = [
      client.query(api.contacts.list, { company: "us" }),
      client.query(api.contacts.get, { id: ids.usContact }),
      client.mutation(api.contacts.upsert, { company: "us", name: "Sneaked in" }),
      client.mutation(api.contacts.upsert, { id: ids.usContact, notes: "theirs" }),
      client.mutation(api.contacts.addNote, { id: ids.usContact, text: "theirs" }),
      client.mutation(api.contacts.link, {
        contactId: ids.usContact,
        type: "investor",
        id: ids.investor,
        linked: true,
      }),
      client.mutation(api.contacts.merge, { keepId: ids.kzContact, mergeId: ids.usContact }),
    ];
    for (const call of calls) await expect(call).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(2);
  });

  test("no role starts with it: an engineer, and a co-founder with no list of their own, are refused", async () => {
    for (const role of ["engineer", "cofounder", "sales"] as const) {
      const { client } = await start(role, ["us", "kz"]);
      await expect(client.query(api.contacts.list, {})).rejects.toThrow("not_allowed");
    }
  });
});

describe("support", () => {
  test("ticked for someone on Startup alone, it opens nothing: the inbox is Globex's", async () => {
    const t = convexTest(schema, modules);
    const us = await signInWithAreas(t, "sales", ["support"], ["us"]);
    await expect(us.query(api.support.overview, {})).rejects.toThrow("not_allowed");
    const kz = await signInWithAreas(t, "engineer", ["support"], ["kz"]);
    expect((await kz.query(api.support.overview, {})).rows).toEqual([]);
  });

  test("no role starts with it: a co-founder on Globex with no list of their own is refused", async () => {
    const { client } = await start("cofounder", ["kz"]);
    await expect(client.query(api.support.overview, {})).rejects.toThrow("not_allowed");
  });
});

describe("the plan", () => {
  test("someone with finance who is not on Startup is refused it", async () => {
    // A co-founder starts with finance, and on Globex still reads its figures.
    const { client } = await start("cofounder", ["kz"]);
    await expect(client.query(api.plan.get, {})).rejects.toThrow("not_allowed");
    const figures = tileIds((await client.query(api.metrics.scorecard, {})).tiles);
    expect(figures).toContain("paying_clinics:kz");
  });

  test("a co-founder on Startup reads it", async () => {
    const { client } = await start("cofounder", ["us"]);
    expect(await client.query(api.plan.get, {})).toEqual({
      modelVersion: "a1b2c3d",
      syncedAt: 1,
      rows: [{ scenario: "base", year: 2027, key: "arr", value: 7 }],
    });
  });

  test("being on Startup without finance does not open it", async () => {
    const { client } = await start("sales", ["us"]);
    await expect(client.query(api.plan.get, {})).rejects.toThrow("not_allowed");
  });
});

describe("engineering: GitHub's repositories", () => {
  // Made-up repositories, one per company, each named after its company.
  const seedRepos = (t: TestBackend) =>
    t.run(async (ctx) => {
      for (const [name, company] of [
        ["secret-uniform-repo", "us"],
        ["secret-kilo-repo", "kz"],
      ] as const) {
        await ctx.db.insert("mirrorRecords", {
          source: "github",
          externalId: `repo:made-up-org/${name}`,
          sortAt: 1,
          syncedAt: 2,
          record: {
            kind: "repo",
            repoId: `Made-Up-Org/${name}`,
            org: "Made-Up-Org",
            name,
            company,
            mergedLastWeek: 1,
            open: 2,
            stuck: 1,
            main: "failing",
            pushedAt: "2026-10-13",
          },
        });
      }
    });
  const read = async (client: Client) => {
    const result = await client.query(api.workTools.engineering, {});
    return { names: result.rows.map((row) => row.name), text: JSON.stringify(result) };
  };

  test("an engineer on Globex is never sent a Startup repository", async () => {
    const { t, client } = await start("engineer", ["kz"]);
    await seedRepos(t);
    const { names, text } = await read(client);
    expect(names).toEqual(["secret-kilo-repo"]);
    expect(text).not.toContain("uniform");
  });

  test("an engineer on Startup is never sent a Globex repository", async () => {
    const { t, client } = await start("engineer", ["us"]);
    await seedRepos(t);
    const { names, text } = await read(client);
    expect(names).toEqual(["secret-uniform-repo"]);
    expect(text).not.toContain("kilo");
  });

  test("the owner, and a teammate on both, get both", async () => {
    const { t, client } = await start("engineer", ["us", "kz"]);
    await seedRepos(t);
    expect((await read(client)).names.sort()).toEqual(["secret-kilo-repo", "secret-uniform-repo"]);
    expect((await read(await signInAsOwner(t))).names).toHaveLength(2);
  });

  test("being on a company without the engineering area does not open it", async () => {
    const { t, client } = await start("sales", ["us", "kz"]);
    await seedRepos(t);
    await expect(client.query(api.workTools.engineering, {})).rejects.toThrow("not_allowed");
    await expect(client.query(api.workTools.pullRequests, {})).rejects.toThrow("not_allowed");
  });

  test("the product area alone does not open it either", async () => {
    const { t, client } = await startPicked("engineer", ["product", "board"]);
    await seedRepos(t);
    await expect(client.query(api.workTools.engineering, {})).rejects.toThrow("not_allowed");
    await expect(client.query(api.workTools.pullRequests, {})).rejects.toThrow("not_allowed");
  });

  // Made-up pull requests, one per company: title, author and reviewer named after it.
  const seedPulls = (t: TestBackend) =>
    t.run(async (ctx) => {
      for (const [name, company] of [
        ["secret-uniform-repo", "us"],
        ["secret-kilo-repo", "kz"],
      ] as const) {
        await ctx.db.insert("mirrorRecords", {
          source: "github",
          externalId: `pr:made-up-org/${name}#1`,
          sortAt: 5,
          syncedAt: 6,
          record: {
            kind: "pull_request",
            repoId: `Made-Up-Org/${name}`,
            number: 1,
            company,
            title: `SECRET ${company} title`,
            url: `https://github.com/Made-Up-Org/${name}/pull/1`,
            authorLogin: `secret-${company}-author`,
            authorName: `SECRET ${company} author`,
            draft: false,
            state: "open",
            createdAt: 4,
            updatedAt: 5,
            reviewDecision: "none",
            reviewersRequested: 1,
            reviewers: [`secret-${company}-reviewer`],
            checks: "none",
          },
        });
      }
    });

  test("an engineer on Globex is never sent a Startup pull request, its title or its people", async () => {
    const { t, client } = await start("engineer", ["kz"]);
    await seedPulls(t);
    const result = await client.query(api.workTools.pullRequests, {});
    expect(result.rows.map((row) => row.title)).toEqual(["SECRET kz title"]);
    expect(JSON.stringify(result)).not.toMatch(/startup|SECRET us|secret-us/i);
  });

  test("an engineer on Startup is never sent a Globex pull request", async () => {
    const { t, client } = await start("engineer", ["us"]);
    await seedPulls(t);
    const result = await client.query(api.workTools.pullRequests, {});
    expect(result.rows.map((row) => row.title)).toEqual(["SECRET us title"]);
    expect(JSON.stringify(result)).not.toMatch(/globex|SECRET kz|secret-kz/i);
  });

  test("no other function a teammate can call returns a pull request's title or people", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await seedPulls(t);
    const cofounder = await signInAsCofounder(t);
    for (const [name, entry] of Object.entries(SURFACE)) {
      if (name === "workTools:pullRequests") continue;
      let text = "";
      try {
        text = JSON.stringify(await entry.call(cofounder, ids)) ?? "";
      } catch (error) {
        text = String(error);
      }
      expect(text, name).not.toMatch(/SECRET (us|kz) (title|author)|secret-(us|kz)-/);
    }
  });

  test("the repository counts on the scorecard follow the company too", async () => {
    const { t, client } = await start("engineer", ["kz"]);
    await t.run(async (ctx) => {
      for (const scope of ["us", "kz"]) {
        await ctx.db.insert("metricSnapshots", {
          key: "prs_stuck",
          scope,
          period: "week",
          periodStart: "2026-09-28",
          value: 3,
          source: "github",
          syncedAt: 1,
        });
      }
      await ctx.db.insert("sourceStatus", { source: "github", state: "ok", lastRunAt: 1, lastOkAt: 1 });
    });
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    const ids = tileIds(tiles);
    expect(ids).toContain("prs_stuck:kz");
    expect(ids).not.toContain("prs_stuck:us");
    // GitHub feeds both companies, so its state is this view's to hear.
    expect(Object.keys(sources)).toContain("github");
  });
});

describe("engineering: GitHub's figures on the scorecard", () => {
  const GITHUB_KEYS = ["prs_merged", "prs_open", "prs_opened", "prs_stuck", "repos_failing", "repos_tracked"];
  const withFigures = async (areas: readonly GrantableArea[], companies: ("us" | "kz")[] = ["us", "kz"]) => {
    const started = await startPicked("sales", areas, companies);
    await started.t.run(async (ctx) => {
      for (const key of GITHUB_KEYS) {
        for (const scope of ["us", "kz"]) {
          await ctx.db.insert("metricSnapshots", {
            key,
            scope,
            period: "week",
            periodStart: "2026-09-28",
            value: 3,
            source: "github",
            syncedAt: 1,
          });
        }
      }
      await ctx.db.insert("metricTargets", { key: "prs_merged", scope: "us", target: 5 });
      await ctx.db.insert("sourceStatus", { source: "github", state: "ok", lastRunAt: 1, lastOkAt: 1 });
    });
    return started.client;
  };
  const githubIds = GITHUB_KEYS.flatMap((key) => [`${key}:kz`, `${key}:us`]).sort();

  test("someone with only the engineering area gets GitHub's figures and nothing else of Product", async () => {
    const client = await withFigures(["engineering"]);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    // Exactly GitHub's twelve: no usage figure, no finance figure, no other feed's state.
    expect(tileIds(tiles)).toEqual(githubIds);
    expect(Object.keys(sources)).toEqual(["github"]);
  });

  test("and only their company's", async () => {
    const client = await withFigures(["engineering"], ["kz"]);
    const { tiles } = await client.query(api.metrics.scorecard, {});
    expect(tileIds(tiles)).toEqual(GITHUB_KEYS.map((key) => `${key}:kz`).sort());
  });

  test("the product area still gets them, beside the product's own (the dashboard's line)", async () => {
    const client = await withFigures(["product"]);
    const ids = tileIds((await client.query(api.metrics.scorecard, {})).tiles);
    expect(ids).toEqual(expect.arrayContaining([...githubIds, "searches:startup_insights"]));
  });

  test("neither area: none of them, and nothing of GitHub's state", async () => {
    const client = await withFigures(["scorecard", "sales", "gtm", "board"]);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    expect(tileIds(tiles).filter((id) => /^(prs|repos)_/.test(id))).toEqual([]);
    expect(Object.keys(sources)).not.toContain("github");
  });

  test("a series and the targets agree with the scorecard", async () => {
    const only = await withFigures(["engineering"]);
    expect(await only.query(api.metrics.series, { key: "prs_merged", scope: "us" })).toHaveLength(1);
    // A product figure answers as an unknown one does.
    expect(await only.query(api.metrics.series, { key: "searches", scope: "startup_insights" })).toEqual([]);
    // Targets are the scorecard area's: with it, only those of GitHub's figures.
    await expect(only.query(api.targets.list, {})).rejects.toThrow("not_allowed");
    const withScorecard = await withFigures(["scorecard", "engineering"]);
    expect(
      (await withScorecard.query(api.targets.list, {})).map((t) => `${t.key}:${t.scope}`),
    ).toEqual(["prs_merged:us"]);
    const neither = await withFigures(["scorecard", "board"]);
    expect(await neither.query(api.metrics.series, { key: "prs_merged", scope: "us" })).toEqual([]);
  });
});

describe("tasks", () => {
  const titles = async (client: Client) =>
    Object.values(await client.query(api.tasks.board, {}))
      .flat()
      .map((task) => task.title)
      .sort();

  test("the board holds shared tasks and those of the caller's companies", async () => {
    expect(await titles((await start("engineer", ["us"])).client)).toEqual([
      "SECRET us task",
      "Shared task",
    ]);
    expect(await titles((await start("engineer", ["kz"])).client)).toEqual([
      "SECRET kz task",
      "Shared task",
    ]);
    expect(await titles((await start("engineer", ["us", "kz"])).client)).toHaveLength(3);
  });

  test("open issues are filtered the same way", async () => {
    const { client } = await start("sales", ["us"]);
    const issues = await client.query(api.tasks.openIssues, {});
    expect(issues.map((issue) => issue.title).sort()).toEqual(["SECRET us task", "Shared task"]);
  });

  test("a task of the other company can be neither moved, edited nor deleted", async () => {
    const { t, ids, client } = await start("engineer", ["us"]);
    const id = ids.kzTask as Id<"tasks">;
    await expect(
      client.mutation(api.tasks.move, { id, column: "doing", index: 0 }),
    ).rejects.toThrow("not_allowed");
    await expect(client.mutation(api.tasks.update, { id, title: "Theirs" })).rejects.toThrow(
      "not_allowed",
    );
    await expect(client.mutation(api.tasks.remove, { id })).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      title: "SECRET kz task",
      column: "backlog",
    });
  });

  test("a task cannot be created on, or moved to, a company the caller is not on", async () => {
    const { t, ids, client } = await start("engineer", ["us"]);
    await expect(
      client.mutation(api.tasks.create, { title: "Sneaked in", company: "kz" }),
    ).rejects.toThrow("not_allowed");
    await expect(
      client.mutation(api.tasks.update, { id: ids.sharedTask, company: "kz" }),
    ).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(3);
    expect((await t.run((ctx) => ctx.db.get(ids.sharedTask)))?.company).toBeUndefined();
  });
});

// ── Pages the owner picked ──────────────────────────────────────────────────
// A teammate's own list decides, not their role: each list below differs
// from its role's starting set in both directions.

/** An engineer given the money pages and the pipelines, with product and the board taken away. */
const ENGINEER_PICKED: GrantableArea[] = [
  "scorecard",
  "finance",
  "sales",
  "customers",
  "compliance",
  "fundraising",
  "review",
];
/** A co-founder left with marketing, go to market and the board. */
const COFOUNDER_PICKED: GrantableArea[] = ["marketing", "gtm", "board"];

/** Every page the owner can give but Sources and Telegram, and Team. */
const EVERY_ORDINARY: GrantableArea[] = GRANTABLE_AREAS.filter((area) => !isSensitiveArea(area));

const PICKED: [string, MemberRole, StoredArea[]][] = [
  // Today is in no role's starting set: it opens only for someone the owner ticked it for.
  ["an engineer given Today and nothing else", "engineer", ["today"]],
  ["an engineer given more than the role, and less", "engineer", ENGINEER_PICKED],
  ["a co-founder given less than the role", "cofounder", COFOUNDER_PICKED],
  ["a co-founder given no page at all", "cofounder", []],
  // The two sensitive areas, each alone: its own functions and nothing else.
  ["an engineer given Sources and Telegram and nothing else", "engineer", ["settings"]],
  ["an engineer given Team and nothing else", "engineer", ["team"]],
  // And the other way: every ordinary page opens none of the two.
  ["a co-founder given every page but the sensitive two", "cofounder", EVERY_ORDINARY],
  // Payroll and costs are the owner's alone: a row from before that still
  // says one opens nothing with it, not even what any page opens.
  ["an engineer whose row still says Payroll and nothing else", "engineer", ["payroll"]],
  ["an engineer whose row still says Costs and nothing else", "engineer", ["costs"]],
  ["a co-founder whose row still says every area there was", "cofounder", [...GRANTABLE_AREAS, ...PAY_AND_COSTS]],
];

describe("the sensitive areas in the table", () => {
  test("each gates at least one function", () => {
    for (const area of SENSITIVE_AREAS) {
      const gatedBy = Object.values(SURFACE).filter(
        // (A function open to anyone with a page names every area: not one of these.)
        ({ gate }) => gate !== "owner" && gate.areas !== ANY_AREA && gate.areas.includes(area),
      );
      expect([area, gatedBy.length > 0]).toEqual([area, true]);
    }
  });

  test("only the area itself opens what it gates: no ordinary page is another way in", () => {
    // The one function shared with an ordinary page is the list of targets,
    // which the scorecard reads too; what each caller is sent is decided
    // inside it (convex/settingsArea.test.ts).
    const SHARED = ["targets:list"];
    for (const [name, { gate }] of Object.entries(SURFACE)) {
      if (gate === "owner" || gate.areas === ANY_AREA || SHARED.includes(name)) continue;
      const sensitive = gate.areas.filter(isSensitiveArea);
      if (sensitive.length > 0) expect([name, gate.areas]).toEqual([name, [sensitive[0]]]);
    }
    expect(SURFACE["targets:list"]!.gate).toEqual({ areas: ["scorecard", "settings"] });
  });

  test("payroll and costs gate only their own files' functions, and only the owner holds them", () => {
    for (const [name, { gate }] of Object.entries(SURFACE)) {
      if (gate === "owner" || gate.areas === ANY_AREA) continue;
      const pay = gate.areas.filter((area) => (PAY_AND_COSTS as readonly Area[]).includes(area));
      if (pay.length === 0) continue;
      expect([name, gate.areas]).toEqual([name, [pay[0]]]);
      expect(name.startsWith(`${pay[0]}:`)).toBe(true);
    }
    for (const area of PAY_AND_COSTS) {
      expect(GRANTABLE_AREAS).not.toContain(area);
      for (const role of MEMBER_ROLES) expect(effectiveAreas(role, [area])).toEqual([]);
    }
  });

  test("no role's starting set opens a function a sensitive area gates", () => {
    for (const role of MEMBER_ROLES) {
      for (const { gate } of Object.values(SURFACE)) {
        // What a sensitive area alone gates (the list of targets is read with the scorecard too).
        if (gate === "owner" || !gate.areas.every(isSensitiveArea)) continue;
        expect(may({ areas: areasOf(role) }, gate.areas)).toBe(false);
      }
    }
  });
});

const startPicked = async (
  role: MemberRole,
  areas: readonly StoredArea[],
  companies: ("us" | "kz")[] = ["us", "kz"],
) => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  return { t, ids, client: await signInWithAreas(t, role, areas, companies) };
};

describe.each(PICKED)("what %s may call", (_who, role, picked) => {
  test.each(Object.entries(SURFACE))("%s", async (_name, { gate, call }) => {
    const { ids, client } = await startPicked(role, picked);
    const held = effectiveAreas(role, picked);
    const want =
      gate === "owner" ? "not_owner" : may({ areas: held }, gate.areas) ? "let in" : "not_allowed";
    expect(await outcome(call(client, ids))).toBe(want);
  });
});

describe("pages the owner picked: what is sent", () => {
  test("an engineer given finance gets finance figures and their feeds, and no product ones", async () => {
    const { client } = await startPicked("engineer", ENGINEER_PICKED);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    const ids = tileIds(tiles);
    expect(ids).toEqual(expect.arrayContaining(["cash_in:us", "paying_clinics:kz"]));
    expect(ids).not.toContain("searches:startup_insights");
    expect(ids).not.toContain("clinics_using:kz_product");
    expect(ids).not.toContain("search_clicks:company");
    // Globex's AI token cost is a finance figure (COGS in unit economics),
    // read from the app's PostHog: so PostHog is one of finance's feeds, and
    // still no product figure is sent with it.
    expect(ids).toEqual(expect.arrayContaining(["ai_token_cost:kz_product", "ai_token_clinics:kz_product"]));
    expect(ids).not.toContain("checks_completed:kz_product");
    expect(Object.keys(sources).sort()).toEqual(["cfo_workbook", "mercury", "posthog_globex"]);
  });

  test("a co-founder with finance unticked gets no finance figure and hears nothing of the bank feed", async () => {
    const { client } = await startPicked("cofounder", COFOUNDER_PICKED);
    const { tiles, sources } = await client.query(api.metrics.scorecard, {});
    const ids = tileIds(tiles);
    expect(ids).toEqual(expect.arrayContaining(["search_clicks:company", "outbound_delivered:us"]));
    for (const hidden of ["cash_in:us", "paying_clinics:kz", "fx_usd_kzt:company", "mrr:us"]) {
      expect(ids).not.toContain(hidden);
    }
    expect(ids).not.toContain("searches:startup_insights");
    expect(Object.keys(sources).sort()).toEqual(["apollo", "search_console"]);
  });

  test("a series follows the list too, answering as for an unknown figure", async () => {
    const ask = (client: Client, key: string, scope: string) =>
      client.query(api.metrics.series, { key, scope });
    const engineer = (await startPicked("engineer", ENGINEER_PICKED)).client;
    expect(await ask(engineer, "cash_in", "us")).toHaveLength(1);
    expect(await ask(engineer, "searches", "startup_insights")).toEqual([]);
    const cofounder = (await startPicked("cofounder", COFOUNDER_PICKED)).client;
    expect(await ask(cofounder, "cash_in", "us")).toEqual([]);
    expect(await ask(cofounder, "outbound_delivered", "us")).toHaveLength(1);
  });

  test("targets are those of the figures the list opens", async () => {
    const keys = async (client: Client) =>
      (await client.query(api.targets.list, {})).map((t) => `${t.key}:${t.scope}`).sort();
    expect(await keys((await startPicked("engineer", ENGINEER_PICKED)).client)).toEqual([
      "cash_in:us",
      "paying_clinics:kz",
    ]);
    // The scorecard and product, without finance.
    expect(await keys((await startPicked("cofounder", ["scorecard", "product"])).client)).toEqual([
      "clinics_using:kz_product",
      "searches:startup_insights",
    ]);
  });

  test("a picked page is still only the caller's companies'", async () => {
    // Fundraising is Startup's: ticking it for someone on Globex opens nothing.
    const kz = await startPicked("engineer", ENGINEER_PICKED, ["kz"]);
    await expect(kz.client.query(api.investors.board, {})).rejects.toThrow("not_allowed");
    // So is the plan: finance ticked on Globex opens its figures, not Startup's plan.
    await expect(kz.client.query(api.plan.get, {})).rejects.toThrow("not_allowed");
    await expect(kz.client.query(api.deals.board, { market: "us" })).rejects.toThrow("not_allowed");
    expect(JSON.stringify(await kz.client.query(api.deals.board, { market: "kz" }))).toContain(
      "SECRET kz DEAL",
    );
    const figures = tileIds((await kz.client.query(api.metrics.scorecard, {})).tiles);
    expect(figures).toContain("paying_clinics:kz");
    expect(figures).not.toContain("cash_in:us");
    // On Startup it does open.
    const us = await startPicked("engineer", ENGINEER_PICKED, ["us"]);
    expect(JSON.stringify(await us.client.query(api.investors.board, {}))).toContain("SECRET FUND");
    expect((await us.client.query(api.plan.get, {}))?.rows).toHaveLength(1);
  });

  test("goals are read with the board and edited only with review, by the list", async () => {
    const { ids, client } = await startPicked("cofounder", COFOUNDER_PICKED);
    await expect(client.query(api.goals.list, { quarter: "2026-Q4" })).resolves.toHaveLength(1);
    await expect(
      client.mutation(api.goals.update, { id: ids.goal, title: "Theirs" }),
    ).rejects.toThrow("not_allowed");
  });

  test("a removed teammate's address is the owner's alone to see, whatever pages are picked", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        title: "Left behind",
        kind: "task",
        column: "backlog",
        order: 9,
        assignee: "gone@gmail.com",
      });
    });
    const everyPage = await signInWithAreas(t, "cofounder", GRANTABLE_AREAS);
    const held = (await everyPage.query(api.tasks.board, {})).backlog.find(
      (task) => task.title === "Left behind",
    );
    expect(held?.assignee).toEqual({ status: "removed", email: null, name: null });
    const owner = await signInAsOwner(t);
    const seen = (await owner.query(api.tasks.board, {})).backlog.find(
      (task) => task.title === "Left behind",
    );
    expect(seen?.assignee).toEqual({ status: "removed", email: "gone@gmail.com", name: null });
  });
});

// ── Personal records ────────────────────────────────────────────────────────
// One teammate's own mail, calendar, meeting notes and issues, their token
// and how their tools stand. No function, for any other caller, may return
// any of it: not the owner's, and not another teammate's with every page.

describe("a teammate's own records reach nobody else, through any function", () => {
  const THEIRS = "private.person@gmail.com";
  const TOKEN_HASH = "ab".repeat(32);
  const STATUS_WORDS = "invalid_records: SECRET PERSONAL STATUS";

  async function seedPersonal(t: TestBackend) {
    await t.run(async (ctx) => {
      await ctx.db.insert("members", {
        email: THEIRS,
        role: "engineer",
        companies: ["us", "kz"],
        areas: ["today", "board"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
      });
      // Their own `users` row: what is theirs names the person, not only the address.
      const userId = await ctx.db.insert("users", { email: THEIRS, emailVerificationTime: 1 });
      const row = { owner: THEIRS, userId, sortAt: 1_800_000_000_000, syncedAt: 1 };
      await ctx.db.insert("mirrorRecords", {
        ...row,
        source: "gmail",
        externalId: "aa01",
        record: {
          kind: "mail",
          threadId: "aa01",
          fromName: "SECRET PERSONAL SENDER",
          fromAddress: "secret.personal@example.test",
          subject: "SECRET PERSONAL SUBJECT",
          lastMessageAt: row.sortAt,
        },
      });
      await ctx.db.insert("mirrorRecords", {
        ...row,
        sortAt: 500,
        source: "google_calendar",
        externalId: "evt-1",
        record: {
          kind: "event",
          eventId: "evt-1",
          title: "SECRET PERSONAL EVENT",
          startsAt: 500,
          endsAt: 900,
          allDay: false,
          attendees: [{ name: "SECRET PERSONAL GUEST", address: "secret.guest@example.test" }],
          attendeeCount: 1,
          hasMeetingLink: false,
        },
      });
      await ctx.db.insert("mirrorRecords", {
        ...row,
        source: "linear",
        externalId: "iss-1",
        record: {
          kind: "issue",
          issueId: "iss-1",
          identifier: "ENG-1",
          title: "SECRET PERSONAL ISSUE",
          url: "",
          stateType: "started",
          stateName: "",
          teamKey: "",
          teamName: "",
          assigneeName: "SECRET PERSONAL ASSIGNEE",
          mine: true,
          priority: 0,
          updatedAt: row.sortAt,
        },
      });
      await ctx.db.insert("mirrorRecords", {
        ...row,
        source: "fireflies",
        externalId: "meet-1",
        record: {
          kind: "meeting",
          meetingId: "meet-1",
          title: "SECRET PERSONAL MEETING",
          heldAt: row.sortAt,
          durationMinutes: 30,
          participants: [],
          overview: "SECRET PERSONAL OVERVIEW",
          actionItems: ["SECRET PERSONAL ACTION"],
        },
      });
      await ctx.db.insert("personalTokens", {
        owner: THEIRS,
        userId,
        tokenHash: TOKEN_HASH,
        createdAt: 424_242_424_242,
        lastUsedAt: 434_343_434_343,
      });
      for (const source of ["gmail", "google_calendar", "linear", "fireflies"] as const) {
        await ctx.db.insert("personalSourceStatus", {
          owner: THEIRS,
          userId,
          source,
          state: "error",
          message: STATUS_WORDS,
          lastRunAt: 454_545_454_545,
          lastOkAt: 464_646_464_646,
        });
      }
    });
  }

  /** Whether anything a call returned, or threw, holds what is the teammate's alone. */
  const leaks = async (call: Promise<unknown>) => {
    const said = JSON.stringify(
      await call.then(
        (value) => value ?? null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    );
    return [
      "SECRET PERSONAL",
      "secret.personal",
      "secret.guest",
      TOKEN_HASH,
      "424242424242",
      "434343434343",
      "454545454545",
      "464646464646",
    ].some((needle) => said.includes(needle));
  };
  const signInAsThem = async (t: TestBackend) => {
    const { userId, sessionId } = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", THEIRS))
        .unique();
      const userId = user!._id;
      const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: 2e12 });
      return { userId, sessionId };
    });
    return t.withIdentity({ subject: `${userId}|${sessionId}` });
  };

  test("the test would see a leak: the teammate's own reads do hold them", async () => {
    const t = convexTest(schema, modules);
    await seedPersonal(t);
    const them = await signInAsThem(t);
    expect(await leaks(them.query(api.workTools.needsReply, {}))).toBe(true);
    expect(await leaks(them.query(api.workTools.events, { from: 0, to: 1000 }))).toBe(true);
    expect(await leaks(them.query(api.workTools.meetings, {}))).toBe(true);
    expect(await leaks(them.query(api.workTools.myIssues, {}))).toBe(true);
    expect(await leaks(them.query(api.connect.status, {}))).toBe(true);
  });

  // The two that start a read of a source are left out, as elsewhere in this
  // file: no test here should start a sync. Neither reads a record.
  const STARTS_A_SYNC = ["sources:runNow", "workTools:turnOn"];
  const CALLS = Object.entries(SURFACE).filter(([name]) => !STARTS_A_SYNC.includes(name));

  // Each call gets a backend of its own, so a mutation changes nobody else's seed.
  test.each(CALLS)(
    "%s tells the owner, and another teammate with every page, nothing of them",
    async (_name, { call }) => {
      for (const signIn of [
        signInAsOwner,
        (t: TestBackend) => signInWithAreas(t, "cofounder", GRANTABLE_AREAS),
      ]) {
        const t = convexTest(schema, modules);
        const ids = await seed(t);
        await seedPersonal(t);
        expect(await leaks(call(await signIn(t), ids))).toBe(false);
      }
    },
  );

  test("nor does the owner's team list, sources or sync log say a token or a push exists", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await seedPersonal(t);
    const owner = await signInAsOwner(t);
    for (const call of [
      owner.query(api.team.list, {}),
      owner.query(api.sources.list, {}),
      owner.query(api.sources.recentRuns, {}),
      owner.query(api.metrics.scorecard, {}),
      owner.query(api.viewer.me, {}),
    ]) {
      expect(await leaks(call)).toBe(false);
    }
  });

  test("no mutation another person can call changes what is held for them", async () => {
    const held = (t: TestBackend) =>
      t.run(async (ctx) => ({
        records: (await ctx.db.query("mirrorRecords").collect()).filter((d) => d.owner === THEIRS),
        tokens: await ctx.db.query("personalTokens").collect(),
        status: await ctx.db.query("personalSourceStatus").collect(),
      }));
    // Removing them, or unticking Today, is the owner's way to delete it all;
    // every other function must leave it exactly as it was.
    // (The table's own calls to those two name someone else.)
    for (const [name, { call }] of CALLS) {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      await seedPersonal(t);
      const before = await held(t);
      await outcome(call(await signInAsOwner(t), ids));
      const after = await held(t);
      expect([name, after.records, after.status]).toEqual([name, before.records, before.status]);
      expect(after.tokens.filter((row) => row.owner === THEIRS)).toEqual(before.tokens);
    }
  });
});

// ── Payroll ─────────────────────────────────────────────────────────────────

describe("payroll is the owner's alone", () => {
  const PAYROLL = Object.entries(SURFACE).filter(([name]) => name.startsWith("payroll:"));
  const REST = Object.entries(SURFACE).filter(([name]) => !name.startsWith("payroll:"));
  /** Every page the owner can give: the sensitive ones and Costs' row from before included. */
  const EVERY_OTHER: StoredArea[] = [...GRANTABLE_AREAS, "costs"];
  /** A row from before payroll was the owner's alone: it still says Payroll. */
  const STILL_SAYS: StoredArea[] = [...EVERY_OTHER, "payroll"];
  /** Whether anything a call returned, or threw, holds a made-up name or salary. */
  const leaks = async (call: Promise<unknown>) => {
    const said = JSON.stringify(
      await call.then(
        (value) => value ?? null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    );
    return (
      said.includes("SECRET PAYROLL") ||
      said.includes(String(PAYROLL_GROSS)) ||
      said.includes(String(US_PAYROLL_GROSS))
    );
  };
  const tables = (t: TestBackend) =>
    t.run(async (ctx) => ({
      people: await ctx.db.query("payrollPeople").collect(),
      lines: await ctx.db.query("payrollLines").collect(),
      runs: await ctx.db.query("payrollRuns").collect(),
    }));

  test("every payroll function is gated by the payroll area, and there are eighteen", () => {
    expect(PAYROLL).toHaveLength(18);
    for (const [, entry] of PAYROLL) expect(entry.gate).toEqual({ areas: ["payroll"] });
  });

  test("the test would see a leak: the owner's own reads do hold the name and the salary", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    expect(await leaks(owner.query(api.payroll.listPeople, { company: "kz" }))).toBe(true);
    expect(await leaks(owner.query(api.payroll.getRun, KZ_SEP))).toBe(true);
    expect(await leaks(owner.query(api.payroll.listRuns, { company: "kz" }))).toBe(true);
    expect(await leaks(owner.query(api.payroll.listPeople, { company: "us" }))).toBe(true);
    expect(await leaks(owner.query(api.payroll.getRun, US_SEP))).toBe(true);
  });

  test.each(PAYROLL)(
    "%s tells a teammate with every page, and a row that still says Payroll, nothing",
    async (_name, { call }) => {
      for (const areas of [EVERY_OTHER, STILL_SAYS]) {
        const t = convexTest(schema, modules);
        const ids = await seed(t);
        const teammate = await signInWithAreas(t, "cofounder", areas);
        expect(await outcome(call(teammate, ids))).toBe("not_allowed");
        expect(await leaks(call(teammate, ids))).toBe(false);
      }
    },
  );

  test.each(PAYROLL)("%s changes nothing for a teammate, whatever their row says", async (_name, { call }) => {
    for (const areas of [EVERY_OTHER, STILL_SAYS]) {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const before = await tables(t);
      await outcome(call(await signInWithAreas(t, "cofounder", areas), ids));
      expect(await tables(t)).toEqual(before);
    }
  });

  // The scorecard, the attention list's sources, the team list, the sources
  // page and every other function: none of them reads a payroll table, for a
  // teammate who has every page, or for the owner. (What only
  // the owner may call is left out, as above: some of it starts a sync.)
  test.each(REST.filter(([, entry]) => entry.gate !== "owner"))(
    "%s holds no payroll name or salary, for a teammate with every other page or the owner",
    async (_name, { call }) => {
      for (const signIn of [
        (t: TestBackend) => signInWithAreas(t, "cofounder", EVERY_OTHER),
        signInAsOwner,
      ]) {
        const t = convexTest(schema, modules);
        const ids = await seed(t);
        expect(await leaks(call(await signIn(t), ids))).toBe(false);
      }
    },
  );

  test("nor do the owner's scorecard, sources and sync log", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    expect(await leaks(owner.query(api.metrics.scorecard, {}))).toBe(false);
    expect(await leaks(owner.query(api.sources.list, {}))).toBe(false);
    expect(await leaks(owner.query(api.sources.recentRuns, {}))).toBe(false);
  });

  test("working a month writes a name or an amount to no table but payroll's own", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // By the owner, the one who holds the page.
    const holder = await signInAsOwner(t);
    const person = await holder.mutation(api.payroll.createPerson, {
      company: "kz",
      name: `${PAYROLL_NAME} TWO`,
      kind: "employee",
      monthlyGross: PAYROLL_GROSS,
    });
    await holder.mutation(api.payroll.updateLine, { id: ids.payLine, rateBp: 1234 });
    await holder.mutation(api.payroll.prepareRun, KZ_SEP);
    await holder.mutation(api.payroll.setAdjustment, {
      ...KZ_SEP,
      personId: person,
      amount: PAYROLL_GROSS,
      note: PAYROLL_NAME,
    });
    await holder.mutation(api.payroll.markPaid, { ...KZ_SEP, paidOn: "2026-10-05" });

    const elsewhere = await t.run(async (ctx) => {
      const rows: unknown[] = [];
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
        if (!table.startsWith("payroll")) rows.push(...(await ctx.db.query(table).collect()));
      }
      return JSON.stringify(rows);
    });
    expect(elsewhere).not.toContain("SECRET PAYROLL");
    expect(elsewhere).not.toContain(String(PAYROLL_GROSS));
    // Guards the check itself: the payroll tables do hold them.
    const held = await t.run(async (ctx) => JSON.stringify(await ctx.db.query("payrollRuns").collect()));
    expect(held).toContain("SECRET PAYROLL");
  });

  // ── One company ──
  // Only the owner holds Payroll, on both companies, but every function still
  // keeps to the caller's companies. A teammate on Globex alone whose row
  // still says Payroll, aiming each function at Startup's rows (by the
  // `company` argument where there is one, by a Startup row's id where not), is
  // refused and changes nothing.
  const AIMED_AT_US: Record<string, (c: Client, ids: Ids) => Promise<unknown>> = {
    "payroll:listPeople": (c) => c.query(api.payroll.listPeople, { company: "us" }),
    "payroll:createPerson": (c) =>
      c.mutation(api.payroll.createPerson, {
        company: "us",
        name: "Sneaked in",
        kind: "contractor",
        monthlyGross: 1,
      }),
    "payroll:updatePerson": (c, ids) =>
      c.mutation(api.payroll.updatePerson, { id: ids.usPayPerson, title: "theirs" }),
    "payroll:archivePerson": (c, ids) =>
      c.mutation(api.payroll.archivePerson, { id: ids.usPayPerson, archived: true }),
    "payroll:removePerson": (c, ids) =>
      c.mutation(api.payroll.removePerson, { id: ids.usPayPerson }),
    "payroll:listLines": (c) => c.query(api.payroll.listLines, { company: "us" }),
    "payroll:createLine": (c) =>
      c.mutation(api.payroll.createLine, {
        company: "us",
        appliesTo: "employee",
        name: "Sneaked in",
        paidBy: "company",
      }),
    "payroll:updateLine": (c, ids) =>
      c.mutation(api.payroll.updateLine, { id: ids.usPayLine, rateBp: 1 }),
    "payroll:reorderLines": (c, ids) =>
      c.mutation(api.payroll.reorderLines, {
        company: "us",
        appliesTo: "employee",
        ids: [ids.usPayLine],
      }),
    "payroll:removeLine": (c, ids) => c.mutation(api.payroll.removeLine, { id: ids.usPayLine }),
    "payroll:addUsualLines": (c) => c.mutation(api.payroll.addUsualLines, { company: "us" }),
    "payroll:getRun": (c) => c.query(api.payroll.getRun, US_SEP),
    "payroll:listRuns": (c) => c.query(api.payroll.listRuns, { company: "us" }),
    "payroll:prepareRun": (c) => c.mutation(api.payroll.prepareRun, US_SEP),
    "payroll:setAdjustment": (c, ids) =>
      c.mutation(api.payroll.setAdjustment, { ...US_SEP, personId: ids.usPayPerson, amount: 1 }),
    "payroll:markPaid": (c) => c.mutation(api.payroll.markPaid, { ...US_SEP, paidOn: "2026-10-05" }),
    "payroll:reopenRun": (c) => c.mutation(api.payroll.reopenRun, US_SEP),
    "payroll:removeRun": (c) => c.mutation(api.payroll.removeRun, US_SEP),
  };

  test("the other-company table names every payroll function", () => {
    expect(Object.keys(AIMED_AT_US).sort()).toEqual(PAYROLL.map(([name]) => name).sort());
  });

  test.each(Object.entries(AIMED_AT_US))(
    "%s refuses a row on Globex that says Payroll, aimed at Startup, and tells and changes nothing",
    async (_name, call) => {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const holder = await signInWithAreas(t, "engineer", ["payroll"], ["kz"]);
      const before = await tables(t);
      await expect(call(holder, ids)).rejects.toThrow("not_allowed");
      expect(await leaks(call(holder, ids))).toBe(false);
      expect(await tables(t)).toEqual(before);
    },
  );

  test("the same holds the other way round: a row on Startup cannot reach Globex's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["payroll"], ["us"]);
    const before = await tables(t);
    for (const call of [
      holder.query(api.payroll.listPeople, { company: "kz" }),
      holder.query(api.payroll.getRun, KZ_SEP),
      holder.mutation(api.payroll.updatePerson, { id: ids.payPerson, title: "theirs" }),
      holder.mutation(api.payroll.removeLine, { id: ids.payLine }),
      holder.mutation(api.payroll.removeRun, KZ_SEP),
    ]) {
      await expect(call).rejects.toThrow("not_allowed");
    }
    expect(await tables(t)).toEqual(before);
  });

  test("a row that says Payroll is refused even its own company's; the owner reads and changes both", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["payroll"], ["kz"]);
    await expect(holder.query(api.payroll.listPeople, { company: "kz" })).rejects.toThrow("not_allowed");
    await expect(
      holder.mutation(api.payroll.updatePerson, { id: ids.payPerson, title: "Ours" }),
    ).rejects.toThrow("not_allowed");
    const owner = await signInAsOwner(t);
    const people = await owner.query(api.payroll.listPeople, { company: "kz" });
    expect(people.map((person) => person.name)).toEqual([PAYROLL_NAME]);
    await owner.mutation(api.payroll.updatePerson, { id: ids.payPerson, title: "Ours" });
    expect((await t.run((ctx) => ctx.db.get(ids.payPerson)))?.title).toBe("Ours");
    expect(await owner.query(api.payroll.listPeople, { company: "us" })).toHaveLength(1);
    expect(await owner.query(api.payroll.listPeople, { company: "kz" })).toHaveLength(1);
  });

  test("an id of the other company cannot ride in on a call about one company's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const holder = await signInAsOwner(t);
    const before = await tables(t);
    // Startup's person in Globex's month, Startup's line in Globex's order,
    // and Startup's line as one a Globex line subtracts.
    await expect(
      holder.mutation(api.payroll.setAdjustment, { ...KZ_SEP, personId: ids.usPayPerson, amount: 1 }),
    ).rejects.toThrow("That person is not in this month.");
    await expect(
      holder.mutation(api.payroll.reorderLines, {
        company: "kz",
        appliesTo: "employee",
        ids: [ids.usPayLine],
      }),
    ).rejects.toThrow("Those are not this kind's lines. Reload and try again.");
    await expect(
      holder.mutation(api.payroll.updateLine, { id: ids.payLine, lessLineIds: [ids.usPayLine] }),
    ).rejects.toThrow("A line can subtract only other lines of the same company and kind.");
    expect(await tables(t)).toEqual(before);
  });

  test("writing Payroll onto a row by hand opens nothing on the next call", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["board"], ["kz"]);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", "engineer.kz@gmail.com"))
        .unique();
      await ctx.db.patch(row!._id, { areas: ["board", "payroll", "costs"] });
    });
    await expect(holder.query(api.payroll.listPeople, { company: "kz" })).rejects.toThrow(
      "not_allowed",
    );
    await expect(holder.query(api.costs.list, { company: "kz" })).rejects.toThrow("not_allowed");
    expect((await holder.query(api.viewer.me, {}))).toMatchObject({ areas: ["board"] });
  });
});

describe("viewer.me", () => {
  const me = async (client: Client) => {
    const viewer = await client.query(api.viewer.me, {});
    return viewer?.isMember ? { role: viewer.role, areas: viewer.areas } : viewer;
  };

  test("a teammate with no list of their own is told their role's areas", async () => {
    const { client } = await start("sales", ["us"]);
    expect(await me(client)).toEqual({ role: "sales", areas: [...areasOf("sales")] });
  });

  test("a teammate is told the areas the owner picked, under the role they wear", async () => {
    const { client } = await startPicked("engineer", ["board", "finance"]);
    expect(await me(client)).toEqual({ role: "engineer", areas: ["finance", "board"] });
  });

  test("a teammate with no page is still a member, with nothing to open", async () => {
    const { client } = await startPicked("cofounder", []);
    expect(await client.query(api.viewer.me, {})).toMatchObject({
      isOwner: false,
      isMember: true,
      role: "cofounder",
      areas: [],
    });
  });

  test("the owner is told every area", async () => {
    const t = convexTest(schema, modules);
    expect(await me(await signInAsOwner(t))).toEqual({ role: "owner", areas: [...AREAS] });
  });
});
