import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { PROPOSAL_WORDS } from "./lib/agents";
import { legacyProposer } from "./lib/proposals";
import { BOT_WORDS, EXTERNAL_PROFILES } from "./lib/botRules";
import { DUPLICATE_WORDS } from "./lib/duplicates";
import { AGENT_HEADER } from "./lib/osAgents";
import { ENTROPY, NOW, bearer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Bot Loop v3 (docs/assistant.md): A, attribution and the external chief of
// staff; B, near-duplicates. Made-up names and titles throughout.

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
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, mac, grok: grok.token };
}

const proposalsOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());
const tasksOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());
const checksOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("duplicateChecks").collect());

const proposal = (agent: string, dedupeKey: string, title: string, extra: Record<string, unknown> = {}) => ({
  agent,
  company: "us",
  kind: "task_create",
  why: "Made-up why.",
  dedupeKey,
  payload: { title },
  ...extra,
});

async function atAddress(t: TestBackend, bot: string, token: string, name: string, args: unknown = {}) {
  const response = await t.fetch(`/mcp/v1/bot/${bot}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: response.status, body: (await response.json()) as { result?: { isError: boolean; structuredContent: Record<string, unknown> } } };
}

describe("A: attribution", () => {
  test("a bot filing under another known bot's key is refused with expected and got", async () => {
    const { t, grok } = await setUp();
    const wrong = await call(t, grok, "propose", proposal("growth", "compliance:task_create:x", "Made-up filing"));
    expect(wrong.said).toBe(PROPOSAL_WORDS.attribution);
    expect(wrong.refusal).toEqual({ code: "attribution_mismatch", expected: "growth", got: "compliance" });
    // Under one of the four's ids too, and with the `bot-` form.
    expect((await call(t, grok, "propose", proposal("growth", "chief_of_staff:task_create:x", "Made-up a"))).refusal).toEqual({
      code: "attribution_mismatch",
      expected: "growth",
      got: "chief_of_staff",
    });
    expect((await call(t, grok, "propose", proposal("growth", "bot-research:task_create:x", "Made-up b"))).refusal).toMatchObject({
      code: "attribution_mismatch",
      got: "research",
    });
    expect(await proposalsOf(t)).toEqual([]);
  });

  test("its own key in either form, or a prefix nobody has, is fine", async () => {
    const { t, grok } = await setUp();
    expect((await call(t, grok, "propose", proposal("growth", "growth:task_create:a", "Made-up first card"))).output).toMatchObject({ proposed: true });
    expect((await call(t, grok, "propose", proposal("growth", "bot-growth:task_create:b", "Ship pricing page copy"))).output).toMatchObject({
      proposed: true,
    });
    expect((await call(t, grok, "propose", proposal("growth", "q4:task_create:c", "Book venue for offsite"))).output).toMatchObject({ proposed: true });
  });

  test("one of the four filing under a bot's key is refused; goal proposals too", async () => {
    const { t, mac } = await setUp();
    const four = await call(t, mac, "propose", proposal("finance", "growth:task_create:x", "Made-up"));
    expect(four.said).toBe(PROPOSAL_WORDS.attribution);
    expect(four.refusal).toEqual({ code: "attribution_mismatch", expected: "finance", got: "growth" });
    const goal = await call(t, mac, "goal_create", {
      agent: "chief_of_staff",
      company: "us",
      quarter: "2026-Q4",
      title: "Made-up goal",
      why: "Made-up why.",
      dedupeKey: "strategy_advisor:goal_create:x",
    });
    expect(goal.refusal).toEqual({ code: "attribution_mismatch", expected: "chief_of_staff", got: "strategy_advisor" });
  });

  test("the migration re-attributes open proposals whose key names a bot, once", async () => {
    const { t, grok } = await setUp();
    // As the shared client used to file them: under the chief of staff, the key naming the bot.
    await t.run(async (ctx) => {
      const row = {
        agent: "chief_of_staff" as const,
        kind: "task_create" as const,
        company: "us" as const,
        reason: "Made-up",
        status: "open" as const,
        createdAt: NOW,
        editedBeforeApprove: false,
      };
      await ctx.db.insert("proposals", { ...row, dedupeKey: "compliance:task_create:a", payload: { title: "Made-up a" } });
      await ctx.db.insert("proposals", { ...row, dedupeKey: "bot-research:task_create:b", payload: { title: "Made-up b" } });
      await ctx.db.insert("proposals", { ...row, dedupeKey: "chief_of_staff:task_create:c", payload: { title: "Made-up c" } });
      await ctx.db.insert("proposals", { ...row, dedupeKey: "nobody:task_create:d", payload: { title: "Made-up d" } });
      await ctx.db.insert("proposals", {
        ...row,
        status: "dismissed",
        dedupeKey: "growth:task_create:e",
        payload: { title: "Made-up e" },
      });
    });
    expect(await t.mutation(internal.migrations.reattributeOpenProposals, {})).toEqual({ changed: 2, read: 4 });
    const rows = await proposalsOf(t);
    expect(rows.map((r) => [r.dedupeKey, r.bot ?? null, r.agent])).toEqual([
      ["compliance:task_create:a", "compliance", "chief_of_staff"],
      ["bot-research:task_create:b", "research", "chief_of_staff"],
      ["chief_of_staff:task_create:c", null, "chief_of_staff"],
      ["nobody:task_create:d", null, "chief_of_staff"],
      ["growth:task_create:e", null, "chief_of_staff"],
    ]);
    expect(await t.mutation(internal.migrations.reattributeOpenProposals, {})).toEqual({ changed: 0, read: 4 });
    // Compliance now reads them as its own.
    const feedbackRows = (await call(t, grok, "whoami", { agent: "compliance" })).output.limits.proposalsOpen.used;
    expect(feedbackRows).toBe(1);
  });
});

describe("A: the external chief of staff", () => {
  test("through a client that is not the Mac runner's, it is a profile: task_create, whoami, tasks, handoffs", async () => {
    const { t, owner, grok } = await setUp();
    // The owner sets it up on the Bots tab (a first call alone makes it switched off: botSecurity.test.ts).
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const who = await call(t, grok, "whoami", { agent: "chief_of_staff" });
    expect(who.output).toMatchObject({ bot: { id: "chief_of_staff", name: EXTERNAL_PROFILES.chief_of_staff.name } });
    const made = await call(t, grok, "task_create", { agent: "chief_of_staff", title: "Made-up coordinator card" });
    expect(made.output).toMatchObject({ created: true });
    expect((await call(t, grok, "tasks", { agent: "chief_of_staff" })).output).not.toBeNull();
    expect((await call(t, grok, "handoffs", {}, { [AGENT_HEADER]: "chief_of_staff" })).output).not.toBeNull();
    // Locked areas stay locked.
    expect((await call(t, grok, "costs", { agent: "chief_of_staff" })).refusal).toMatchObject({ code: "not_permitted", locked: true });
    // Its profile was made with the defaults, owner-editable like a bot's.
    const profile = (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === "chief_of_staff")!;
    expect(profile).toMatchObject({ name: EXTERNAL_PROFILES.chief_of_staff.name, enabled: true, clients: "any" });
    expect(profile.permissions.filter((p) => p.level === "write").map((p) => p.area)).toEqual(["board", "memory"]);
    // Its audit and counters are its own: the bot path, keyed client + chief_of_staff.
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.every((row) => row.bot === "chief_of_staff")).toBe(true);
    const usage = await t.run((ctx) => ctx.db.query("botUsage").collect());
    expect(usage.some((row) => row.bot === "chief_of_staff")).toBe(true);
  });

  test("the owner edits it on the Bots tab; switched off it is refused", async () => {
    const { t, owner, grok } = await setUp();
    expect((await owner.query(api.bots.list, { today: "2026-10-14" })).externalMissing).toEqual(["chief_of_staff", "engineering", "finance"]);
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const listed = await owner.query(api.bots.list, { today: "2026-10-14" });
    expect(listed.externalMissing).toEqual(["engineering", "finance"]);
    const row = listed.bots.find((b) => b.botId === "chief_of_staff")!;
    await owner.mutation(api.bots.update, { id: row.id, name: "Made-up Coordinator", enabled: false });
    expect((await call(t, grok, "tasks", { agent: "chief_of_staff" })).said).toBe(BOT_WORDS.externalOff);
  });

  test("on a bots-only client it is accepted as this profile, and has its own address", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    // The Grok token is bots-only by default.
    expect((await call(t, grok, "tasks", { agent: "chief_of_staff" })).said).toBeNull();
    const there = await atAddress(t, "chief_of_staff", grok, "whoami");
    expect(there.status).toBe(200);
    expect(there.body.result?.structuredContent).toMatchObject({ bot: { id: "chief_of_staff" } });
    // Sales, Mac only, still has no address.
    const sales = await t.fetch("/mcp/v1/bot/sales", { method: "POST", headers: bearer(grok), body: "{}" });
    expect(sales.status).toBe(404);
  });

  test("on the Mac runner's token the chief of staff keeps its own rules and no profile", async () => {
    const { t, mac } = await setUp();
    const who = await call(t, mac, "whoami", { agent: "chief_of_staff" });
    expect(who.output?.bot ?? null).toBeNull();
    // The Mac's chief of staff may not add a card at once (its allowlist), as before.
    expect((await call(t, mac, "task_create", { agent: "chief_of_staff", title: "Made-up" })).output).toBeNull();
    expect((await t.run((ctx) => ctx.db.query("bots").collect())).some((b) => b.botId === "chief_of_staff")).toBe(false);
  });

  test("its proposals are its own: separate trust from the Mac's and never auto-approved", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    // A grant the Mac's chief of staff earned does not reach the external one, even at its own address.
    const userId = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
    await t.run((ctx) => ctx.db.insert("autonomyGrants", { userId, proposer: "chief_of_staff", kind: "task_create", grantedAt: NOW }));
    const made = await atAddress(t, "chief_of_staff", grok, "propose", {
      company: "us",
      kind: "task_create",
      why: "Made-up why.",
      dedupeKey: "chief_of_staff:task_create:one",
      payload: { title: "Made-up coordination card" },
    });
    expect(made.body.result?.structuredContent).toMatchObject({ proposed: true });
    expect(made.body.result?.structuredContent).not.toHaveProperty("autoApproved");
    const [row] = await proposalsOf(t);
    expect(row).toMatchObject({ bot: "chief_of_staff", agent: "chief_of_staff", status: "open" });
    // Its approval counts toward its own trust row, not the Mac's.
    await owner.mutation(api.assistant.approve, { id: row!._id });
    const trust = await t.run((ctx) => ctx.db.query("botTrust").collect());
    expect(trust.map((r) => r.proposer)).toEqual(["bot:chief_of_staff"]);
  });
});

describe("A: the external engineering agent (spec §13)", () => {
  test("a Grok bot naming engineering gets its own external profile: board and memory write, its own audit", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "engineering" });
    const who = await call(t, grok, "whoami", { agent: "engineering" });
    expect(who.output).toMatchObject({ bot: { id: "engineering", name: EXTERNAL_PROFILES.engineering.name } });
    expect((await call(t, grok, "task_create", { agent: "engineering", title: "Made-up engineering card" })).output).toMatchObject({
      created: true,
    });
    expect((await call(t, grok, "handoffs", {}, { [AGENT_HEADER]: "engineering" })).output).not.toBeNull();
    expect((await call(t, grok, "costs", { agent: "engineering" })).refusal).toMatchObject({ code: "not_permitted", locked: true });
    const profile = (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === "engineering")!;
    expect(profile.permissions.filter((p) => p.level === "write").map((p) => p.area)).toEqual(["board", "memory"]);
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.every((row) => row.bot === "engineering")).toBe(true);
    // Its own address, and its proposals are its own (not the Mac engineering agent's trust).
    const there = await atAddress(t, "engineering", grok, "propose", {
      company: "us",
      kind: "task_create",
      why: "Made-up why.",
      dedupeKey: "engineering:task_create:one",
      payload: { title: "Made-up flaky build fix" },
    });
    expect(there.body.result?.structuredContent).toMatchObject({ proposed: true });
    expect((await proposalsOf(t))[0]).toMatchObject({ bot: "engineering" });
  });

  test("on the Mac runner's token engineering keeps its own rules; sales has no external profile", async () => {
    const { t, mac, grok } = await setUp();
    expect((await call(t, mac, "whoami", { agent: "engineering" })).output?.bot ?? null).toBeNull();
    expect((await t.run((ctx) => ctx.db.query("bots").collect())).some((b) => b.botId === "engineering")).toBe(false);
    for (const agent of ["sales"]) {
      expect((await call(t, grok, "goals", { agent })).said).toBe(BOT_WORDS.botsOnlyFour);
      const there = await t.fetch(`/mcp/v1/bot/${agent}`, { method: "POST", headers: bearer(grok), body: "{}" });
      expect(there.status).toBe(404);
    }
  });
});

describe("A: the external finance bot", () => {
  test("a Grok bot naming finance gets its own external profile, apart from the Mac finance agent", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "finance" });
    const who = await call(t, grok, "whoami", { agent: "finance" });
    expect(who.output).toMatchObject({ bot: { id: "finance", name: EXTERNAL_PROFILES.finance.name } });
    expect((await call(t, grok, "task_create", { agent: "finance", title: "Made-up finance card" })).output).toMatchObject({ created: true });
    // Payroll and costs stay locked, as for every bot.
    expect((await call(t, grok, "costs", { agent: "finance" })).refusal).toMatchObject({ code: "not_permitted", locked: true });
    const there = await atAddress(t, "finance", grok, "propose", proposal("finance", "finance:task_create:one", "Made-up finance proposal"));
    expect(there.status).toBe(200);
    expect((await proposalsOf(t))[0]).toMatchObject({ bot: "finance" });
  });

  test("switching the Mac finance agent off leaves the Grok finance bot working", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "finance" });
    await t.run(async (ctx) => {
      await ctx.db.insert("agentSettings", { off: ["finance"], updatedAt: 1 });
    });
    expect((await call(t, grok, "goals", { agent: "finance" })).isError).toBe(false);
    const made = await call(t, grok, "propose", proposal("finance", "finance:task_create:two", "Another made-up finance proposal"));
    expect(made.isError).toBe(false);
    expect((await proposalsOf(t)).map((row) => row.bot)).toEqual(["finance"]);
  });
});

describe("B: near-duplicates", () => {
  const CAP = "Written cap on Startup→Globex transfers";

  test("a proposal near an open task is refused with the match; force with a reason makes it, marked", async () => {
    const { t, owner, grok } = await setUp();
    const taskId = await owner.mutation(api.tasks.create, { title: CAP, company: "us" });
    const near = await call(t, grok, "propose", proposal("growth", "growth:task_create:cap", "Cap transfers to Globex"));
    expect(near.said).toBe(DUPLICATE_WORDS.possible);
    expect(near.refusal).toEqual({
      code: "possible_duplicate",
      matches: [{ type: "task", id: taskId, title: CAP, sim: expect.any(Number) }],
    });
    expect(await proposalsOf(t)).toEqual([]);

    expect((await call(t, grok, "propose", proposal("growth", "growth:task_create:cap", "Cap transfers to Globex", { force: true }))).said).toBe(
      DUPLICATE_WORDS.forceReason,
    );
    const forced = await call(
      t,
      grok,
      "propose",
      proposal("growth", "growth:task_create:cap", "Cap transfers to Globex", { force: true, forceReason: "Made-up: this one is the board vote" }),
    );
    expect(forced.output).toMatchObject({ proposed: true });
    const [row] = await proposalsOf(t);
    expect(row).toMatchObject({ duplicateOf: [taskId], forceReason: "Made-up: this one is the board vote" });

    // Each check is logged with numbers and a closed word, never a title.
    const checks = await checksOf(t);
    expect(checks.map((c) => [c.tool, c.decision])).toEqual([
      ["propose", "refused"],
      ["propose", "forced"],
    ]);
    expect(JSON.stringify(checks)).not.toContain("Cap");
    // The daily sweep keeps 30 days of them.
    vi.setSystemTime(NOW + 31 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.assistant.sweep, {});
    expect(await checksOf(t)).toEqual([]);
  });

  test("task_create and handoff_create are checked too; an unrelated title is clear", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.tasks.create, { title: CAP, company: "us" });
    const task = await call(t, grok, "task_create", { agent: "growth", title: "Cap transfers to Globex", company: "us" });
    expect(task.refusal).toMatchObject({ code: "possible_duplicate" });
    const forced = await call(t, grok, "task_create", {
      agent: "growth",
      title: "Cap transfers to Globex",
      company: "us",
      force: true,
      forceReason: "Made-up: different cap",
    });
    expect(forced.output).toMatchObject({ created: true });
    const card = (await tasksOf(t)).find((row) => row.title === "Cap transfers to Globex")!;
    expect(card).toMatchObject({ forceReason: "Made-up: different cap", duplicateOf: [expect.any(String)] });

    const handoff = await call(t, grok, "handoff_create", {
      agent: "growth",
      company: "us",
      to: "research",
      title: "Cap transfers to Globex",
      summary: "Made-up summary.",
    });
    expect(handoff.refusal).toMatchObject({ code: "possible_duplicate" });
    expect((await call(t, grok, "task_create", { agent: "growth", title: "Book venue for the offsite", company: "us" })).output).toMatchObject({
      created: true,
    });
  });

  test("the other company's open items are not candidates", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.tasks.create, { title: CAP, company: "kz" });
    expect((await call(t, grok, "task_create", { agent: "growth", title: "Cap transfers to Globex", company: "us" })).output).toMatchObject({
      created: true,
    });
  });

  test("the threshold is the owner's", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.tasks.create, { title: CAP, company: "us" });
    await owner.mutation(api.duplicates.setThreshold, { threshold: 0.95 });
    expect((await owner.query(api.duplicates.settings, {})).threshold).toBe(0.95);
    expect((await call(t, grok, "task_create", { agent: "growth", title: "Cap transfers to Globex", company: "us" })).output).toMatchObject({
      created: true,
    });
    await expect(owner.mutation(api.duplicates.setThreshold, { threshold: 0.2 })).rejects.toThrow(DUPLICATE_WORDS.threshold);
  });
});

describe("legacyProposer", () => {
  const profiles = new Set(["growth", "customer_success", "chief_of_staff"]);

  test("a key that names a bot is that bot's, even when the row was filed under the chief of staff", () => {
    expect(legacyProposer({ agent: "chief_of_staff", dedupeKey: "growth:task_create:old" }, profiles)).toBe("growth");
    expect(legacyProposer({ agent: "chief_of_staff", dedupeKey: "bot-customer_success:task_create:old" }, profiles)).toBe(
      "customer_success",
    );
  });

  test("one of the four is named by its key, and a prefix nobody has stays the agent it was filed under", () => {
    expect(legacyProposer({ agent: "engineering", dedupeKey: "engineering:task_create:pr-sample-17" }, profiles)).toBe(
      "engineering",
    );
    // `cs:` is not the customer_success profile: it stays the chief of staff's.
    expect(legacyProposer({ agent: "chief_of_staff", dedupeKey: "cs:task_create:triage" }, profiles)).toBe("chief_of_staff");
  });
});

describe("decided proposals with no bot still reach the proposer", () => {
  const row = {
    company: "us" as const,
    reason: "Made-up why.",
    createdAt: NOW - 60_000,
    editedBeforeApprove: false,
  };

  async function filed(
    t: TestBackend,
    extra: {
      agent: "chief_of_staff" | "engineering";
      kind: "task_create" | "draft";
      dedupeKey: string;
      status: "dismissed" | "approved";
      decidedAt: number;
      bot?: string;
      rejectCode?: "wrong_timing" | "not_a_priority" | "duplicate";
      rejectReason?: string;
    },
  ) {
    await t.run((ctx) =>
      ctx.db.insert("proposals", {
        ...row,
        agent: extra.agent,
        kind: extra.kind,
        dedupeKey: extra.dedupeKey,
        status: extra.status,
        decidedAt: extra.decidedAt,
        payload: extra.kind === "draft" ? { title: "Made-up draft", body: "Made-up body." } : { title: "Made-up task" },
        ...(extra.bot === undefined ? null : { bot: extra.bot }),
        ...(extra.rejectCode === undefined ? null : { rejectCode: extra.rejectCode }),
        ...(extra.rejectReason === undefined ? null : { rejectReason: extra.rejectReason }),
      }),
    );
  }

  test("proposals_feedback returns them to the proposing agent, with the reason, and rejectedKinds counts the dismissals", async () => {
    const { t, owner, mac, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    await owner.mutation(api.bots.addExternalProfile, { id: "engineering" });
    await filed(t, {
      agent: "chief_of_staff",
      kind: "task_create",
      dedupeKey: "cs:task_create:triage",
      status: "dismissed",
      decidedAt: NOW,
      rejectCode: "wrong_timing",
      rejectReason: "Made-up: not this week",
    });
    await filed(t, {
      agent: "chief_of_staff",
      kind: "draft",
      dedupeKey: "cs:draft:winback",
      status: "dismissed",
      decidedAt: NOW - 1_000,
      rejectCode: "not_a_priority",
    });
    await filed(t, {
      agent: "chief_of_staff",
      kind: "task_create",
      dedupeKey: "chief_of_staff:task_create:kept",
      status: "approved",
      decidedAt: NOW - 2_000,
    });
    await filed(t, {
      agent: "engineering",
      kind: "task_create",
      dedupeKey: "engineering:task_create:pr-sample-17",
      status: "dismissed",
      decidedAt: NOW - 3_000,
      rejectReason: "Made-up: the pull request is fine",
    });
    await filed(t, {
      agent: "chief_of_staff",
      kind: "task_create",
      dedupeKey: "growth:task_create:old",
      status: "dismissed",
      decidedAt: NOW - 4_000,
      rejectCode: "duplicate",
    });
    await filed(t, {
      agent: "chief_of_staff",
      kind: "task_create",
      dedupeKey: "support:task_create:inbox",
      status: "approved",
      decidedAt: NOW - 5_000,
      bot: "support",
    });

    const cos = await call(t, grok, "proposals_feedback", { agent: "chief_of_staff" });
    expect(cos.output.rows.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      "cs:task_create:triage",
      "cs:draft:winback",
      "chief_of_staff:task_create:kept",
    ]);
    expect(cos.output.rows[0]).toMatchObject({
      agent: "chief_of_staff",
      bot: null,
      decision: "rejected",
      status: "dismissed",
      rejectCode: "wrong_timing",
      rejectReason: "Made-up: not this week",
      rejection: { kind: "task_create", code: "wrong_timing", reason: "Made-up: not this week" },
    });
    expect(cos.output.rows[2]).toMatchObject({ decision: "approved", rejection: null });
    expect(cos.output.rejectedKinds).toEqual({ task_create: 1, draft: 1 });
    expect(cos.output.withdrawnKinds).toEqual({});

    const engineering = await call(t, grok, "proposals_feedback", { agent: "engineering" });
    expect(engineering.output.rows.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      "engineering:task_create:pr-sample-17",
    ]);
    expect(engineering.output.rows[0]).toMatchObject({
      decision: "rejected",
      rejectReason: "Made-up: the pull request is fine",
      rejection: { kind: "task_create", code: null, reason: "Made-up: the pull request is fine" },
    });
    expect(engineering.output.rejectedKinds).toEqual({ task_create: 1 });

    // A key that names another bot is that bot's, not the chief of staff's it was filed under.
    const growth = await call(t, grok, "proposals_feedback", { agent: "growth" });
    expect(growth.output.rows.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual(["growth:task_create:old"]);
    expect(growth.output.rejectedKinds).toEqual({ task_create: 1 });
    const support = await call(t, grok, "proposals_feedback", { agent: "support" });
    expect(support.output.rows.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual(["support:task_create:inbox"]);
    expect(support.output.rejectedKinds).toEqual({});
    // `cs:` does not name customer_success.
    expect((await call(t, grok, "proposals_feedback", { agent: "customer_success" })).output.rows).toEqual([]);

    // The owner's own client still reads every proposer.
    const all = await call(t, mac, "proposals_feedback", {});
    expect(all.output.rows).toHaveLength(6);
    expect(all.output.rejectedKinds).toEqual({ task_create: 3, draft: 1 });
    expect((await call(t, grok, "proposals_feedback", { agent: "chief_of_staff", company: "kz" })).output.rows).toEqual([]);

    // The same key, decided before `bot` was stamped, is a repeat for that proposer.
    const again = await call(t, grok, "propose", {
      agent: "chief_of_staff",
      company: "us",
      kind: "task_create",
      why: "Made-up why.",
      dedupeKey: "cs:task_create:triage",
      payload: { title: "Made-up triage card" },
    });
    expect(again.said).toBe(PROPOSAL_WORDS.repeatDismissed);
  });
});
