import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { BOT_WORDS, EXTERNAL_OWNER_AGENTS, type BotPermission } from "./lib/botRules";
import { DUPLICATE_WORDS } from "./lib/duplicates";
import { EXTERNAL_HANDOFF_IDS, HANDOFF_WORDS, callerName, handoffKey, sharedAgentWarning } from "./lib/handoffs";
import { OUTCOME_WORDS } from "./lib/outcomes";
import { ENTROPY, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, memberEmail, modules, signInWithAreas, type TestBackend } from "./test.setup";

// The security review of Bot Loop v3 (2026-10-19): each finding's scenario,
// reproduced through the endpoint as a bot would meet it. Every name, title
// and address is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, ids, owner, mac, grok: grok.token };
}

/** A bot of the owner's with exactly these permissions. */
async function botWith(t: TestBackend, owner: Awaited<ReturnType<typeof setUp>>["owner"], botId: string, permissions: BotPermission[]) {
  const { id } = await owner.mutation(api.bots.create, { botId, name: `Made-up ${botId}`, role: "Made-up" });
  await t.run((ctx) => ctx.db.patch(id, { permissions }));
  return id;
}

let keys = 0;
const proposeTask = (t: TestBackend, token: string, bot: string, title: string, extra: Record<string, unknown> = {}) =>
  call(t, token, "propose", {
    agent: bot,
    company: "us",
    kind: "task_create",
    why: "Made-up why.",
    dedupeKey: `${bot}:task_create:made-up-${(keys += 1)}`,
    payload: { title },
    ...extra,
  });

describe("possible_duplicate tells a bot only what it may read", () => {
  const CARD = "Renew the made-up insurance policy";

  test("a bot without board read is told a task match's type and score, never its title or id", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.tasks.create, { title: CARD, company: "us" });
    await botWith(t, owner, "scout", [{ area: "gtm", level: "write" }]);
    const near = await proposeTask(t, grok, "scout", "Renew made-up insurance policy");
    expect(near.said).toBe(DUPLICATE_WORDS.possible);
    expect(near.refusal).toEqual({ code: "possible_duplicate", matches: [{ type: "task", sim: expect.any(Number) }] });
    expect(near.text).not.toContain(CARD);
  });

  test("an open proposal's title and id never reach a bot, even one that reads the board", async () => {
    const { t, grok } = await setUp();
    const first = await proposeTask(t, grok, "growth", CARD);
    const id = first.output.id as string;
    const near = await proposeTask(t, grok, "research", "Renew made-up insurance policy");
    expect(near.refusal).toEqual({ code: "possible_duplicate", matches: [{ type: "proposal", sim: expect.any(Number) }] });
    expect(near.text).not.toContain(id);
    expect(near.text).not.toContain(CARD);
    // Forced, the id stays on the stored row for the owner's card, but is not handed back.
    const handoff = await call(t, grok, "task_create", {
      agent: "research",
      company: "us",
      title: "Renew made-up insurance policy",
      force: true,
      forceReason: "Made-up: a different policy",
    });
    expect(handoff.output).toMatchObject({ created: true });
    expect(handoff.text).not.toContain(id);
    const card = await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((row) => row.forceReason !== undefined)!);
    expect(card.duplicateOf).toEqual([id]);
  });

  test("a bot without sales read is told a deal match's type and score only; one with it gets the deal", async () => {
    const { t, ids, owner, grok } = await setUp();
    await botWith(t, owner, "scout", [{ area: "gtm", level: "write" }]);
    const dealPayload = { name: "Example US Deal" };
    const blind = await call(t, grok, "propose", {
      agent: "scout",
      company: "us",
      kind: "deal_create",
      why: "Made-up why.",
      dedupeKey: "scout:deal_create:one",
      payload: dealPayload,
    });
    expect(blind.refusal).toEqual({ code: "possible_duplicate", matches: [{ type: "deal", sim: 1 }] });
    expect(blind.text).not.toContain(ids.usDeal);
    const seeing = await call(t, grok, "propose", {
      agent: "growth",
      company: "us",
      kind: "deal_create",
      why: "Made-up why.",
      dedupeKey: "growth:deal_create:one",
      payload: dealPayload,
    });
    expect(seeing.refusal).toEqual({
      code: "possible_duplicate",
      matches: [{ type: "deal", id: ids.usDeal, title: "Example US Deal", sim: 1 }],
    });
  });

  test("a handoff match is the board's: a bot that reads it gets the title and id", async () => {
    const { t, grok } = await setUp();
    const first = await call(t, grok, "handoff_create", { agent: "growth", company: "us", to: "research", title: CARD, summary: "Made-up." });
    const near = await call(t, grok, "handoff_create", {
      agent: "growth",
      company: "us",
      to: "research",
      title: "Renew made-up insurance policy",
      summary: "Made-up.",
    });
    expect(near.refusal).toEqual({
      code: "possible_duplicate",
      matches: [{ type: "handoff", id: first.output.id, title: CARD, sim: expect.any(Number) }],
    });
  });

  test("the owner's own client (no bot) keeps full matches, proposals included", async () => {
    const { t, mac, grok } = await setUp();
    const first = await proposeTask(t, grok, "growth", CARD);
    const near = await proposeTask(t, mac, "chief_of_staff", "Renew made-up insurance policy");
    expect(near.refusal).toEqual({
      code: "possible_duplicate",
      matches: [{ type: "proposal", id: first.output.id, title: CARD, sim: expect.any(Number) }],
    });
  });
});

describe("an external owner-agent's profile is made switched off, and only after the client checks", () => {
  const profiles = (t: TestBackend) => t.run((ctx) => ctx.db.query("bots").collect());
  const external = async (t: TestBackend) => (await profiles(t)).find((b) => b.botId === "chief_of_staff") ?? null;

  test("a token made for another bot is refused before anything is made", async () => {
    const { t, owner } = await setUp();
    const growth = (await owner.query(api.bots.list, { today: "2026-10-14" })).bots.find((b) => b.botId === "growth")!;
    const { token } = await owner.mutation(api.bots.makeToken, { id: growth.id, entropy: ENTROPY });
    const task = await call(t, token, "task_create", { agent: "chief_of_staff", title: "Made-up card" });
    expect(task.refusal).toEqual({ code: "wrong_client" });
    const who = await call(t, token, "whoami", { agent: "chief_of_staff" });
    expect(who.refusal).toEqual({ code: "wrong_client" });
    expect(await external(t)).toBeNull();
  });

  test("named for the first time, it is made switched off and the bot is told the owner must switch it on", async () => {
    const { t, owner, grok } = await setUp();
    const first = await call(t, grok, "task_create", { agent: "chief_of_staff", title: "Made-up card" });
    expect(first.said).toBe(BOT_WORDS.externalOff);
    expect(first.refusal).toEqual({ code: "bot_off" });
    expect(await external(t)).toMatchObject({ enabled: false });
    expect((await t.run((ctx) => ctx.db.query("tasks").collect())).some((row) => row.title === "Made-up card")).toBe(false);
    expect((await call(t, grok, "whoami", { agent: "chief_of_staff" })).refusal).toEqual({ code: "bot_off" });
    // The owner switches it on, on the Bots tab: then it is the profile with its defaults.
    await owner.mutation(api.bots.update, { id: (await external(t))!._id, enabled: true });
    expect((await call(t, grok, "task_create", { agent: "chief_of_staff", title: "Made-up card" })).output).toMatchObject({ created: true });
  });

  test("the owner's own button makes it switched on", async () => {
    const { t, owner } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    expect(await external(t)).toMatchObject({ enabled: true });
  });

  test("removed, the next call does not bring it back switched on", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    expect((await call(t, grok, "tasks", { agent: "chief_of_staff" })).said).toBeNull();
    await owner.mutation(api.bots.remove, { id: (await external(t))!._id });
    expect((await call(t, grok, "task_create", { agent: "chief_of_staff", title: "Made-up card" })).refusal).toEqual({ code: "bot_off" });
    expect(await external(t)).toMatchObject({ enabled: false });
  });
});

describe("the external chief of staff answers handoffs as bot:chief_of_staff, never as the Mac's", () => {
  async function withExternal() {
    const world = await setUp();
    await world.owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    await world.owner.mutation(api.bots.addExternalProfile, { id: "engineering" });
    return world;
  }
  const hand = (t: TestBackend, token: string, to: unknown, title: string) =>
    call(t, token, "handoff_create", { agent: "growth", company: "us", to, title, summary: "Made-up." });

  test("a bare engineering id is stored for the bot profile, and my_inbox and handoff_update both accept it", async () => {
    const { t, grok } = await withExternal();
    const plain = await hand(t, grok, { type: "bot", id: "engineering" }, "Made-up partnerships estimate");
    expect(plain.output.warning).toBe(sharedAgentWarning("engineering"));
    const row = await t.run((ctx) => ctx.db.get(plain.output.id));
    expect(row).toMatchObject({ to: "bot:engineering", toKey: "bot:engineering" });
    const inbox = await call(t, grok, "my_inbox", { agent: "engineering" });
    expect(inbox.output.you).toBe("bot:engineering");
    expect(inbox.output.handoffs.map((h: { id: string; toRef: unknown }) => ({ id: h.id, toRef: h.toRef }))).toEqual([
      { id: plain.output.id, toRef: { type: "bot", id: "bot:engineering" } },
    ]);
    // The same handoff, seen through the list filtered by the bare slug.
    const listed = await call(t, grok, "handoffs", { agent: "growth", to: "engineering", status: "open" });
    expect(listed.output.rows.map((h: { id: string }) => h.id)).toEqual([plain.output.id]);
    expect((await call(t, grok, "handoff_update", { agent: "growth", id: plain.output.id, action: "accept" })).said).toBe(
      HANDOFF_WORDS.notYours,
    );
    expect((await call(t, grok, "handoff_update", { agent: "engineering", id: plain.output.id, action: "accept" })).output).toMatchObject({
      status: "accepted",
    });
  });

  test("a legacy row stored as plain engineering is in the bot's inbox and the bot can accept it", async () => {
    const { t, grok } = await withExternal();
    const id = await t.run((ctx) =>
      ctx.db.insert("handoffs", {
        company: "us",
        from: "growth",
        fromKey: "growth",
        to: "engineering",
        toKey: "engineering",
        title: "Made-up Brightline Data sandbox",
        summary: "Made-up.",
        links: [],
        status: "open",
        openSince: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        history: [{ at: NOW, by: "growth", action: "create" }],
      }),
    );
    const inbox = await call(t, grok, "my_inbox", { agent: "engineering" });
    expect(inbox.output.handoffs.map((h: { id: string }) => h.id)).toEqual([id]);
    expect((await call(t, grok, "handoff_update", { agent: "chief_of_staff", id, action: "accept" })).said).toBe(HANDOFF_WORDS.notYours);
    expect((await call(t, grok, "handoff_update", { agent: "engineering", id, action: "accept" })).output).toMatchObject({
      status: "accepted",
    });
  });

  test("the repair stores those open rows as the profile, and the bot can accept one", async () => {
    const { t, grok } = await withExternal();
    const id = await t.run((ctx) =>
      ctx.db.insert("handoffs", {
        company: "us",
        from: "growth",
        fromKey: "growth",
        to: "engineering",
        toKey: "engineering",
        title: "Made-up Oct 20 rules",
        summary: "Made-up.",
        links: [],
        status: "open",
        openSince: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        history: [{ at: NOW, by: "growth", action: "create" }],
      }),
    );
    expect(await t.mutation(internal.migrations.repairOpenHandoffAddressees, {})).toMatchObject({ changed: 1 });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ to: "bot:engineering", toKey: "bot:engineering", status: "open" });
    expect((await call(t, grok, "my_inbox", { agent: "engineering" })).output.handoffs.map((h: { id: string }) => h.id)).toEqual([id]);
    expect((await call(t, grok, "handoff_update", { agent: "engineering", id, action: "accept" })).output).toMatchObject({
      status: "accepted",
    });
  });

  test("the recipients list names an enabled external profile as bot:<id>", async () => {
    const { owner } = await withExternal();
    const ids = (await owner.query(api.handoffs.recipients, { company: "us" })).bots.map((b: { id: string }) => b.id);
    expect(ids).toContain("bot:engineering");
    expect(ids).toContain("bot:chief_of_staff");
    expect(ids).not.toContain("engineering");
  });

  test("mac:engineering is not the bot profile's", async () => {
    const { t, grok } = await withExternal();
    const made = await hand(t, grok, "mac:engineering", "Made-up work for the Mac agent");
    expect(made.output.warning).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(made.output.id))).toMatchObject({ to: "mac:engineering", toKey: "mac:engineering" });
    expect((await call(t, grok, "my_inbox", { agent: "engineering" })).output.handoffs).toEqual([]);
    expect((await call(t, grok, "handoff_update", { agent: "engineering", id: made.output.id, action: "accept" })).said).toBe(
      HANDOFF_WORDS.notYours,
    );
  });

  test("an id that matches two bot profiles is refused and stored nowhere", async () => {
    const { t, grok } = await withExternal();
    const research = (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === "research")!;
    await t.run((ctx) => ctx.db.patch(research._id, { name: "growth" }));
    const refused = await hand(t, grok, "growth", "Made-up ambiguous handoff");
    expect(refused.said).toBe(HANDOFF_WORDS.ambiguous);
    expect(refused.refusal).toEqual({ code: "ambiguous_addressee" });
    expect(await t.run((ctx) => ctx.db.query("handoffs").collect())).toEqual([]);
  });

  test("a handoff to bot:chief_of_staff is the external one's to answer, and it hands work on as bot:chief_of_staff", async () => {
    const { t, grok } = await withExternal();
    const external = await hand(t, grok, { type: "bot", id: "bot:chief_of_staff" }, "Made-up plan for the external one");
    expect(external.output.warning).toBeUndefined();
    const inbox = await call(t, grok, "my_inbox", { agent: "chief_of_staff" });
    expect(inbox.output.handoffs.map((h: { id: string }) => h.id)).toEqual([external.output.id]);
    expect((await call(t, grok, "handoff_update", { agent: "chief_of_staff", id: external.output.id, action: "accept" })).output).toMatchObject({
      status: "accepted",
    });
    const onward = await call(t, grok, "handoff_create", {
      agent: "chief_of_staff",
      company: "us",
      to: "growth",
      title: "Made-up onward work for growth",
      summary: "Made-up.",
    });
    const row = await t.run((ctx) => ctx.db.get(onward.output.id));
    expect(row).toMatchObject({ from: "bot:chief_of_staff", fromKey: "bot:chief_of_staff" });
  });

  test("no other name can take the external one's key: a client or bot written bot_chief_of_staff is someone else", () => {
    expect(handoffKey(callerName({ bot: "chief_of_staff" }))).toBe("bot:chief_of_staff");
    expect(handoffKey(callerName({ clientName: "bot:chief_of_staff" }))).not.toBe("bot:chief_of_staff");
    expect(handoffKey(callerName({ argument: "bot:chief_of_staff" }))).not.toBe("bot:chief_of_staff");
    expect(handoffKey("bot_chief_of_staff")).not.toBe(handoffKey("bot:chief_of_staff"));
    expect(handoffKey("chief_of_staff")).not.toBe(handoffKey("bot:chief_of_staff"));
    // Only the two external profiles have the form.
    expect(handoffKey("bot:growth")).toBe("bot_growth");
    expect([...EXTERNAL_HANDOFF_IDS]).toEqual([...EXTERNAL_OWNER_AGENTS]);
  });
});

describe("removing an external profile takes its own trust, never the Mac agent's", () => {
  test("bots.remove of chief_of_staff forgets bot:chief_of_staff's trust and grants and keeps the Mac's", async () => {
    const { t, owner } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const userId = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
    await t.run(async (ctx) => {
      for (const proposer of ["chief_of_staff", "bot:chief_of_staff"]) {
        await ctx.db.insert("autonomyGrants", { userId, proposer, kind: "task_create", grantedAt: NOW });
        await ctx.db.insert("botTrust", {
          proposer,
          kind: "task_create",
          streak: 3,
          approved: 3,
          edited: 0,
          dismissed: 0,
          autoApproved: 0,
          offerAt: 10,
          updatedAt: NOW,
        });
      }
    });
    const profile = (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === "chief_of_staff")!;
    await owner.mutation(api.bots.remove, { id: profile._id });
    const trust = await t.run((ctx) => ctx.db.query("botTrust").collect());
    expect(trust.map((row) => row.proposer)).toEqual(["chief_of_staff"]);
    const grants = await t.run((ctx) => ctx.db.query("autonomyGrants").collect());
    expect(grants.map((g) => [g.proposer, g.revokedAt === undefined])).toEqual([
      ["chief_of_staff", true],
      ["bot:chief_of_staff", false],
    ]);
  });
});

describe("a person's address in a handoff's history reaches only a bot that may give them work", () => {
  const PERSON = memberEmail("sales", ["us"]);

  async function answered() {
    const world = await setUp();
    const person = await signInWithAreas(world.t, "sales", ["board"], ["us"]);
    const made = await call(world.t, world.grok, "handoff_create", {
      agent: "support",
      company: "us",
      to: PERSON,
      title: "Made-up clinic asks for a call",
      summary: "Made-up.",
    });
    await person.mutation(api.handoffs.answer, { id: made.output.id, action: "done", note: "Made-up: called them." });
    return { ...world, id: made.output.id as string };
  }

  test("a bot without board write is told 'a person' in the history, and its address filter is ignored", async () => {
    const { t, owner, grok } = await answered();
    await botWith(t, owner, "scout", [{ area: "board", level: "read" }]);
    const all = await call(t, grok, "handoffs", { agent: "scout" });
    expect(all.text).not.toContain(PERSON);
    const row = all.output.rows[0];
    expect(row.history.map((h: { by: string }) => h.by)).toEqual(["support", "a person"]);
    // Filtering by the address would tell it who has a handoff: the filter is left out.
    const filtered = await call(t, grok, "handoffs", { agent: "scout", to: PERSON });
    expect(filtered.output.rows).toEqual(all.output.rows);
    const nobody = await call(t, grok, "handoffs", { agent: "scout", to: "made-up.nobody@example.com" });
    expect(nobody.output.rows).toEqual(all.output.rows);
  });

  test("the bot that handed it, with board write, still sees the address; without it, my_inbox hides it too", async () => {
    const { t, owner, grok } = await answered();
    const seen = await call(t, grok, "handoffs", { agent: "support" });
    expect(seen.output.rows[0].history.map((h: { by: string }) => h.by)).toEqual(["support", PERSON]);
    expect((await call(t, grok, "my_inbox", { agent: "support" })).output.handoffs_completed).toEqual([
      expect.objectContaining({ by: PERSON }),
    ]);
    const support = (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === "support")!;
    await t.run((ctx) =>
      ctx.db.patch(support._id, { permissions: support.permissions.map((p) => (p.area === "board" ? { ...p, level: "read" as const } : p)) }),
    );
    const inbox = await call(t, grok, "my_inbox", { agent: "support" });
    expect(inbox.text).not.toContain(PERSON);
    expect(inbox.output.handoffs_completed).toEqual([expect.objectContaining({ by: "a person" })]);
    // The page, for whoever holds the board, keeps every address.
    expect(JSON.stringify(await owner.query(api.handoffs.list, {}))).toContain(PERSON);
  });
});

describe("goals tells a bot a goal owner's address only when it may give them work", () => {
  const PERSON = memberEmail("sales", ["us"]);

  async function withOwnedGoal() {
    const world = await setUp();
    await signInWithAreas(world.t, "sales", ["board"], ["us"]);
    await world.t.run((ctx) =>
      ctx.db.insert("goals", { quarter: "2026-Q4", title: "Made-up goal", status: "on_track", order: 0, company: "us", ownerEmail: PERSON }),
    );
    return world;
  }

  test("a bot without board write gets the owner's name, never the address", async () => {
    const { t, owner, grok } = await withOwnedGoal();
    // Read on the board opens goals (as the page), and is not write: no address.
    await botWith(t, owner, "scout", [{ area: "board", level: "read" }]);
    const read = await call(t, grok, "goals", { agent: "scout" });
    expect(read.text).not.toContain(PERSON);
    const goal = read.output.rows.find((row: { title: string }) => row.title === "Made-up goal");
    expect(goal.owner).toEqual({ name: null });
  });

  test("a bot with board write, and the owner's own client, get the address as people does", async () => {
    const { t, mac, grok } = await withOwnedGoal();
    const ownerOf = (rows: { title: string; owner: unknown }[]) => rows.find((row) => row.title === "Made-up goal")!.owner;
    expect(ownerOf((await call(t, grok, "goals", { agent: "research" })).output.rows)).toMatchObject({ email: PERSON });
    expect(ownerOf((await call(t, mac, "goals", {})).output.rows)).toMatchObject({ email: PERSON });
  });
});

describe("a handoff to a person carries no contact details to the company's group", () => {
  const PERSON = memberEmail("sales", ["us"]);
  const hand = (t: TestBackend, token: string, to: string, title: string, summary: string) =>
    call(t, token, "handoff_create", { agent: "support", company: "us", to, title, summary });

  test("an email address or phone number in the title or summary is refused, coded, and nothing is sent", async () => {
    const { t, grok } = await setUp();
    await signInWithAreas(t, "sales", ["board"], ["us"]);
    for (const [title, summary] of [
      ["Made-up: write to made-up.clinic@example.com", "Made-up."],
      ["Made-up clinic asks for a call", "Made-up: call them on +1 555 010 0199 today."],
    ]) {
      const refused = await hand(t, grok, PERSON, title!, summary!);
      expect(refused.said).toBe(HANDOFF_WORDS.contact);
      expect(refused.refusal).toEqual({ code: "contact_detail" });
    }
    expect(await t.run((ctx) => ctx.db.query("handoffs").collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("notifications").collect())).filter((row) => row.kind === "handoff")).toEqual([]);
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.filter((row) => row.refusal?.code === "contact_detail")).toHaveLength(2);
  });

  test("the same words to a person without them, or to a bot, go through as before", async () => {
    const { t, grok } = await setUp();
    await signInWithAreas(t, "sales", ["board"], ["us"]);
    expect((await hand(t, grok, PERSON, "Made-up clinic asks for a call", "Made-up: a demo on Thursday.")).output).toMatchObject({ created: true });
    expect((await hand(t, grok, "growth", "Made-up: lead made-up.lead@example.com", "Made-up.")).output).toMatchObject({ created: true });
  });
});

describe("outcomes are read only with their subject's own area too", () => {
  async function logged() {
    const world = await setUp();
    const partner = await world.t.run((ctx) =>
      ctx.db.insert("partners", { company: "us", name: "Made-up Partner", type: "referral", stage: "contacted", order: 0 }),
    );
    const log = (bot: string, subject: { kind: string; id: string }, play: string) =>
      call(world.t, world.grok, "outcome_log", {
        agent: bot,
        company: "us",
        subject,
        play,
        result: "worked",
        evidence: "Made-up evidence.",
        actedOn: "2026-10-10",
      });
    expect((await log("growth", { kind: "deal", id: world.ids.usDeal }, "made-up deal play")).output).toMatchObject({ created: true });
    expect((await log("partnerships", { kind: "partner", id: partner }, "made-up partner play")).output).toMatchObject({ created: true });
    return { ...world, partner };
  }

  test("a deal's timeline is empty to someone with outcomes but not sales", async () => {
    const { t, ids } = await logged();
    const blind = await signInWithAreas(t, "engineer", ["outcomes"], ["us"]);
    expect(await blind.query(api.outcomes.forSubject, { kind: "deal", id: ids.usDeal })).toEqual([]);
    const seller = await signInWithAreas(t, "sales", ["outcomes", "sales"], ["us"]);
    expect(await seller.query(api.outcomes.forSubject, { kind: "deal", id: ids.usDeal })).toHaveLength(1);
  });

  test("the outcomes tool gives a bot only the subjects it reads, and tallies only those", async () => {
    const { t, owner, grok } = await logged();
    await botWith(t, owner, "scout", [
      { area: "outcomes", level: "read" },
      { area: "partnerships", level: "read" },
    ]);
    const read = await call(t, grok, "outcomes", { agent: "scout" });
    expect(read.output.rows.map((row: { subject: { kind: string } }) => row.subject.kind)).toEqual(["partner"]);
    expect(read.output.plays.map((p: { play: string }) => p.play)).toEqual(["made-up partner play"]);
    // Growth reads sales and partnerships: both.
    expect((await call(t, grok, "outcomes", { agent: "growth" })).output.rows).toHaveLength(2);
  });

  test("outcome_log's proposalId must be that company's, refused in the words of one that is gone", async () => {
    const { t, ids, grok } = await logged();
    const proposal = (company: "us" | "kz") =>
      t.run((ctx) =>
        ctx.db.insert("proposals", {
          agent: "chief_of_staff",
          bot: "growth",
          kind: "task_create",
          company,
          reason: "Made-up",
          payload: { title: `Made-up ${company} card` },
          dedupeKey: `growth:task_create:${company}`,
          status: "open",
          createdAt: NOW,
          editedBeforeApprove: false,
        }),
      );
    const args = (proposalId: string) => ({
      agent: "growth",
      company: "us",
      subject: { kind: "deal", id: ids.usDeal },
      play: "made-up follow-up",
      result: "pending",
      evidence: "Made-up.",
      actedOn: "2026-10-10",
      proposalId,
    });
    const other = await call(t, grok, "outcome_log", args(await proposal("kz")));
    expect(other.said).toBe(OUTCOME_WORDS.proposalGone);
    expect((await call(t, grok, "outcome_log", args(await proposal("us")))).output).toMatchObject({ created: true });
  });
});
