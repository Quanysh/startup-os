import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { HANDOFF_REPAIR_BY, HANDOFF_REPAIR_NOTE, HANDOFF_WORDS, MAX_HANDOFF_SUMMARY } from "./lib/handoffs";
import { MAC_CLIENT, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import { TOO_MANY_OPEN, MAX_OPEN_HANDOFFS } from "./handoffs";
import schema from "./schema";
import { OWNER, modules, signInAsSales, signInWithAreas, type TestBackend } from "./test.setup";
import { AGENT_HEADER } from "./lib/osAgents";
import { BOT_WORDS } from "./lib/botRules";

// Bot-to-bot handoffs through the MCP tools and the owner's page: every write
// is attributed to the calling bot, and only the bot a handoff is addressed to
// may answer it.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world() {
  const t = convexTest(schema, modules);
  await seed(t);
  const { owner, token } = await ownerWithToken(t, "act");
  // The owner's suggested bots (research, growth, support, ...): a bot is
  // known by its profile's id, which the endpoint checks before any tool runs.
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, token };
}

// Each handoff a title of its own: the same title twice is a near-duplicate (Bot Loop v3).
let handed = 0;
const hand = (t: TestBackend, token: string, args: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  call(t, token, "handoff_create", {
    company: "us",
    to: "Growth",
    title: `Research is done ${(handed += 1)}`,
    summary: "Ten clinics shortlisted.",
    agent: "research",
    ...args,
  }, headers);

describe("handoff_create", () => {
  test("starts open, from the named bot, with a history entry", async () => {
    const { t, token } = await world();
    const made = await hand(t, token);
    expect(made.output).toMatchObject({ created: true });
    const rows = (await call(t, token, "handoffs", {})).output.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: "research", to: "Growth", status: "open", company: "us" });
    expect(rows[0].history).toEqual([{ at: NOW, by: "research", action: "create" }]);
  });

  test("without a name it is the client's; a bot is its profile's id, by the argument or the header", async () => {
    const { t, token } = await world();
    await hand(t, token, { agent: undefined });
    await hand(t, token, { to: "ops", agent: "research" });
    await hand(t, token, { to: "ops", agent: undefined }, { [AGENT_HEADER]: "growth" });
    const rows = (await call(t, token, "handoffs", {})).output;
    expect(rows.you).toBe(MAC_CLIENT);
    expect(rows.rows.map((r: { from: string }) => r.from).sort()).toEqual([MAC_CLIENT, "growth", "research"].sort());
  });

  test("a name that is no bot's profile is refused, and writes nothing", async () => {
    const { t, token } = await world();
    expect((await hand(t, token, { agent: "made_up_bot" })).said).toBe(BOT_WORDS.unknown);
    expect((await hand(t, token, { agent: "Research" })).said).toBe(BOT_WORDS.unknown);
    expect((await call(t, token, "handoffs", {})).output.rows).toEqual([]);
  });

  test("refuses a hand-off to itself, a long summary and a link that is not there", async () => {
    const { t, token } = await world();
    expect((await hand(t, token, { to: "research" })).said).toBe(HANDOFF_WORDS.toSelf);
    expect((await hand(t, token, { summary: "s".repeat(MAX_HANDOFF_SUMMARY + 1) })).isError).toBe(true);
    const bad = await hand(t, token, { links: [{ kind: "task", id: "not-an-id" }] });
    expect(bad.said).toBe(HANDOFF_WORDS.link);
  });

  test("links a task of the same company", async () => {
    const { t, token } = await world();
    const task = await call(t, token, "task_create", { title: "Made-up linked card", company: "us" });
    const made = await hand(t, token, { links: [{ kind: "task", id: task.output.id }] });
    expect(made.isError).toBe(false);
    const other = await call(t, token, "task_create", { title: "Kz task", company: "kz" });
    expect((await hand(t, token, { links: [{ kind: "task", id: other.output.id }] })).said).toBe(HANDOFF_WORDS.link);
  });

  test("a company cannot hold more than the open limit", async () => {
    const { t, token } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_OPEN_HANDOFFS; i++) {
        await ctx.db.insert("handoffs", {
          company: "us", from: "a", fromKey: "a", to: "b", toKey: "b", title: `h${i}`, summary: "",
          links: [], status: "open", openSince: NOW, createdAt: NOW, updatedAt: NOW, history: [],
        });
      }
    });
    expect((await hand(t, token)).said).toBe(TOO_MANY_OPEN);
  });
});

describe("migrations:repairOpenHandoffAddressees", () => {
  const row = (over: Record<string, unknown>) => ({
    company: "us" as const,
    from: "growth",
    fromKey: "growth",
    to: "engineering",
    toKey: "engineering",
    title: "Made-up",
    summary: "",
    links: [],
    status: "open" as const,
    openSince: NOW - 1,
    createdAt: NOW - 1,
    updatedAt: NOW - 1,
    history: [{ at: NOW - 1, by: "growth", action: "create" as const }],
    ...over,
  });

  test("rewrites open bare external ids to the bot profile, and a second run changes nothing", async () => {
    const { t } = await world();
    const ids = await t.run(async (ctx) => ({
      engineering: await ctx.db.insert("handoffs", row({})),
      finance: await ctx.db.insert("handoffs", row({ to: "finance", toKey: "finance" })),
      chief: await ctx.db.insert("handoffs", row({ company: "kz", to: "chief_of_staff", toKey: "chief_of_staff" })),
      growth: await ctx.db.insert("handoffs", row({ to: "growth", toKey: "growth" })),
      person: await ctx.db.insert("handoffs", row({ to: "ada@example.com", toKey: "engineering", toKind: "person" })),
      already: await ctx.db.insert("handoffs", row({ to: "bot:engineering", toKey: "bot:engineering" })),
      mac: await ctx.db.insert("handoffs", row({ to: "mac:engineering", toKey: "mac:engineering" })),
      done: await ctx.db.insert("handoffs", row({ status: "done" })),
      accepted: await ctx.db.insert("handoffs", row({ status: "accepted" })),
    }));

    const result = await t.mutation(internal.migrations.repairOpenHandoffAddressees, {});
    expect(result).toEqual({ changed: 3, read: 7 });

    const after = await t.run(async (ctx) => ({
      engineering: await ctx.db.get(ids.engineering),
      finance: await ctx.db.get(ids.finance),
      chief: await ctx.db.get(ids.chief),
      growth: await ctx.db.get(ids.growth),
      person: await ctx.db.get(ids.person),
      already: await ctx.db.get(ids.already),
      mac: await ctx.db.get(ids.mac),
      done: await ctx.db.get(ids.done),
      accepted: await ctx.db.get(ids.accepted),
    }));
    expect(after.engineering).toMatchObject({
      to: "bot:engineering",
      toKey: "bot:engineering",
      status: "open",
      openSince: NOW - 1,
    });
    expect(after.engineering!.history.at(-1)).toEqual({
      at: NOW,
      by: HANDOFF_REPAIR_BY,
      action: "reassign",
      note: HANDOFF_REPAIR_NOTE,
    });
    expect(after.finance).toMatchObject({ to: "bot:finance", toKey: "bot:finance", status: "open" });
    expect(after.chief).toMatchObject({ to: "bot:chief_of_staff", toKey: "bot:chief_of_staff", status: "open" });
    expect(after.growth).toMatchObject({ to: "growth", toKey: "growth" });
    expect(after.person).toMatchObject({ to: "ada@example.com", toKey: "engineering", toKind: "person" });
    expect(after.already).toMatchObject({ to: "bot:engineering", toKey: "bot:engineering" });
    expect(after.already!.history).toHaveLength(1);
    expect(after.mac).toMatchObject({ to: "mac:engineering", toKey: "mac:engineering" });
    expect(after.done).toMatchObject({ to: "engineering", toKey: "engineering", status: "done" });
    expect(after.accepted).toMatchObject({ to: "engineering", toKey: "engineering", status: "accepted" });

    expect(await t.mutation(internal.migrations.repairOpenHandoffAddressees, {})).toEqual({ changed: 0, read: 7 });
  });
});

describe("handoff_update", () => {
  async function made() {
    const w = await world();
    const id = (await hand(w.t, w.token)).output.id as string;
    return { ...w, id };
  }
  const as = (agent: string) => ({ agent });

  test("only the bot it is addressed to answers; the sender and others are refused", async () => {
    const { t, token, id } = await made();
    expect((await call(t, token, "handoff_update", { id, action: "accept", ...as("research") })).said).toBe(HANDOFF_WORDS.notYours);
    expect((await call(t, token, "handoff_update", { id, action: "done", ...as("support") })).said).toBe(HANDOFF_WORDS.notYours);
    const ok = await call(t, token, "handoff_update", { id, action: "accept", ...as("growth") });
    expect(ok.output).toMatchObject({ status: "accepted" });
  });

  test("accept, then done; the history says who and when, and a finished one does not change", async () => {
    const { t, token, id } = await made();
    await call(t, token, "handoff_update", { id, action: "accept", ...as("growth") });
    await call(t, token, "handoff_update", { id, action: "done", note: "Sent", ...as("growth") });
    const [row] = (await call(t, token, "handoffs", { status: "done" })).output.rows;
    expect(row.history.map((h: { action: string; by: string }) => [h.action, h.by])).toEqual([
      ["create", "research"],
      ["accept", "growth"],
      ["done", "growth"],
    ]);
    expect(row.history[2].note).toBe("Sent");
    expect((await call(t, token, "handoff_update", { id, action: "done", ...as("growth") })).said).toBe(HANDOFF_WORDS.finished);
  });

  test("a decline needs a reason, and keeps it", async () => {
    const { t, token, id } = await made();
    expect((await call(t, token, "handoff_update", { id, action: "decline", ...as("growth") })).said).toBe(HANDOFF_WORDS.needsReason);
    await call(t, token, "handoff_update", { id, action: "decline", note: "No capacity", ...as("growth") });
    const [row] = (await call(t, token, "handoffs", {})).output.rows;
    expect(row).toMatchObject({ status: "declined", reason: "No capacity" });
  });

  test("a bot cannot touch an id that is nothing", async () => {
    const { t, token } = await made();
    const gone = await call(t, token, "handoff_update", { id: "nope", action: "accept", agent: "growth" });
    expect(gone.said).toBe(HANDOFF_WORDS.gone);
  });

  test("the run header names the bot, whatever the argument says", async () => {
    const { t, token } = await world();
    const id = (await hand(t, token, { to: "growth", agent: "research" })).output.id as string;
    // A header and an argument that name two bots are refused before any tool runs.
    const lie = await call(t, token, "handoff_update", { id, action: "accept", agent: "growth" }, { [AGENT_HEADER]: "support" });
    expect(lie.said).toBe(BOT_WORDS.wrongAgent);
    // The header alone is the bot, checked against its profile: growth answers.
    const ok = await call(t, token, "handoff_update", { id, action: "accept" }, { [AGENT_HEADER]: "growth" });
    expect(ok.output).toMatchObject({ status: "accepted" });
    // One of the four agents names the caller as before; it is not the addressee.
    const four = await call(t, token, "handoff_update", { id, action: "done" }, { [AGENT_HEADER]: "sales" });
    expect(four.isError).toBe(true);
  });
});

describe("reading", () => {
  test("filters by to, from and status, open first; `you` is the caller", async () => {
    const { t, token } = await world();
    const a = (await hand(t, token, { to: "Growth" })).output.id as string;
    await hand(t, token, { to: "Ops", title: "Second" });
    await call(t, token, "handoff_update", { id: a, action: "done", agent: "growth" });
    const all = (await call(t, token, "handoffs", {})).output.rows;
    expect(all.map((r: { title: string }) => r.title)).toEqual(["Second", expect.stringMatching(/^Research is done/)]);
    expect((await call(t, token, "handoffs", { to: "ops", status: "open" })).output.rows).toHaveLength(1);
    expect((await call(t, token, "handoffs", { from: "RESEARCH" })).output.rows).toHaveLength(2);
    expect((await call(t, token, "handoffs", { to: "nobody" })).output.rows).toEqual([]);
    expect((await call(t, token, "handoffs", { agent: "growth" })).output.you).toBe("growth");
  });

  test("a read-only token reads but cannot create", async () => {
    const { t, owner } = await world();
    const { token } = await owner.mutation(api.assistant.createToken, {
      entropy: "another-fake-entropy-0123456789-abcdefghijkl",
      scope: "read",
      name: "Reader",
      botsOnly: false,
    });
    expect((await call(t, token, "handoffs", {})).isError).toBe(false);
    expect((await hand(t, token)).isError).toBe(true);
  });
});

describe("the owner's page", () => {
  test("lists, reassigns (open again, to the new bot) and closes, in the history", async () => {
    const { t, owner, token } = await world();
    const id = (await hand(t, token)).output.id as Id<"handoffs">;
    await call(t, token, "handoff_update", { id, action: "accept", agent: "growth" });
    await owner.mutation(api.handoffs.reassign, { id, to: "Ops", note: "Growth is busy" });
    const [moved] = await owner.query(api.handoffs.list, {});
    expect(moved).toMatchObject({ to: "Ops", status: "open" });
    expect(moved!.history.at(-1)).toMatchObject({ action: "reassign", by: OWNER, note: "To Ops: Growth is busy" });
    // The old receiver can no longer answer it.
    expect((await call(t, token, "handoff_update", { id, action: "done", agent: "growth" })).said).toBe(HANDOFF_WORDS.notYours);
    await owner.mutation(api.handoffs.close, { id, note: "Not needed" });
    const [closed] = await owner.query(api.handoffs.list, {});
    expect(closed).toMatchObject({ status: "closed", reason: "Not needed" });
    await expect(owner.mutation(api.handoffs.close, { id })).rejects.toThrow();
  });

  test("a teammate without the board, or on the other company, is sent nothing and cannot write", async () => {
    const { t, token } = await world();
    const id = (await hand(t, token, { company: "kz" })).output.id as Id<"handoffs">;
    const sales = await signInAsSales(t, ["us"]);
    expect(await sales.query(api.handoffs.list, {})).toEqual([]);
    await expect(sales.query(api.handoffs.list, { company: "kz" })).rejects.toThrow();
    await expect(sales.mutation(api.handoffs.close, { id })).rejects.toThrow();
  });

  test("a teammate with the board on its company may reassign one but not close it: closing is the owner's", async () => {
    const { t, token } = await world();
    const id = (await hand(t, token)).output.id as Id<"handoffs">;
    const teammate = await signInWithAreas(t, "cofounder", ["board"], ["us"]);
    await expect(teammate.mutation(api.handoffs.close, { id })).rejects.toThrow("not_owner");
    await teammate.mutation(api.handoffs.reassign, { id, to: "Ops" });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ to: "Ops", status: "open" });
  });

  test("waiting sends only when each open one began", async () => {
    const { t, owner, token } = await world();
    await hand(t, token);
    expect(await owner.query(api.handoffs.waiting, {})).toEqual([{ company: "us", status: "open", openSince: NOW, person: false, mine: false }]);
  });
});

describe("Needs you", () => {
  test("overview names an open handoff nobody accepted in a day, with a count and no title", async () => {
    const { t, token } = await world();
    await hand(t, token, { title: "SECRET title" });
    const fresh = await call(t, token, "overview", {});
    expect(fresh.output.items.map((i: { id: string }) => i.id)).not.toContain("handoffs-unaccepted");
    vi.setSystemTime(NOW + 25 * 60 * 60 * 1000);
    const later = await call(t, token, "overview", {});
    const item = later.output.items.find((i: { id: string }) => i.id === "handoffs-unaccepted");
    expect(item).toMatchObject({ href: "/handoffs", title: "1 handoff has no taker" });
    expect(later.text).not.toContain("SECRET title");
  });
});
