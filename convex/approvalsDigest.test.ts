import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { STARTUP_OS_PROJECT } from "./lib/agentStartupOs";
import { URGENCIES, urgencyOf, type Urgency } from "./lib/approvalsDigest";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";
import { finishScheduled } from "./test.timers";

// The daily approvals digest (convex/approvalsDigest.ts). `fetch` is a stub
// throughout; nothing here reaches Telegram. Every name and reason is made up.

const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";
const NOW = Date.UTC(2026, 9, 20, 4, 0, 0);
const HOUR = 60 * 60 * 1000;
const OWNER_TELEGRAM_ID = "770001";
// Text that must never reach Telegram or the notification.
const SECRET_REASON = "Made-up: Dr. Pat Jones at Sunrise Vertical owes $48,200 (MRN 00123)";
const SECRET_TITLE = "Made-up: call Sunrise Vertical about the unpaid invoice";

type Call = { url: string; body: Record<string, unknown> };
function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world({ linked = true, enabled = true } = {}) {
  const t = convexTest(schema, modules);
  const ownerId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: OWNER, emailVerificationTime: 1 });
    await ctx.db.insert("telegramSettings", {
      enabled,
      owners: [
        {
          userId: id,
          telegram: "Olga_Owner",
          ...(linked ? { telegramUserId: OWNER_TELEGRAM_ID, telegramBoundAt: 1 } : null),
        },
      ],
      // The company group must never be where the digest goes.
      chatUs: { id: "-1001", title: "Startup team" },
    });
    return id;
  });
  return { t, ownerId };
}

async function propose(
  t: TestBackend,
  over: Partial<{ kind: string; bot: string; agent: string; ageHours: number; urgency: Urgency }> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("proposals", {
      agent: (over.agent ?? "sales") as "sales",
      ...(over.bot === undefined ? null : { bot: over.bot }),
      kind: (over.kind ?? "draft") as "draft",
      company: "us",
      reason: SECRET_REASON,
      payload: { title: SECRET_TITLE },
      dedupeKey: `k:${Math.random()}`,
      status: "open",
      createdAt: NOW - (over.ageHours ?? 5) * HOUR,
      editedBeforeApprove: false,
      ...(over.urgency === undefined ? null : { urgency: over.urgency }),
    }),
  );
}
const pause = (t: TestBackend, ageHours: number, project: string = STARTUP_OS_PROJECT) =>
  t.run((ctx) =>
    ctx.db.insert("agentApprovals", {
      project,
      rootAgentId: "ops-agent",
      rootRunId: "run-1",
      agentId: "ops-agent",
      runId: "run-1",
      toolId: "send_email",
      arguments: JSON.stringify({ to: "pat@sunrise-vertical.example", body: SECRET_REASON }),
      state: "pending",
      createdAt: NOW - ageHours * HOUR,
    }),
  );
const notes = (t: TestBackend) => t.run((ctx) => ctx.db.query("notifications").collect());

const run = async (t: TestBackend) => {
  await t.action(internal.approvalsDigest.run, {});
  await finishScheduled(t);
};

describe("the daily approvals digest", () => {
  test("sends nothing and writes nothing when nothing is waiting", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await propose(t, {}).then((id) => t.run((ctx) => ctx.db.patch(id, { status: "approved" })));
    await run(t);
    expect(calls).toHaveLength(0);
    expect(await notes(t)).toHaveLength(0);
  });

  test("goes to the owner's own chat, never the company group", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await propose(t, { kind: "task_create", bot: "growth", ageHours: 80 });
    await run(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/sendMessage");
    expect(calls[0]!.body.chat_id).toBe(OWNER_TELEGRAM_ID);
    expect(calls[0]!.body.chat_id).not.toBe("-1001");
  });

  test("says counts by urgency, the total, the three oldest by kind, bot and age, and the link", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await propose(t, { kind: "draft", bot: "growth", ageHours: 80 });
    await propose(t, { kind: "task_create", agent: "engineering", ageHours: 30, urgency: "critical" });
    await propose(t, { kind: "deal_next_step", bot: "pipeline", ageHours: 10, urgency: "high" });
    await propose(t, { kind: "goal_update", bot: "newer", ageHours: 2 });
    await pause(t, 50);
    await run(t);
    const text = String(calls[0]!.body.text);
    expect(text).toContain("5");
    // Each proposal's own `urgency` (Approvals v2); one without it, and a paused tool call, are normal.
    expect(text).toMatch(/Critical 1/);
    expect(text).toMatch(/High 1/);
    expect(text).toMatch(/Normal 3/);
    expect(text).toContain("https://os.example.com/approvals");
    // Oldest first: 80h draft by growth, 50h paused tool call, 30h task by the engineering agent.
    const lines = text.split("\n").filter((line) => /^\d\. /.test(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/draft.*growth.*3d/i);
    expect(lines[1]).toMatch(/paused tool call.*ops-agent.*2d/i);
    expect(lines[2]).toMatch(/task.*Engineering manager.*30h/i);
    expect(text).not.toContain("newer");
  });

  test("leaks no free text: no reason, title, name, clinic, amount or tool arguments", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await propose(t, { ageHours: 40 });
    await propose(t, { kind: "task_create", bot: "growth", ageHours: 20 });
    await pause(t, 60);
    await run(t);
    const everything = JSON.stringify([calls.map((c) => c.body), await notes(t)]);
    for (const leak of ["Sunrise", "Pat Jones", "48,200", "00123", "unpaid", "invoice", "send_email", "pat@"]) {
      expect(everything).not.toContain(leak);
    }
  });

  test("a bot id that is not a plain slug is not quoted", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await propose(t, { bot: "Dr Pat <b>Jones</b> @clinic" });
    await run(t);
    const text = String(calls[0]!.body.text);
    expect(text).not.toContain("Jones");
    expect(text).not.toContain("clinic");
  });

  test("counts what the inbox lists: another project's paused call is none of the owner's approvals", async () => {
    stubFetch();
    const { t } = await world();
    await propose(t, {});
    await pause(t, 3);
    await pause(t, 4, "made-up-project");
    await run(t);
    expect((await notes(t))[0]!.title).toContain("2 waiting");
  });

  test("makes one in-app notification for the owner with the same counts", async () => {
    stubFetch();
    const { t, ownerId } = await world();
    await propose(t, {});
    await propose(t, {});
    await pause(t, 3);
    await run(t);
    const rows = await notes(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient: ownerId, kind: "approvals_digest" });
    expect(rows[0]!.title).toContain("3 waiting");
    expect(rows[0]!.title).toMatch(/3 normal/);
  });

  test("runs once a day: a second run the same day sends and writes nothing", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await propose(t, {});
    await run(t);
    await run(t);
    expect(calls).toHaveLength(1);
    expect(await notes(t)).toHaveLength(1);
    // The next day it goes again.
    vi.setSystemTime(NOW + 24 * HOUR);
    await run(t);
    expect(calls).toHaveLength(2);
    expect(await notes(t)).toHaveLength(2);
  });

  test("an owner with no linked Telegram chat is sent nothing there, and the notification says so", async () => {
    const calls = stubFetch();
    const { t } = await world({ linked: false });
    await propose(t, {});
    await run(t);
    expect(calls).toHaveLength(0);
    const [row] = await notes(t);
    expect(row!.title).toMatch(/Telegram: not sent/);
  });

  test("with the bot switched off or no token, nothing is sent and the notification says so", async () => {
    const calls = stubFetch();
    const off = await world({ enabled: false });
    await propose(off.t, {});
    await run(off.t);
    expect(calls).toHaveLength(0);
    expect((await notes(off.t))[0]!.title).toMatch(/Telegram: not sent/);

    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const noToken = await world();
    await propose(noToken.t, {});
    await run(noToken.t);
    expect(calls).toHaveLength(0);
    expect((await notes(noToken.t))[0]!.title).toMatch(/Telegram: not sent/);
  });

  test("a Telegram failure does not throw and the notification is still there", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    const { t } = await world();
    await propose(t, {});
    await run(t);
    expect(await notes(t)).toHaveLength(1);
  });

  test("expired and decided proposals and decided tool calls are not counted", async () => {
    const calls = stubFetch();
    const { t } = await world();
    const id = await propose(t, {});
    await t.run((ctx) => ctx.db.patch(id as Id<"proposals">, { status: "expired" }));
    const approval = await pause(t, 5);
    await t.run((ctx) => ctx.db.patch(approval, { state: "approved" }));
    await run(t);
    expect(calls).toHaveLength(0);
  });
});

describe("the cash group and handoffs to people (Bot Loop v3)", () => {
  const goal = (t: TestBackend, cash: boolean, title = "Made-up: ship the scheduler") =>
    t.run((ctx) => ctx.db.insert("goals", { quarter: "2026-Q4", title, status: "on_track", order: 1, cash }));
  const toPerson = (t: TestBackend, ageHours: number, status: "open" | "accepted" = "open") =>
    t.run((ctx) =>
      ctx.db.insert("handoffs", {
        company: "us",
        from: "support",
        fromKey: "support",
        to: "pat@sunrise-vertical.example",
        toKey: "@pat@sunrise-vertical.example",
        toKind: "person",
        title: SECRET_TITLE,
        summary: SECRET_REASON,
        links: [],
        status,
        openSince: NOW - ageHours * HOUR,
        createdAt: NOW - ageHours * HOUR,
        updatedAt: NOW - ageHours * HOUR,
        history: [],
      }),
    );

  test("counts the proposals pinned in Cash and runway, and person handoffs open over a day", async () => {
    const calls = stubFetch();
    const { t } = await world();
    const cash = await goal(t, true);
    const other = await goal(t, false);
    for (const goalId of [cash, cash, other]) {
      const id = await propose(t, {});
      await t.run((ctx) => ctx.db.patch(id, { goalId }));
    }
    await toPerson(t, 30);
    await toPerson(t, 50);
    await toPerson(t, 5);
    await toPerson(t, 40, "accepted");
    await run(t);
    const text = String(calls[0]!.body.text);
    expect(text).toContain("Cash and runway: 2");
    expect(text).toContain("Handoffs to people open over 24h: 2");
    const [row] = await notes(t);
    expect(row!.title).toContain("2 in cash and runway");
    expect(row!.title).toContain("2 handoffs to people open over 24h");
    const everything = JSON.stringify([calls.map((c) => c.body), await notes(t)]);
    for (const leak of ["Sunrise", "unpaid", "pat@", "support"]) expect(everything).not.toContain(leak);
  });

  test("counts the cash group as /approvals pins it: one rule (convex/lib/cashGroup.ts), not the cash tag alone", async () => {
    const calls = stubFetch();
    const { t, ownerId } = await world();
    // Each of these is pinned on the page; none serves a goal tagged cash.
    const runway = await goal(t, false, "Made-up: twelve months of runway");
    const byGoal = await propose(t, {});
    await t.run((ctx) => ctx.db.patch(byGoal, { goalId: runway }));
    await propose(t, { agent: "finance" });
    await t.run(async (ctx) => {
      await ctx.db.insert("bots", {
        userId: ownerId,
        botId: "fundraising",
        name: "Fundraising Bot",
        role: "Fundraising",
        clients: "any",
        enabled: true,
        suggested: false,
        permissions: [{ area: "fundraising", level: "write" }],
        limits: { callsPer10Min: 60, changesPer10Min: 20, proposalsPerDay: 20 },
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    await propose(t, { bot: "fundraising" });
    const investorDraft = await propose(t, {});
    await t.run((ctx) => ctx.db.patch(investorDraft, { payload: { title: SECRET_TITLE, body: "x", about: { type: "investor" } } }));
    const financeMetric = await propose(t, {});
    await t.run((ctx) => ctx.db.patch(financeMetric, { source: { kind: "metric", id: "cash" } }));
    // And one that is not.
    const plain = await propose(t, {});
    const plainGoal = await goal(t, false);
    await t.run((ctx) => ctx.db.patch(plain, { goalId: plainGoal }));
    await run(t);
    expect(String(calls[0]!.body.text)).toContain("Cash and runway: 5");
  });

  test("goes out for stale handoffs to people even with no proposal waiting", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await toPerson(t, 30);
    await run(t);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.body.text)).toContain("Handoffs to people open over 24h: 1");
  });

  test("says nothing of either when both are none", async () => {
    const calls = stubFetch();
    const { t } = await world();
    await propose(t, {});
    await toPerson(t, 5);
    await run(t);
    const text = String(calls[0]!.body.text);
    expect(text).not.toContain("Cash and runway");
    expect(text).not.toContain("Handoffs to people");
  });
});

describe("urgency, read from the proposal's own field", () => {
  test("a missing urgency is normal; the four known ones are themselves", () => {
    expect(URGENCIES).toEqual(["critical", "high", "normal", "low"]);
    expect(urgencyOf({})).toBe("normal");
    expect(urgencyOf({ urgency: "critical" })).toBe("critical");
    expect(urgencyOf({ urgency: "low" })).toBe("low");
  });
});
