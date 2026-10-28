import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AGENT_WORDS } from "./lib/agentRules";
import {
  BOT_AREAS,
  BOT_WORDS,
  DEFAULT_BOT_LIMITS,
  EVERY_BOT_TOOLS,
  LOCKED_BOT_AREAS,
  SUGGESTED_BOTS,
  botMayCall,
  defaultPermissions,
  externalPermissions,
  limitWords,
  suggestedPermissions,
} from "./lib/botRules";
import { STARTUP_OS_TOOL_AREAS } from "./lib/agentStartupOs";
import { AGENT_HEADER, OS_AGENT_WORDS } from "./lib/osAgents";
import { AREAS } from "./lib/roles";
import { ENTROPY, NOW, SAM, TODAY, addSam, call, ownerWithToken, rpc } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, signInAsMember, type TestBackend } from "./test.setup";

// The owner's bots: external bots that call /mcp/v1 through a connected
// client and name themselves. Each is held to its own permissions (never a
// locked area), its client's scope and its own limits; a name Startup OS does
// not know is refused; Startup OS's own four keep their rules. Made-up names.

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
  const reader = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "read", name: "Read bot" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, mac, grok: grok.token, grokId: grok.id, reader: reader.token };
}

const listed = async (t: TestBackend, token: string, headers: Record<string, string>) =>
  ((await rpc(t, token, "tools/list", {}, headers)).body.result!.tools as { name: string }[]).map((tool) => tool.name);

const botOf = async (t: TestBackend, botId: string) =>
  (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === botId)!;

describe("the rules", () => {
  test("no locked area is a bot area, and a tool of one is no bot's at any level", () => {
    for (const area of LOCKED_BOT_AREAS) expect(BOT_AREAS).not.toContain(area);
    expect(LOCKED_BOT_AREAS).toEqual(expect.arrayContaining(["payroll", "costs", "settings", "team", "personal", "admin"]));
    const all = AREAS.map((area) => ({ area, level: "write" })) as never;
    for (const [tool, area] of Object.entries(STARTUP_OS_TOOL_AREAS)) {
      if (!(LOCKED_BOT_AREAS as readonly string[]).includes(area)) continue;
      // `propose` only stores a proposal for the owner: any bot that writes somewhere may.
      // `proposal_withdraw` takes back only the caller's own proposals: held to the same.
      // `proposal_sweep` clears duplicates. `proposal_decide` carries one out, but only for the chief of staff, checked in the tool.
      if (tool === "propose" || tool === "proposal_withdraw" || tool === "proposal_sweep" || tool === "proposal_decide") continue;
      // A bot's own (asking for a permission, its inbox, its feedback): every known bot's.
      if (EVERY_BOT_TOOLS.includes(tool)) continue;
      expect(botMayCall(all, tool, "read")).toBe(false);
      expect(botMayCall(all, tool, "act")).toBe(false);
    }
    expect(botMayCall(all, "propose", "act")).toBe(true);
    expect(botMayCall([] as never, "proposals_feedback", "read")).toBe(true);
    expect(botMayCall(AREAS.map((area) => ({ area, level: "read" })) as never, "propose", "act")).toBe(false);
    expect(botMayCall(all, "proposal_withdraw", "act")).toBe(true);
    expect(botMayCall(AREAS.map((area) => ({ area, level: "read" })) as never, "proposal_withdraw", "act")).toBe(false);
    expect(botMayCall(all, "proposal_sweep", "act")).toBe(true);
    expect(botMayCall(AREAS.map((area) => ({ area, level: "read" })) as never, "proposal_sweep", "act")).toBe(false);
    expect(botMayCall([{ area: "sales", level: "write" }] as never, "comment_create", "act")).toBe(true);
    expect(botMayCall([{ area: "gtm", level: "write" }] as never, "comment_create", "act")).toBe(false);
    expect(botMayCall(all, "proposal_decide", "act")).toBe(true);
    expect(botMayCall(AREAS.map((area) => ({ area, level: "read" })) as never, "proposal_decide", "act")).toBe(false);
    // A tool with no area (a runner's) is no bot's.
    expect(botMayCall(all, "chat_next", "act")).toBe(false);
  });

  test("a new bot reads every bot area and writes none", () => {
    expect(defaultPermissions().every((p) => p.level === "read")).toBe(true);
    expect(DEFAULT_BOT_LIMITS).toEqual({ proposalsPerDay: 200, changesPer10Min: 120, callsPer10Min: 600 });
  });

  test("no default gives a bot Contacts: real people's addresses are ticked for a bot by name", () => {
    expect(BOT_AREAS).toContain("contacts");
    expect(defaultPermissions().map((p) => p.area)).not.toContain("contacts");
    expect(externalPermissions().map((p) => p.area)).not.toContain("contacts");
    for (const bot of SUGGESTED_BOTS) expect(suggestedPermissions(bot).map((p) => p.area)).not.toContain("contacts");
    // Every other bot area a new bot still reads.
    expect(defaultPermissions().map((p) => p.area)).toEqual(BOT_AREAS.filter((area) => area !== "contacts"));
  });

  test("every suggested write is an area that exists and a bot may hold", () => {
    for (const bot of SUGGESTED_BOTS) for (const area of bot.write) expect(BOT_AREAS).toContain(area);
  });
});

describe("identity", () => {
  test("an unknown bot is refused with words that say where to add it, and is listed nothing", async () => {
    const { t, grok } = await setUp();
    const byArg = await call(t, grok, "goals", { agent: "made_up_bot" });
    expect(byArg.said).toBe(BOT_WORDS.unknown);
    const byHeader = await call(t, grok, "goals", {}, { [AGENT_HEADER]: "made_up_bot" });
    expect(byHeader.said).toBe(BOT_WORDS.unknown);
    expect(await call(t, grok, "goals", { agent: "Not A Name!" })).toMatchObject({ said: BOT_WORDS.unknown });
    expect(await listed(t, grok, { [AGENT_HEADER]: "made_up_bot" })).toEqual([]);
    // Nothing the call sent is written on the audit.
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(JSON.stringify(rows)).not.toContain("made_up_bot");
  });

  test("a known bot is admitted by the argument or the header, and its `agent` never reaches the tool", async () => {
    const { t, grok } = await setUp();
    const made = await call(t, grok, "task_create", { agent: "fundraising", title: "Made-up investor follow-up" });
    expect(made.output).toMatchObject({ created: true });
    const byHeader = await call(t, grok, "task_create", { title: "Made-up second task" }, { [AGENT_HEADER]: "fundraising" });
    expect(byHeader.output).toMatchObject({ created: true });
    // Two names that differ are refused.
    expect((await call(t, grok, "goals", { agent: "growth" }, { [AGENT_HEADER]: "fundraising" })).said).toBe(BOT_WORDS.wrongAgent);
    // The audit names the bot.
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.filter((row) => row.bot === "fundraising")).toHaveLength(2);
  });

  test("a bot switched off, or named through a client it may not use, is refused", async () => {
    const { t, owner, mac, grok, grokId } = await setUp();
    const growth = await botOf(t, "growth");
    await owner.mutation(api.bots.update, { id: growth._id, clients: [{ kind: "token", id: grokId as string }] });
    expect((await call(t, mac, "goals", { agent: "growth" })).said).toBe(BOT_WORDS.wrongClient);
    expect((await call(t, grok, "goals", { agent: "growth" })).output).not.toBeNull();
    await owner.mutation(api.bots.update, { id: growth._id, enabled: false });
    expect((await call(t, grok, "goals", { agent: "growth" })).said).toBe(BOT_WORDS.off);
  });

  test("the four agents keep their rules exactly: sales still may not add a task", async () => {
    const { t, owner, grok, grokId } = await setUp();
    // Through a client that is not bots-only (botsOnly.test.ts has the refusal when it is).
    await owner.mutation(api.assistant.setBotsOnly, { kind: "token", id: grokId as string, on: false });
    expect((await call(t, grok, "task_create", { title: "Made-up" }, { [AGENT_HEADER]: "sales" })).said).toBe(
      OS_AGENT_WORDS.notAllowedTool("sales"),
    );
    expect((await call(t, grok, "deals", {}, { [AGENT_HEADER]: "sales" })).output).not.toBeNull();
    // A call naming nobody keeps the client's own behaviour.
    expect((await call(t, grok, "task_create", { title: "Made-up plain" })).output).toMatchObject({ created: true });
  });
});

describe("permissions", () => {
  test("a bot may not exceed its own: Partnerships reads deals, may not change one, and is listed accordingly", async () => {
    const { t, grok } = await setUp();
    expect((await call(t, grok, "deals", { agent: "partnerships" })).output).not.toBeNull();
    expect((await call(t, grok, "deal_update", { agent: "partnerships", dealId: "x", nextStep: "Made-up" })).said).toBe(
      BOT_WORDS.notAllowed,
    );
    // Not given customers: refused.
    expect((await call(t, grok, "customers", { agent: "partnerships" })).said).toBe(BOT_WORDS.notAllowed);
    const names = await listed(t, grok, { [AGENT_HEADER]: "partnerships" });
    expect(names).toEqual(expect.arrayContaining(["deals", "task_create"]));
    for (const never of ["deal_update", "customers", "overview", "costs", "sources", "brief_write"]) {
      expect(names).not.toContain(never);
    }
  });

  test("a bot may not exceed its client's scope: a read-only client never acts", async () => {
    const { t, reader } = await setUp();
    expect((await call(t, reader, "task_create", { agent: "fundraising", title: "Made-up" })).said).toBe(AGENT_WORDS.readOnly);
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    expect(await listed(t, reader, { [AGENT_HEADER]: "fundraising" })).not.toContain("task_create");
  });

  test("a locked area is never granted, by the page or a crafted call", async () => {
    const { t, owner } = await setUp();
    const research = await botOf(t, "research");
    for (const area of ["payroll", "costs", "settings", "team", "personal", "admin", "today"]) {
      await expect(
        owner.mutation(api.bots.update, { id: research._id, permissions: [{ area, level: "read" }] }),
      ).rejects.toThrow(BOT_WORDS.locked);
      await expect(
        owner.mutation(api.bots.create, { botId: "crafted", name: "Crafted", role: "", permissions: [{ area, level: "write" }] }),
      ).rejects.toThrow(BOT_WORDS.locked);
    }
    // Nor written past the functions: the schema does not hold one.
    await expect(
      t.run((ctx) => ctx.db.patch(research._id, { permissions: [{ area: "costs" as never, level: "read" }] })),
    ).rejects.toThrow();
    // And a teammate cannot reach the functions at all.
    const sam = await signInAsMember(t, "cofounder", ["us"]);
    await expect(sam.mutation(api.bots.addSuggested, {})).rejects.toThrow();
    await expect(sam.query(api.bots.list, { today: TODAY })).rejects.toThrow();
  });

  test("a reserved id or a malformed one cannot be a bot", async () => {
    const { owner } = await setUp();
    await expect(owner.mutation(api.bots.create, { botId: "finance", name: "X", role: "" })).rejects.toThrow(BOT_WORDS.reserved);
    await expect(owner.mutation(api.bots.create, { botId: "Bad Id", name: "X", role: "" })).rejects.toThrow(BOT_WORDS.badId);
    await expect(owner.mutation(api.bots.create, { botId: "growth", name: "X", role: "" })).rejects.toThrow(BOT_WORDS.taken);
  });
});

describe("limits", () => {
  test("each bot's own: one at its limit does not stop another, and the refusal names the limit and the reset", async () => {
    const { t, owner, grok } = await setUp();
    const research = await botOf(t, "research");
    await owner.mutation(api.bots.update, { id: research._id, limits: { ...DEFAULT_BOT_LIMITS, callsPer10Min: 2 } });
    for (let n = 0; n < 2; n++) expect((await call(t, grok, "goals", { agent: "research" })).output).not.toBeNull();
    const over = await call(t, grok, "goals", { agent: "research" });
    // A bot's limit is a tool error it can read, with its code (convex/botRefusals.test.ts).
    expect(over.error).toBeNull();
    expect(over.said).toBe(limitWords("calls", 2, NOW + 10 * 60 * 1000));
    expect(over.said).toContain("06:10 UTC");
    // Another bot on the same client goes on.
    expect((await call(t, grok, "goals", { agent: "growth" })).output).not.toBeNull();
    // The window closes.
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    expect((await call(t, grok, "goals", { agent: "research" })).output).not.toBeNull();
  });

  test("changes are limited per bot too", async () => {
    const { t, owner, grok } = await setUp();
    const growth = await botOf(t, "growth");
    await owner.mutation(api.bots.update, { id: growth._id, limits: { ...DEFAULT_BOT_LIMITS, changesPer10Min: 1 } });
    expect((await call(t, grok, "task_create", { agent: "growth", title: "Made-up one" })).output).toMatchObject({ created: true });
    expect((await call(t, grok, "task_create", { agent: "growth", title: "Made-up two" })).said).toBe(
      limitWords("changes", 1, NOW + 10 * 60 * 1000),
    );
    expect((await call(t, grok, "task_create", { agent: "linkedin", title: "Made-up three" })).output).toMatchObject({ created: true });
  });

  test("the Bots list counts each bot's calls and refusals today, and when it last called", async () => {
    const { t, owner, grok } = await setUp();
    await call(t, grok, "support", { agent: "support" });
    await call(t, grok, "deals", { agent: "support" });
    const { bots, suggestedMissing } = await owner.query(api.bots.list, { today: TODAY });
    expect(suggestedMissing).toBe(0);
    const support = bots.find((b) => b.botId === "support")!;
    expect(support).toMatchObject({ callsToday: 2, refusalsToday: 1, lastCallAt: NOW, suggested: true });
    // Its audit rows carry its name.
    const recent = await owner.query(api.assistant.recentCalls, {});
    expect(recent.filter((row) => row.bot === "Support Bot")).toHaveLength(2);
    // Editing it takes the suggested mark away.
    await owner.mutation(api.bots.update, { id: support.id as Id<"bots">, role: "Made-up support" });
    expect((await owner.query(api.bots.list, { today: TODAY })).bots.find((b) => b.botId === "support")!.suggested).toBe(false);
  });
});

describe("what a bot is told", () => {
  test("budget: a bot is given no cost data (no run-rate, no register's cash due, no typed cost or pay cell), but keeps cash and runway", async () => {
    const { t, owner, grok, grokId } = await setUp();
    await owner.mutation(api.costs.add, {
      company: "kz",
      name: "Example KZ Tool",
      category: "software",
      amount: 40_000_00,
      cadence: "monthly",
      startsOn: "2026-05",
      variable: false,
    });
    await owner.mutation(api.budget.setCells, {
      company: "kz",
      cells: [
        { month: "2026-09", category: "payroll", amount: 900_000_00 },
        { month: "2026-09", category: "software", amount: 55_000_00 },
      ],
    });
    // The owner's own client is told the cost data.
    await owner.mutation(api.assistant.setBotsOnly, { kind: "token", id: grokId as string, on: false });
    const plain = (await call(t, grok, "budget", { company: "kz", month: "2026-10" })).output as {
      reports: { costs: string; categories: unknown; months: { month: string; plan: number | null }[] }[];
    };
    expect(plain.reports[0]!.costs).toBe("shown");
    expect(plain.reports[0]!.categories).not.toBeNull();

    // A bot holding finance read, whatever the owner behind the client holds.
    const bot = (await call(t, grok, "budget", { company: "kz", month: "2026-10", agent: "research" })).output as {
      reports: { costs: string; payroll: string; categories: unknown; start: unknown; months: { month: string; plan: number | null }[] }[];
    };
    const report = bot.reports[0]!;
    expect(report.costs).toBe("hidden");
    expect(report.payroll).toBe("hidden");
    expect(report.categories).toBeNull();
    expect(report.start).toBeDefined();
    for (const month of report.months) expect(month.plan).toBeNull();
    const text = JSON.stringify(bot);
    for (const amount of [String(40_000_00), String(55_000_00), String(900_000_00)]) expect(text).not.toContain(amount);
  });
});


describe("one name, one bot", () => {
  test("a bot whose id or name is another's written differently is refused, on create and on update", async () => {
    const { owner, t } = await setUp();
    // "growth_bot" is how "Growth Bot" (Growth's name) is written as a key.
    await expect(owner.mutation(api.bots.create, { botId: "growth_bot", name: "X", role: "" })).rejects.toThrow(BOT_WORDS.keyTaken);
    await expect(owner.mutation(api.bots.create, { botId: "made_up", name: "Research Bot", role: "" })).rejects.toThrow(
      BOT_WORDS.keyTaken,
    );
    await expect(owner.mutation(api.bots.create, { botId: "made_up", name: "GROWTH", role: "" })).rejects.toThrow(BOT_WORDS.keyTaken);
    // Nor one of the four, written another way.
    await expect(owner.mutation(api.bots.create, { botId: "chief-of-staff", name: "X", role: "" })).rejects.toThrow(
      BOT_WORDS.reserved,
    );
    const fundraising = await botOf(t, "fundraising");
    await expect(owner.mutation(api.bots.update, { id: fundraising._id, name: "growth" })).rejects.toThrow(BOT_WORDS.keyTaken);
    // A bot's own id and name may share a key.
    await owner.mutation(api.bots.update, { id: fundraising._id, name: "Fundraising" });
    await owner.mutation(api.bots.create, { botId: "made_up", name: "Made Up", role: "" });
  });
});

describe("a token for one bot", () => {
  test("is bots-only, made for that bot alone, and becomes the bot's only client", async () => {
    const { t, owner, grok } = await setUp();
    const research = await botOf(t, "research");
    const made = await owner.mutation(api.bots.makeToken, { id: research._id, entropy: ENTROPY });
    expect(made.token).toMatch(/^sosa_/);
    const row = (await owner.query(api.assistant.clients, {})).find((c) => c.id === made.id)!;
    expect(row).toMatchObject({ name: "Research Bot", botsOnly: true, onlyBot: "research", runner: false });
    expect((await botOf(t, "research")).clients).toEqual([{ kind: "token", id: made.id }]);
    // Research comes through it; through the shared client it no longer may.
    expect((await call(t, made.token, "goals", { agent: "research" })).output).not.toBeNull();
    expect((await call(t, grok, "goals", { agent: "research" })).said).toBe(BOT_WORDS.wrongClient);
    // No other bot may use it, even one allowed on any client, and no call without a name.
    expect((await call(t, made.token, "goals", { agent: "growth" })).said).toBe(BOT_WORDS.tokenForBot);
    expect(((await rpc(t, made.token, "tools/list", {}, { [AGENT_HEADER]: "growth" })).body.result!.tools as unknown[])).toEqual([]);
    expect((await call(t, made.token, "goals", {})).said).toBe(BOT_WORDS.botsOnly);
    // A bot that writes nothing gets a read-only token.
    const support = await botOf(t, "support");
    await owner.mutation(api.bots.update, { id: support._id, permissions: [{ area: "support", level: "read" }] });
    const reader = await owner.mutation(api.bots.makeToken, { id: support._id, entropy: ENTROPY });
    expect((await owner.query(api.assistant.clients, {})).find((c) => c.id === reader.id)!.scope).toBe("read");
    // The owner's alone.
    const sam = await signInAsMember(t, "cofounder", ["us"]);
    await expect(sam.mutation(api.bots.makeToken, { id: research._id, entropy: ENTROPY })).rejects.toThrow();
  });
});

describe("a new token for one bot", () => {
  test("revokes the bot's previous token made for it alone, and only that bot's", async () => {
    const { t, owner } = await setUp();
    const research = await botOf(t, "research");
    const growth = await botOf(t, "growth");
    const first = await owner.mutation(api.bots.makeToken, { id: research._id, entropy: ENTROPY });
    const other = await owner.mutation(api.bots.makeToken, { id: growth._id, entropy: `${ENTROPY}-growth` });
    expect((await call(t, first.token, "goals", { agent: "research" })).output).not.toBeNull();

    const second = await owner.mutation(api.bots.makeToken, { id: research._id, entropy: `${ENTROPY}-again` });
    expect(second.revoked).toBe(1);
    const ids = (await owner.query(api.assistant.clients, {})).map((c) => c.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids).toContain(other.id);
    // The old one is refused like any unknown credential; the new one and Growth's still work.
    expect((await rpc(t, first.token, "tools/list", {}, { [AGENT_HEADER]: "research" })).status).toBe(401);
    expect((await call(t, second.token, "goals", { agent: "research" })).output).not.toBeNull();
    expect((await call(t, other.token, "goals", { agent: "growth" })).output).not.toBeNull();
  });
});

describe("people", () => {
  test("a bot that may give tasks (write on board) is told addresses; one that only reads the board, names only", async () => {
    const { t, owner, grok } = await setUp();
    await addSam(t);
    const research = (await call(t, grok, "people", { agent: "research" })).output as { rows: { email?: string; name: string | null }[] };
    expect(research.rows.map((row) => row.email)).toContain(SAM);
    const support = await botOf(t, "support");
    await owner.mutation(api.bots.update, { id: support._id, permissions: [{ area: "board", level: "read" }] });
    const reader = await call(t, grok, "people", { agent: "support" });
    const rows = (reader.output as { rows: Record<string, unknown>[] }).rows;
    expect(rows.map((row) => row.name)).toContain("Sam Teammate");
    for (const row of rows) expect(Object.keys(row)).toEqual(["name"]);
    expect(reader.text).not.toContain("@");
    // A person with no name on record is not listed by address in its place.
    expect(rows.every((row) => row.name !== null)).toBe(true);
  });
});

describe("a bot on a client that cannot send a header (the Grok app)", () => {
  test("every tool it is listed has an `agent` field for its id", async () => {
    const { t, grok } = await setUp();
    const tools = (await rpc(t, grok, "tools/list", {})).body.result!.tools as {
      name: string;
      inputSchema: { properties?: Record<string, { description?: string }> };
    }[];
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      expect(tool.inputSchema.properties?.agent, tool.name).toBeDefined();
      expect(tool.inputSchema.properties!.agent!.description, tool.name).toMatch(/bot id/);
    }
  });

  test("its id in the `agent` argument works on a tool with no `agent` of its own", async () => {
    const { t, grok } = await setUp();
    expect((await call(t, grok, "deals", { agent: "growth" })).output).not.toBeNull();
    expect((await call(t, grok, "goals", { agent: "growth" })).output).not.toBeNull();
  });

  test("a bot that writes somewhere may propose; the proposal is its own and waits for the owner", async () => {
    const { t, grok } = await setUp();
    const made = await call(t, grok, "propose", {
      agent: "growth",
      company: "us",
      kind: "task_create",
      reason: "Made-up: follow up the sample lead.",
      dedupeKey: "growth:task_create:sample-lead",
      payload: { title: "Made-up follow-up" },
    });
    expect(made.said ?? null).toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("proposals").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bot: "growth", status: "open" });
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
  });
});
