import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PROPOSAL_WORDS } from "./lib/agents";
import { BOT_WORDS } from "./lib/botRules";
import { TRUST_WORDS, isAutonomyEligible } from "./lib/trust";
import { ENTROPY, NOW, bearer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Where the bots' branches (Revision 6) meet Approvals v2 and earned autonomy
// (Revision 7): a bot's address refusal and its proposals' refusals carry
// codes; `permission_request` needs a `why`; a bot's feedback has the new
// fields; a bot permission is never autonomous; `whoami` says what is open
// and what the owner lets it do without approval. Made-up names throughout.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, grok: grok.token };
}

const proposalsOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());

describe("refusal codes beyond admission", () => {
  test("a call at one bot's address naming another is refused as not_this_address", async () => {
    const { t, grok } = await setUp();
    const response = await t.fetch("/mcp/v1/bot/growth", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(grok) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "goals", arguments: { agent: "research" } } }),
    });
    const result = ((await response.json()) as { result: { isError: boolean; content: { text: string }[]; structuredContent: unknown } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(BOT_WORDS.notThisAddress);
    expect(result.structuredContent).toEqual({ code: "not_this_address" });
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.map((row) => row.refusal ?? null)).not.toContainEqual({ code: "unknown_bot" });
  });

  test("permission_request needs a why: refused with missing_why and nothing stored; `why` or the old `reason` will do", async () => {
    const { t, grok } = await setUp();
    const bare = await call(t, grok, "permission_request", { agent: "partnerships", area: "sales", level: "write" });
    expect(bare.said).toBe(PROPOSAL_WORDS.why);
    expect(bare.refusal).toEqual({ code: "missing_why" });
    expect(await proposalsOf(t)).toEqual([]);
    const asked = await call(t, grok, "permission_request", {
      agent: "partnerships",
      area: "sales",
      level: "write",
      why: "To set next steps on partner deals.",
    });
    expect(asked.output).toMatchObject({ proposed: true });
    expect((await proposalsOf(t))[0]).toMatchObject({ kind: "bot_permission", reason: "To set next steps on partner deals.", urgency: "normal" });
    // The same request again is a repeat, in code too.
    const again = await call(t, grok, "permission_request", { agent: "partnerships", area: "sales", level: "write", reason: "Made-up." });
    expect(again.said).toBe(PROPOSAL_WORDS.repeatOpen);
    expect(again.refusal).toEqual({ code: "repeat" });
    // The audit keeps the code.
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.filter((row) => row.bot === "partnerships").map((row) => row.refusal?.code ?? null)).toEqual([
      "missing_why",
      null,
      "repeat",
    ]);
  });

  test("a proposal's goal that is not that company's is bad_context", async () => {
    const { t, grok } = await setUp();
    const wrong = await call(t, grok, "propose", {
      agent: "growth",
      company: "us",
      kind: "task_create",
      why: "Made-up why.",
      goalId: "not-a-goal",
      dedupeKey: "bot-growth:task_create:made-up",
      payload: { title: "Made-up task" },
    });
    expect(wrong.said).toBe(PROPOSAL_WORDS.goalLink);
    expect(wrong.refusal).toEqual({ code: "bad_context" });
  });
});

describe("a bot permission on /approvals", () => {
  test("its card shows the level before and after; a rejection's code and words reach the bot", async () => {
    const { t, owner, grok } = await setUp();
    await call(t, grok, "permission_request", { agent: "partnerships", area: "customers", level: "write", why: "Made-up why." });
    const row = (await owner.query(api.assistant.inbox, {})).find((p) => p.kind === "bot_permission")!;
    expect(row).toMatchObject({ why: "Made-up why.", urgency: "normal" });
    expect((row as { effect: unknown }).effect).toEqual({
      changes: [{ field: "Customers", before: "None", after: "Write" }],
      text: null,
    });
    await owner.mutation(api.assistant.dismiss, { id: row.id as Id<"proposals">, code: "not_a_priority", reason: "Made-up: later" });
    const feedback = await call(t, grok, "proposals_feedback", { agent: "partnerships" });
    expect(feedback.output.rows).toEqual([
      expect.objectContaining({
        bot: "partnerships",
        kind: "bot_permission",
        decision: "rejected",
        rejectCode: "not_a_priority",
        rejectReason: "Made-up: later",
        urgency: "normal",
      }),
    ]);
    const inbox = await call(t, grok, "my_inbox", { agent: "partnerships" });
    expect(inbox.output.permissions).toEqual([
      expect.objectContaining({ area: "customers", level: "write", status: "dismissed", reason: "Made-up: later" }),
    ]);
  });

  test("is never eligible for autonomy, and a grant for it is refused", async () => {
    const { owner } = await setUp();
    expect(isAutonomyEligible("bot_permission")).toBe(false);
    await expect(owner.mutation(api.trust.grant, { proposer: "partnerships", kind: "bot_permission" })).rejects.toThrow(
      TRUST_WORDS.neverEligible,
    );
  });

  test("a crafted grant does not auto-approve it", async () => {
    const { t, owner, grok } = await setUp();
    const userId = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
    await t.run((ctx) =>
      ctx.db.insert("autonomyGrants", { userId, proposer: "partnerships", kind: "bot_permission", grantedAt: NOW }),
    );
    await call(t, grok, "permission_request", { agent: "partnerships", area: "sales", level: "write", why: "Made-up why." });
    expect((await proposalsOf(t))[0]!.status).toBe("open");
    expect((await owner.query(api.assistant.inbox, {})).some((p) => p.kind === "bot_permission")).toBe(true);
  });
});

describe("whoami and earned autonomy", () => {
  test("says how many of its proposals are open and which kinds the owner lets it do without approval", async () => {
    const { t, owner, grok } = await setUp();
    const before = (await call(t, grok, "whoami", { agent: "growth" })).output;
    expect(before.limits.proposalsOpen).toEqual({ max: expect.any(Number), used: 0, remaining: before.limits.proposalsOpen.max });
    expect(before.autoApproved).toEqual([]);

    await call(t, grok, "propose", {
      agent: "growth",
      company: "us",
      kind: "task_create",
      why: "Made-up why.",
      dedupeKey: "bot-growth:task_create:one",
      payload: { title: "Made-up task one" },
    });
    // The owner's yes, as `trust.grant` writes it once earned.
    const userId = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
    await t.run((ctx) => ctx.db.insert("autonomyGrants", { userId, proposer: "growth", kind: "task_create", grantedAt: NOW }));
    const after = (await call(t, grok, "whoami", { agent: "growth" })).output;
    expect(after.limits.proposalsOpen.used).toBe(1);
    expect(after.autoApproved).toEqual(["task_create"]);

    // Under the grant, the next one made at Growth's own address (a credential bound to
    // it, not a name a shared client sent) goes through approveProposal at once, as auto_approved.
    const response = await t.fetch("/mcp/v1/bot/growth", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(grok) },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "propose",
          arguments: {
            company: "us",
            kind: "task_create",
            why: "Made-up why two.",
            urgency: "high",
            dedupeKey: "bot-growth:task_create:two",
            payload: { title: "Made-up task two" },
          },
        },
      }),
    });
    const made = (await response.json()) as { result: { structuredContent: unknown } };
    expect(made.result.structuredContent).toMatchObject({ proposed: true, autoApproved: { taskId: expect.any(String) } });
    const two = (await proposalsOf(t)).find((p) => p.dedupeKey === "bot-growth:task_create:two")!;
    expect(two).toMatchObject({ status: "auto_approved", urgency: "high", edits: [] });
    const trust = await t.run((ctx) => ctx.db.query("botTrust").collect());
    expect(trust).toEqual([expect.objectContaining({ proposer: "growth", kind: "task_create", autoApproved: 1, streak: 0 })]);
    // Flagging it stores a rejection's reason, which the bot reads back.
    await owner.mutation(api.trust.flag, { id: two._id, code: "wrong_data", reason: "Made-up: wrong board" });
    const feedback = await call(t, grok, "proposals_feedback", { agent: "growth" });
    expect(feedback.output.rows).toContainEqual(
      expect.objectContaining({ decision: "auto_approved", rejectCode: "wrong_data", rejectReason: "Made-up: wrong board" }),
    );
    expect((await call(t, grok, "whoami", { agent: "growth" })).output.autoApproved).toEqual([]);
  });
});
