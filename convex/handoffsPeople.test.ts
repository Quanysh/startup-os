import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { handoffRefusalOf } from "./lib/botRules";
import { HANDOFF_WORDS, PERSON_HANDOFFS_PER_DAY, partyOf, sharedAgentWarning } from "./lib/handoffs";
import { handoffMessage } from "./lib/telegramMessage";
import { NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, memberEmail, modules, signInWithAreas, type TestBackend } from "./test.setup";
import { finishScheduled } from "./test.timers";

// Handoffs to people (Bot Loop v3, D): a bot with write on the board hands work
// to a person of that company, who is told in the app and the company's
// Telegram group, answers on /handoffs, and the bot hears the outcome in
// `my_inbox`. `fetch` is a stub; nothing here reaches Telegram. Every name and
// address is made up.

const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";
const HOUR = 60 * 60 * 1000;
/** A teammate on Startup with the board: the person handed to. */
const BAHRAM = memberEmail("sales", ["us"]);

type Sent = { url: string; body: Record<string, unknown> };
function stubFetch(): Sent[] {
  const calls: Sent[] = [];
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
  // Off unless a test turns it on: nothing is left scheduled past a test.
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world() {
  const t = convexTest(schema, modules);
  await seed(t);
  const { owner, token } = await ownerWithToken(t, "act");
  await owner.mutation(api.bots.addSuggested, {});
  const bahram = await signInWithAreas(t, "sales", ["board"], ["us"]);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramSettings", { enabled: true, chatUs: { id: "-1001", title: "Startup team" } });
  });
  return { t, owner, token, bahram };
}

const hand = (t: TestBackend, token: string, args: Record<string, unknown> = {}) =>
  call(t, token, "handoff_create", {
    company: "us",
    to: BAHRAM,
    title: "Clinic asks for a call",
    summary: "They want a demo on Thursday.",
    agent: "support",
    ...args,
  });

const notes = (t: TestBackend) => t.run((ctx) => ctx.db.query("notifications").collect());

describe("handoff_create to a person", () => {
  test("an address of that company's people, as a string or {type: person}, is a person", async () => {
    const { t, token } = await world();
    const made = await hand(t, token);
    expect(made.output).toMatchObject({ created: true });
    await hand(t, token, { to: { type: "person", email: BAHRAM.toUpperCase() }, title: "Second" });
    const rows = (await call(t, token, "handoffs", { agent: "support" })).output.rows;
    expect(rows.map((r: { toRef: unknown }) => r.toRef)).toEqual([
      { type: "person", email: BAHRAM },
      { type: "person", email: BAHRAM },
    ]);
    expect(rows[0]).toMatchObject({ to: BAHRAM, from: "support", fromRef: { type: "bot", id: "support" } });
  });

  test("a plain name, or {type: bot}, is still a bot", async () => {
    const { t, token } = await world();
    await hand(t, token, { to: "growth" });
    await hand(t, token, { to: { type: "bot", id: "research" }, title: "Other" });
    const rows = (await call(t, token, "handoffs", {})).output.rows;
    expect(rows.map((r: { toRef: unknown }) => r.toRef)).toEqual(
      expect.arrayContaining([
        { type: "bot", id: "growth" },
        { type: "bot", id: "research" },
      ]),
    );
    // No person was handed anything: nobody is told.
    expect((await notes(t)).filter((n) => n.kind === "handoff")).toEqual([]);
  });

  test("an address that is not one of that company's people is refused as unknown_person", async () => {
    const { t, token } = await world();
    const stranger = await hand(t, token, { to: "nobody@example.com" });
    expect(stranger.said).toBe(HANDOFF_WORDS.unknownPerson);
    expect(stranger.refusal).toEqual({ code: "unknown_person" });
    // On the team, but not on Globex.
    const otherCompany = await hand(t, token, { company: "kz" });
    expect(otherCompany.refusal).toEqual({ code: "unknown_person" });
    // On the company, but without the board: they could not answer it.
    const noBoard = memberEmail("engineer", ["us"]);
    await t.run(async (ctx) => {
      const addedBy = await ctx.db.insert("users", {});
      await ctx.db.insert("members", { email: noBoard, role: "engineer", companies: ["us"], areas: ["product"], addedAt: 1, addedBy });
    });
    expect((await hand(t, token, { to: noBoard })).refusal).toEqual({ code: "unknown_person" });
    expect((await call(t, token, "handoffs", {})).output.rows).toEqual([]);
  });

  test("a call that is no bot cannot hand to a person", async () => {
    const { t, token } = await world();
    const plain = await hand(t, token, { agent: undefined });
    expect(plain.said).toBe(HANDOFF_WORDS.botsToPeople);
    expect((await call(t, token, "handoffs", {})).output.rows).toEqual([]);
  });

  test(`a bot hands to people at most ${PERSON_HANDOFFS_PER_DAY} times a UTC day`, async () => {
    const { t, token } = await world();
    for (let i = 0; i < PERSON_HANDOFFS_PER_DAY; i++) {
      expect((await hand(t, token, { title: `h${i}` })).isError).toBe(false);
    }
    const over = await hand(t, token, { title: "one more" });
    expect(over.refusal).toMatchObject({ code: "rate_limited", limit: "person_handoffs", max: PERSON_HANDOFFS_PER_DAY });
    // Another bot has its own; and a hand-off to a bot is not counted. (Titles
    // of their own: the near-duplicate check runs on every handoff_create.)
    expect((await hand(t, token, { agent: "growth", title: "Pricing sheet for the clinic" })).isError).toBe(false);
    expect((await hand(t, token, { to: "growth", title: "Webinar invite list" })).isError).toBe(false);
    vi.setSystemTime(NOW + 24 * HOUR);
    expect((await hand(t, token, { title: "next day" })).isError).toBe(false);
  });

  test("the person is told in the app and in the company's group: title, summary and the bot, no address", async () => {
    const calls = stubFetch();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    const { t, token, bahram } = await world();
    await hand(t, token);
    await finishScheduled(t);
    const mine = await bahram.query(api.notifications.mine, {});
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({
      kind: "handoff",
      title: "Clinic asks for a call",
      summary: "They want a demo on Thursday.",
      actor: { type: "bot", name: "support" },
      handoff: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.chat_id).toBe("-1001");
    const text = String(calls[0]!.body.text);
    expect(text).toContain("Clinic asks for a call");
    expect(text).toContain("They want a demo on Thursday.");
    expect(text).toContain("support");
    expect(text).not.toContain("@gmail.com");
  });

  test("with Telegram off the app notification is still written", async () => {
    const calls = stubFetch();
    const { t, token } = await world();
    await hand(t, token);
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    expect((await notes(t)).filter((n) => n.kind === "handoff")).toHaveLength(1);
  });
});

describe("the person answers on /handoffs", () => {
  async function made() {
    const w = await world();
    const id = (await hand(w.t, w.token)).output.id as Id<"handoffs">;
    return { ...w, id };
  }

  test("their own handoff is marked theirs; accept, then done with a note", async () => {
    const { bahram, id } = await made();
    const [row] = await bahram.query(api.handoffs.list, {});
    expect(row).toMatchObject({ id, mine: true, toRef: { type: "person", email: BAHRAM } });
    await bahram.mutation(api.handoffs.answer, { id, action: "accept" });
    await bahram.mutation(api.handoffs.answer, { id, action: "done", note: "Booked for Thursday" });
    const [after] = await bahram.query(api.handoffs.list, {});
    expect(after).toMatchObject({ status: "done" });
    expect(after!.history.at(-1)).toMatchObject({ action: "done", by: BAHRAM, note: "Booked for Thursday" });
  });

  test("a decline needs a reason", async () => {
    const { bahram, id } = await made();
    await expect(bahram.mutation(api.handoffs.answer, { id, action: "decline" })).rejects.toThrow(HANDOFF_WORDS.needsReason);
    await bahram.mutation(api.handoffs.answer, { id, action: "decline", note: "Not my clinic" });
    const [row] = await bahram.query(api.handoffs.list, {});
    expect(row).toMatchObject({ status: "declined", reason: "Not my clinic" });
  });

  test("nobody else answers it: not the owner, not a bot", async () => {
    const { t, owner, token, id } = await made();
    const [row] = await owner.query(api.handoffs.list, {});
    expect(row!.mine).toBe(false);
    await expect(owner.mutation(api.handoffs.answer, { id, action: "accept" })).rejects.toThrow(HANDOFF_WORDS.notYours);
    const bot = await call(t, token, "handoff_update", { id, action: "accept", agent: "support" });
    expect(bot.said).toBe(HANDOFF_WORDS.notYours);
  });

  test("a bot's handoff to a bot is nobody's to answer on the page", async () => {
    const { t, token, bahram } = await world();
    const id = (await hand(t, token, { to: "growth" })).output.id as Id<"handoffs">;
    await expect(bahram.mutation(api.handoffs.answer, { id, action: "accept" })).rejects.toThrow(HANDOFF_WORDS.notYours);
  });
});

describe("back to the bot", () => {
  test("done reaches the sending bot's my_inbox as handoffs_completed, and no other bot's", async () => {
    const { t, token, bahram } = await world();
    const id = (await hand(t, token)).output.id as Id<"handoffs">;
    vi.setSystemTime(NOW + HOUR);
    await bahram.mutation(api.handoffs.answer, { id, action: "done", note: "Booked" });
    const inbox = (await call(t, token, "my_inbox", { agent: "support" })).output;
    expect(inbox.handoffs_completed).toEqual([{ id, note: "Booked", by: BAHRAM }]);
    const later = (await call(t, token, "my_inbox", { agent: "support", since: NOW + 2 * HOUR })).output;
    expect(later.handoffs_completed).toEqual([]);
    expect((await call(t, token, "my_inbox", { agent: "growth" })).output.handoffs_completed).toEqual([]);
  });
});

describe("Needs you", () => {
  test("an open person handoff with no action for a day is the person's and the owner's", async () => {
    const { t, token, owner, bahram } = await world();
    await hand(t, token);
    const fresh = await bahram.query(api.handoffs.waiting, {});
    expect(fresh).toEqual([{ company: "us", status: "open", openSince: NOW, person: true, mine: true }]);
    expect((await owner.query(api.handoffs.waiting, {}))[0]).toMatchObject({ person: true, mine: false });
  });
});

describe("the pure parts", () => {
  test("partyOf: no @ is a bot; an address or {type: person} is a person, lower case", () => {
    expect(partyOf("Growth")).toEqual({ type: "bot", id: "Growth" });
    expect(partyOf({ type: "bot", id: "growth" })).toEqual({ type: "bot", id: "growth" });
    expect(partyOf(" Bahram@Example.TEST ")).toEqual({ type: "person", email: "bahram@example.test" });
    expect(() => partyOf("not@an")).toThrow(HANDOFF_WORDS.unknownPerson);
  });

  test("the group's message quotes the title and summary as text, and names a bot only by a slug", () => {
    const text = handoffMessage({
      username: "bahram_kz",
      name: undefined,
      title: "<b>Call</b> the clinic",
      summary: "Ask about <a href='x'>this</a>",
      company: "us",
      bot: "Dr <i>Pat</i>",
      url: "https://os.example.test/handoffs",
    });
    expect(text).toContain("@bahram_kz");
    expect(text).not.toContain("<b>Call");
    expect(text).not.toContain("<a href='x'>");
    expect(text).toContain("from a bot");
  });

  test("a handoff's refusals carry their codes", () => {
    expect(handoffRefusalOf(HANDOFF_WORDS.unknownPerson, NOW)).toEqual({ code: "unknown_person" });
    expect(handoffRefusalOf(HANDOFF_WORDS.botsToPeople, NOW)).toMatchObject({ code: "not_permitted", area: "board", need: "write" });
    expect(handoffRefusalOf(HANDOFF_WORDS.ambiguous, NOW)).toEqual({ code: "ambiguous_addressee" });
    expect(handoffRefusalOf(sharedAgentWarning("engineering"), NOW)).toBeNull();
    expect(handoffRefusalOf("anything else", NOW)).toBeNull();
  });
});

describe("the owner tags a person on /handoffs", () => {
  const botHandoff = async (t: TestBackend, token: string) =>
    (await call(t, token, "handoff_create", {
      company: "us",
      to: "engineering",
      title: "Integration effort needed",
      summary: "Rough effort and timeline, please.",
      agent: "partnerships",
    })).output.id as Id<"handoffs">;

  test("reassigning a bot's handoff to a teammate makes it theirs, tells them, and keeps the address out of the history", async () => {
    const { t, owner, token, bahram } = await world();
    const id = await botHandoff(t, token);
    await owner.mutation(api.handoffs.reassign, { id, to: BAHRAM.toUpperCase(), note: "Can you size this?" });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ to: BAHRAM, toKind: "person", toKey: `@${BAHRAM}`, status: "open" });
    const last = row!.history.at(-1)!;
    expect(last).toMatchObject({ action: "reassign", by: OWNER });
    expect(last.note).not.toContain("@");
    expect(last.note).toContain("Can you size this?");
    const told = (await notes(t)).filter((n) => n.kind === "handoff");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ handoffId: id, actor: { type: "user" } });
    // Theirs to answer now.
    const [mine] = await bahram.query(api.handoffs.list, {});
    expect(mine).toMatchObject({ mine: true });
    await bahram.mutation(api.handoffs.answer, { id, action: "done", note: "Two weeks" });
    expect((await t.run((ctx) => ctx.db.get(id)))!.status).toBe("done");
  });

  test("an address that is not one of that company's people with the board is refused", async () => {
    const { t, owner, token } = await world();
    const id = await botHandoff(t, token);
    await expect(owner.mutation(api.handoffs.reassign, { id, to: "nobody@example.com" })).rejects.toThrow(HANDOFF_WORDS.unknownPerson);
    expect((await t.run((ctx) => ctx.db.get(id)))!.to).toBe("bot:engineering");
  });

  test("handed back to a bot, it is a bot's again", async () => {
    const { t, owner, token } = await world();
    const id = await botHandoff(t, token);
    await owner.mutation(api.handoffs.reassign, { id, to: BAHRAM });
    await owner.mutation(api.handoffs.reassign, { id, to: "growth" });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ to: "growth", toKey: "growth" });
    expect(row!.toKind).toBeUndefined();
  });
});

describe("handoffs.recipients", () => {
  test("the people of that company who hold the board, and the bots; nobody else", async () => {
    const { t, owner } = await world();
    await signInWithAreas(t, "engineer", ["engineering"], ["us"]);
    const found = await owner.query(api.handoffs.recipients, { company: "us" });
    const emails = found.people.map((p: { email: string }) => p.email);
    expect(emails).toContain(BAHRAM);
    expect(emails).toContain(OWNER);
    expect(emails).not.toContain(memberEmail("engineer", ["us"]));
    expect(found.bots.map((b: { id: string }) => b.id)).toContain("growth");
    expect((await owner.query(api.handoffs.recipients, { company: "kz" })).people.map((p: { email: string }) => p.email)).not.toContain(BAHRAM);
  });
});
