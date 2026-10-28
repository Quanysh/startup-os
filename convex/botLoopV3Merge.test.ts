import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PROPOSAL_WORDS } from "./lib/agents";
import { EXTERNAL_OWNER_AGENTS, externalPermissions } from "./lib/botRules";
import { DUPLICATE_WORDS } from "./lib/duplicates";
import { ENTROPY, NOW, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, memberEmail, modules, signInWithAreas, type TestBackend } from "./test.setup";

// Bot Loop v3 across its four branches (v3-core, v3-deals-outcomes,
// v3-handoffs, v3-goals-standup): where one branch's rule meets another's.
// The external chief of staff and engineering profiles (A) against the
// outcomes area (G) and handoffs to people (D); the goal fields (E) through
// the attribution guard and the near-duplicate check (A, B). Every name,
// title and address is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  // Off: nothing is left scheduled past a test.
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A teammate on Startup with the board: someone a bot may hand work to. */
const PERSON = memberEmail("sales", ["us"]);

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  // Switched on by the owner: a first call alone makes them off (botSecurity.test.ts).
  for (const id of EXTERNAL_OWNER_AGENTS) await owner.mutation(api.bots.addExternalProfile, { id });
  await signInWithAreas(t, "sales", ["board"], ["us"]);
  return { t, owner, grok: grok.token };
}

const profileOf = async (t: TestBackend, id: string) =>
  (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === id)!;
const proposalsOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());

describe("the external profiles and the outcomes area (A with G)", () => {
  test("their defaults read outcomes like any bot that runs no plays", () => {
    expect(externalPermissions()).toContainEqual({ area: "outcomes", level: "read" });
    // Write stays the board and memory only.
    expect(externalPermissions().filter((p) => p.level === "write").map((p) => p.area)).toEqual(["board", "memory"]);
  });

  test.each(EXTERNAL_OWNER_AGENTS)("%s reads outcomes; outcome_log asks for write on outcomes", async (id) => {
    const { t, grok } = await setUp();
    expect((await call(t, grok, "outcomes", { agent: id })).output).toMatchObject({ rows: [] });
    expect((await profileOf(t, id)).permissions).toContainEqual({ area: "outcomes", level: "read" });
    const logged = await call(t, grok, "outcome_log", {
      agent: id,
      company: "us",
      subject: { kind: "deal", id: "made-up" },
      play: "Made-up play",
      result: "pending",
      evidence: "Made-up evidence.",
      actedOn: "2026-10-01",
    });
    expect(logged.refusal).toMatchObject({ code: "not_permitted", tool: "outcome_log", area: "outcomes", need: "write" });
  });

  test("grantDefaults gives an external profile made before the area read on it, and keeps one that has it", async () => {
    const { t, grok } = await setUp();
    // Both profiles made, as the first call through a non-runner client makes them.
    for (const id of EXTERNAL_OWNER_AGENTS) await call(t, grok, "whoami", { agent: id });
    await t.run(async (ctx) => {
      const chief = (await ctx.db.query("bots").collect()).find((b) => b.botId === "chief_of_staff")!;
      await ctx.db.patch(chief._id, { permissions: chief.permissions.filter((p) => p.area !== "outcomes") });
    });
    const ran = await t.mutation(internal.outcomes.grantDefaults, {});
    // Ten suggested bots, engineering and finance kept; chief of staff given read.
    expect(ran).toEqual({ write: 0, read: 1, kept: 12 });
    expect((await profileOf(t, "chief_of_staff")).permissions).toContainEqual({ area: "outcomes", level: "read" });
  });
});

describe("the external profiles and handoffs to people (A with D)", () => {
  test.each(EXTERNAL_OWNER_AGENTS)("%s, which writes the board, hands work to a person", async (id) => {
    const { t, grok } = await setUp();
    const made = await call(t, grok, "handoff_create", {
      agent: id,
      company: "us",
      to: { type: "person", email: PERSON },
      title: `Made-up: ${id} asks for a review`,
      summary: "Made-up summary.",
    });
    expect(made.output).toMatchObject({ created: true });
    const [row] = await t.run((ctx) => ctx.db.query("handoffs").collect());
    // As its external profile, never the Mac agent of that id (botSecurity.test.ts).
    expect(row).toMatchObject({ from: `bot:${id}`, toKind: "person", to: PERSON });
  });

  test("without write on the board it may not", async () => {
    const { t, owner, grok } = await setUp();
    await call(t, grok, "whoami", { agent: "chief_of_staff" });
    await owner.mutation(api.bots.update, {
      id: (await profileOf(t, "chief_of_staff"))._id,
      permissions: externalPermissions().map((p) => (p.area === "board" ? { area: "board", level: "read" as const } : p)),
    });
    const refused = await call(t, grok, "handoff_create", {
      agent: "chief_of_staff",
      company: "us",
      to: PERSON,
      title: "Made-up: no board",
      summary: "Made-up summary.",
    });
    expect(refused.refusal).toMatchObject({ code: "not_permitted" });
  });

  test("the near-duplicate check runs on a handoff to a person, and force passes it", async () => {
    const { t, grok } = await setUp();
    const hand = (extra: Record<string, unknown> = {}) =>
      call(t, grok, "handoff_create", {
        agent: "chief_of_staff",
        company: "us",
        to: PERSON,
        title: "Renew the made-up clinic's contract",
        summary: "Made-up summary.",
        ...extra,
      });
    const first = await hand();
    expect(first.output).toMatchObject({ created: true });
    const again = await hand();
    expect(again.said).toBe(DUPLICATE_WORDS.possible);
    expect(again.refusal).toMatchObject({ code: "possible_duplicate", matches: [{ type: "handoff", id: first.output.id }] });
    const forced = await hand({ force: true, forceReason: "Made-up: a second contract" });
    expect(forced.output).toMatchObject({ created: true, duplicateOf: [first.output.id] });
    const checks = await t.run((ctx) => ctx.db.query("duplicateChecks").collect());
    expect(checks.map((c) => [c.tool, c.decision])).toEqual([
      ["handoff_create", "clear"],
      ["handoff_create", "refused"],
      ["handoff_create", "forced"],
    ]);
  });
});

describe("goal fields through the attribution guard and the duplicate check (E with A and B)", () => {
  const goalArgs = (extra: Record<string, unknown> = {}) => ({
    agent: "strategy_advisor",
    company: "us",
    quarter: "2026-Q4",
    title: "Made-up: ten pilot clinics live",
    why: "Made-up why.",
    ownerBot: "strategy_advisor",
    target: "10 clinics",
    dueOn: "2026-12-31",
    ...extra,
  });

  test("goal_create with an owner bot, a target and a due day is refused under another bot's key", async () => {
    const { t, grok } = await setUp();
    const wrong = await call(t, grok, "goal_create", goalArgs({ dedupeKey: "growth:goal_create:pilots" }));
    expect(wrong.said).toBe(PROPOSAL_WORDS.attribution);
    expect(wrong.refusal).toEqual({ code: "attribution_mismatch", expected: "strategy_advisor", got: "growth" });
    expect(await proposalsOf(t)).toEqual([]);
  });

  test("goal_create with the fields is checked for near-duplicates, and forced it keeps them all", async () => {
    const { t, owner, grok } = await setUp();
    const taskId = await owner.mutation(api.tasks.create, { title: "Ten pilot clinics live", company: "us" });
    const near = await call(t, grok, "goal_create", goalArgs());
    expect(near.refusal).toMatchObject({ code: "possible_duplicate", matches: [{ type: "task", id: taskId }] });
    const forced = await call(t, grok, "goal_create", goalArgs({ force: true, forceReason: "Made-up: the goal, not the card" }));
    expect(forced.output).toMatchObject({ proposed: true });
    const [row] = await proposalsOf(t);
    expect(row).toMatchObject({
      kind: "goal_create",
      bot: "strategy_advisor",
      duplicateOf: [taskId],
      forceReason: "Made-up: the goal, not the card",
      payload: { quarter: "2026-Q4", title: "Made-up: ten pilot clinics live", ownerBot: "strategy_advisor", target: "10 clinics", dueOn: "2026-12-31" },
    });
    const checks = await t.run((ctx) => ctx.db.query("duplicateChecks").collect());
    expect(checks.map((c) => [c.tool, c.decision])).toEqual([
      ["goal_create", "refused"],
      ["goal_create", "forced"],
    ]);
  });

  test("goal_update of only the target and due day is held to the same guard and check", async () => {
    const { t, owner, grok } = await setUp();
    const goalId = (await owner.mutation(api.goals.create, { quarter: "2026-Q4", title: "Made-up: grow Globex", company: "us" })) as Id<"goals">;
    const update = (extra: Record<string, unknown>) =>
      call(t, grok, "goal_update", { agent: "strategy_advisor", company: "us", goalId, why: "Made-up why.", target: "v2 live at 3 pilot clinics", dueOn: "2026-12-31", ...extra });
    const wrong = await update({ dedupeKey: "bot-research:goal_update:x" });
    expect(wrong.refusal).toEqual({ code: "attribution_mismatch", expected: "strategy_advisor", got: "research" });
    const made = await update({});
    expect(made.output).toMatchObject({ proposed: true });
    const [row] = await proposalsOf(t);
    expect(row).toMatchObject({ kind: "goal_update", payload: { goalId, target: "v2 live at 3 pilot clinics", dueOn: "2026-12-31" } });
    const checks = await t.run((ctx) => ctx.db.query("duplicateChecks").collect());
    expect(checks.map((c) => [c.tool, c.decision])).toEqual([["goal_update", "clear"]]);
  });
});
