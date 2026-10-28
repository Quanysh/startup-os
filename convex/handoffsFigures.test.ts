import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { HANDOFF_WITHHELD } from "./lib/handoffs";
import { handoffMessage } from "./lib/telegramMessage";
import { NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, memberEmail, modules, signInWithAreas, type TestBackend } from "./test.setup";

// A bot's handoff can carry the company's figures (a bot that reads Finance
// may write "Cash $8.8K" in a summary). Its text goes to whoever holds every
// figure area the bot reads (FIGURE_AREAS), to the person it is addressed
// to, and to the owner; anyone else with the board sees that a handoff
// exists, never its words. The company's Telegram group, which everyone on
// the company is in, is not told the words either. Every name, address and
// figure is made up.

const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";
const FIGURE = "Cash SECRET $8.8K";
/** A teammate on Startup with the board alone: the person handed to. */
const PERSON = memberEmail("sales", ["us"]);

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
  // The suggested bots: growth reads every area a bot may (Finance among
  // them); support reads Support and Outcomes alone.
  await owner.mutation(api.bots.addSuggested, {});
  const person = await signInWithAreas(t, "sales", ["board"], ["us"]);
  const engineer = await signInWithAreas(t, "engineer", ["board", "product", "engineering", "today"]);
  const holder = await signInWithAreas(t, "cofounder", ["board", "finance", "fundraising", "sales", "customers"]);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramSettings", { enabled: true, chatUs: { id: "-1001", title: "Startup team" } });
  });
  return { t, owner, token, person, engineer, holder };
}

const hand = (t: TestBackend, token: string, args: Record<string, unknown>) =>
  call(t, token, "handoff_create", { company: "us", title: `Runway check: ${FIGURE}`, summary: `${FIGURE} at the end of the month.`, ...args });

describe("a bot's handoff and the figures it may hold", () => {
  test("from a bot that reads Finance: its words go only to a holder of every figure area and to the owner", async () => {
    const { t, owner, token, engineer, holder } = await world();
    expect((await hand(t, token, { agent: "growth", to: "research" })).isError).toBe(false);
    const [seen] = await engineer.query(api.handoffs.list, {});
    expect(seen).toMatchObject({ from: "growth", to: "research", status: "open", withheld: true, title: HANDOFF_WITHHELD, summary: "" });
    expect(JSON.stringify(await engineer.query(api.handoffs.list, {}))).not.toContain("SECRET");
    for (const reader of [holder, owner]) {
      const [row] = await reader.query(api.handoffs.list, {});
      expect(row).toMatchObject({ withheld: false, title: `Runway check: ${FIGURE}` });
      expect(row!.summary).toContain(FIGURE);
    }
  });

  test("a note in its history is withheld with it", async () => {
    const { t, owner, token, engineer } = await world();
    const id = (await hand(t, token, { agent: "growth", to: "research" })).output.id as string;
    await call(t, token, "handoff_update", { id, action: "decline", note: `Not now: ${FIGURE}`, agent: "research" });
    const rows = await engineer.query(api.handoffs.list, {});
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    expect(rows[0]).toMatchObject({ status: "declined", reason: null });
    expect(JSON.stringify(await owner.query(api.handoffs.list, {}))).toContain("SECRET");
  });

  test("from a bot that reads no figure area, everyone with the board reads it", async () => {
    const { t, token, engineer } = await world();
    // Support reads Support and Outcomes alone, and a person's words are their own.
    expect((await hand(t, token, { agent: "support", to: PERSON, title: "Clinic asks for a call", summary: "A demo on Thursday." })).isError).toBe(false);
    const [row] = await engineer.query(api.handoffs.list, {});
    expect(row).toMatchObject({ withheld: false, title: "Clinic asks for a call", summary: "A demo on Thursday." });
  });

  test("the person it is addressed to reads it; the company's group is told only who and from which bot", async () => {
    const calls = stubFetch();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    const { t, token, person, engineer } = await world();
    expect((await hand(t, token, { agent: "growth", to: PERSON })).isError).toBe(false);
    const [mine] = await person.query(api.handoffs.list, {});
    expect(mine).toMatchObject({ mine: true, withheld: false, title: `Runway check: ${FIGURE}` });
    expect(JSON.stringify(await engineer.query(api.handoffs.list, {}))).not.toContain("SECRET");
    // What the scheduled post runs, run here so the test does not race the scheduler.
    await t.action(internal.telegram.notifyHandoff, { handoffId: mine!.id });
    expect(calls).toHaveLength(1);
    const text = String(calls[0]!.body.text);
    expect(text).not.toContain("SECRET");
    expect(text).toContain("growth");
    expect(text).toContain("New handoff");
  });

  test("the group's message for a withheld handoff has no title or summary", () => {
    const text = handoffMessage({
      username: "ada_example",
      name: undefined,
      title: null,
      summary: "",
      company: "us",
      bot: "growth",
      url: "https://os.example.test/handoffs",
    });
    expect(text).toContain("@ada_example");
    expect(text).toContain("from growth");
    expect(text).not.toContain("SECRET");
  });
});
