import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  MAX_MENTIONS,
  MAX_NOTIFICATIONS,
  NOTIFICATION_PAGE,
  NOTIFICATION_RETENTION_DAYS,
  UNREAD_COUNT_CAP,
} from "./lib/limits";
import { NOTIFICATION_GONE } from "./notifications";
import schema from "./schema";
import { CANNOT_MENTION, TOO_MANY_MENTIONS } from "./tasks";
import {
  OWNER,
  addMember,
  memberEmail,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// What each person is told about the board, from the board's own mutations.
// (The standup's and Telegram's cards are in standup.test.ts and
// telegramInbound.test.ts.) Every title that must not surface says SECRET.

const NOW = Date.UTC(2026, 9, 13, 12);
const DAY = 24 * 60 * 60 * 1000;

let logged: unknown[][];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});
afterEach(() => {
  // No title and no name in a log, whatever a test did.
  expect(JSON.stringify(logged)).not.toMatch(/SECRET|Sam Sales|Cora Founder/);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Client = Awaited<ReturnType<typeof signInAsOwner>>;

const COFOUNDER = memberEmail("cofounder");
const US_SALES = memberEmail("sales", ["us"]);
const KZ_ENGINEER = memberEmail("engineer", ["kz"]);

const userId = (t: TestBackend, email: string) =>
  t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    return user!._id;
  });

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const cofounder = await signInAsCofounder(t);
  const usSales = await signInAsSales(t, ["us"]);
  const kzEngineer = await signInAsEngineer(t, ["kz"]);
  await t.run(async (ctx) => {
    for (const [email, name] of [
      [OWNER, "Olga Owner"],
      [COFOUNDER, "Cora Founder"],
      [US_SALES, "Sam Sales"],
      [KZ_ENGINEER, "Erik Engineer"],
    ] as const) {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first();
      await ctx.db.patch(user!._id, { name });
    }
  });
  return { t, owner, cofounder, usSales, kzEngineer };
};

const stored = (t: TestBackend) => t.run((ctx) => ctx.db.query("notifications").collect());
const mine = async (client: Client) => (await client.query(api.notifications.mine, {})).rows;
/** What a person's panel reads, newest first: kind and title. */
const told = async (client: Client) => (await mine(client)).map((row) => `${row.kind}: ${row.title}`);

/** A notification written straight to the table, for the read tests. */
const give = (
  t: TestBackend,
  recipient: Id<"users">,
  over: Record<string, unknown> = {},
) =>
  t.run(async (ctx) => {
    const taskId = await ctx.db.insert("tasks", {
      title: "A task",
      kind: "task",
      column: "backlog",
      order: 0,
    });
    return await ctx.db.insert("notifications", {
      recipient,
      kind: "assigned",
      actor: { type: "system", source: "standup" },
      taskId,
      title: "A task",
      createdAt: NOW,
      ...over,
    } as never);
  });

// ── The six events, from the board ──────────────────────────────────────────

describe("a task is given to someone", () => {
  test("creating a task for someone tells them, once, and nobody else", async () => {
    const { t, owner, cofounder, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, {
      title: "Call the clinic",
      assignee: US_SALES,
      company: "us",
    });
    const rows = await stored(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient: await userId(t, US_SALES),
      kind: "assigned",
      actor: { type: "user", userId: await userId(t, OWNER) },
      taskId: id,
      company: "us",
      title: "Call the clinic",
      createdAt: NOW,
    });
    expect(rows[0]!.readAt).toBeUndefined();
    expect(await mine(usSales)).toEqual([
      {
        id: rows[0]!._id,
        kind: "assigned",
        actor: { type: "user", name: "Olga Owner" },
        title: "Call the clinic",
        company: "us",
        taskId: id,
        decisionId: null,
        handoff: false,
        summary: null,
        column: null,
        to: null,
        due: null,
        createdAt: NOW,
        read: false,
      },
    ]);
    expect(await mine(owner)).toEqual([]);
    expect(await mine(cofounder)).toEqual([]);
  });

  test("giving yourself a task tells nobody", async () => {
    const { t, usSales } = await start();
    await usSales.mutation(api.tasks.create, { title: "Mine", assignee: US_SALES });
    const id = await usSales.mutation(api.tasks.create, { title: "Also mine" });
    await usSales.mutation(api.tasks.update, { id, assignee: US_SALES });
    expect(await stored(t)).toEqual([]);
  });

  test("assigning an existing task tells the new holder", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Unowned" });
    await owner.mutation(api.tasks.update, { id, assignee: US_SALES });
    expect(await told(usSales)).toEqual(["assigned: Unowned"]);
    expect(await stored(t)).toHaveLength(1);
  });

  test("a save that names the same holder again tells nobody", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Held", assignee: US_SALES });
    await owner.mutation(api.tasks.update, { id, assignee: US_SALES, title: "Held still" });
    expect(await stored(t)).toHaveLength(1);
  });

  test("someone who has never signed in has nowhere to be told", async () => {
    const { t, owner } = await start();
    await addMember(t, { email: "new.person@gmail.com", role: "sales" });
    await owner.mutation(api.tasks.create, { title: "For later", assignee: "new.person@gmail.com" });
    expect(await stored(t)).toEqual([]);
  });

  test("an address two sign-ins hold is nobody's: neither is told", async () => {
    const { t, owner } = await start();
    await t.run((ctx) => ctx.db.insert("users", { email: US_SALES, emailVerificationTime: 1 }));
    await owner.mutation(api.tasks.create, { title: "Whose", assignee: US_SALES });
    expect(await stored(t)).toEqual([]);
  });

  test("the title kept is the task's own, whatever it is renamed to later", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "First name", assignee: US_SALES });
    await owner.mutation(api.tasks.update, { id, title: "Second name" });
    expect(await told(usSales)).toEqual(["assigned: First name"]);
  });
});

describe("a task is taken from someone", () => {
  test("reassigning tells the old holder who has it now, and the new one that it is theirs", async () => {
    const { t, owner, cofounder, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Pass it on", assignee: US_SALES });
    await owner.mutation(api.tasks.update, { id, assignee: COFOUNDER });
    expect(await stored(t)).toHaveLength(3);
    const [latest] = await mine(usSales);
    expect(latest).toMatchObject({
      kind: "reassigned",
      title: "Pass it on",
      to: "Cora Founder",
      actor: { type: "user", name: "Olga Owner" },
    });
    expect(await told(cofounder)).toEqual(["assigned: Pass it on"]);
  });

  test("the one who takes a task over is not told that they did", async () => {
    const { t, owner, cofounder, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Taken", assignee: US_SALES });
    await cofounder.mutation(api.tasks.update, { id, assignee: COFOUNDER });
    expect(await told(usSales)).toEqual(["reassigned: Taken", "assigned: Taken"]);
    expect(await mine(cofounder)).toEqual([]);
    expect(await stored(t)).toHaveLength(2);
  });

  test("unassigning tells whoever held it", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Dropped", assignee: US_SALES });
    await owner.mutation(api.tasks.update, { id, assignee: null });
    const [latest] = await mine(usSales);
    expect(latest).toMatchObject({ kind: "unassigned", title: "Dropped", to: null });
  });

  test("giving your own task away tells only the one who gets it", async () => {
    const { t, usSales, cofounder } = await start();
    const id = await usSales.mutation(api.tasks.create, { title: "Handover", assignee: US_SALES });
    await usSales.mutation(api.tasks.update, { id, assignee: COFOUNDER });
    expect(await stored(t)).toHaveLength(1);
    expect(await told(cofounder)).toEqual(["assigned: Handover"]);
  });

  test("who a shared task went to is not named to someone who does not share a company with them", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Shared", assignee: US_SALES });
    await owner.mutation(api.tasks.update, { id, assignee: KZ_ENGINEER });
    const [latest] = await mine(usSales);
    expect(latest).toMatchObject({ kind: "reassigned", to: null });
    expect(JSON.stringify(await mine(usSales))).not.toContain("Erik");
  });
});

describe("a task changes column", () => {
  test("a move by someone else tells the holder which column", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Moving", assignee: US_SALES });
    await owner.mutation(api.tasks.move, { id, column: "doing", index: 0 });
    const [latest] = await mine(usSales);
    expect(latest).toMatchObject({ kind: "moved", title: "Moving", column: "doing" });
    expect(await stored(t)).toHaveLength(2);
  });

  test("the editor's column field does the same", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Edited", assignee: US_SALES });
    await owner.mutation(api.tasks.update, { id, column: "this_week" });
    expect((await mine(usSales))[0]).toMatchObject({ kind: "moved", column: "this_week" });
  });

  test("moving your own task, or a card within its column, tells nobody", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Own", assignee: US_SALES });
    await owner.mutation(api.tasks.create, { title: "Other" });
    await usSales.mutation(api.tasks.move, { id, column: "doing", index: 0 });
    await owner.mutation(api.tasks.move, { id, column: "doing", index: 0 });
    expect(await stored(t)).toHaveLength(1);
  });

  test("a task nobody holds tells nobody when it moves", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Loose" });
    await owner.mutation(api.tasks.move, { id, column: "doing", index: 0 });
    expect(await stored(t)).toEqual([]);
  });

  test("finishing someone's task tells them it went to Done", async () => {
    const { owner, usSales } = await start();
    const id = await usSales.mutation(api.tasks.create, { title: "Wrapped", assignee: US_SALES });
    await owner.mutation(api.tasks.move, { id, column: "done", index: 0 });
    // They made it and hold it: told once, as the holder.
    expect(await told(usSales)).toEqual(["moved: Wrapped"]);
    expect((await mine(usSales))[0]).toMatchObject({ column: "done" });
  });
});

describe("a task someone made is finished", () => {
  test("whoever made it and gave it away is told when the holder finishes it", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Delegated", assignee: US_SALES });
    await usSales.mutation(api.tasks.move, { id, column: "done", index: 0 });
    expect(await told(owner)).toEqual(["finished: Delegated"]);
    expect((await mine(owner))[0]).toMatchObject({ actor: { type: "user", name: "Sam Sales" } });
    // The holder finished it themselves: nothing more for them.
    expect(await stored(t)).toHaveLength(2);
  });

  test("a third person finishing it tells the maker and the holder, each once", async () => {
    const { owner, cofounder, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Closed", assignee: US_SALES });
    await cofounder.mutation(api.tasks.update, { id, column: "done" });
    expect(await told(owner)).toEqual(["finished: Closed"]);
    expect(await told(usSales)).toEqual(["moved: Closed", "assigned: Closed"]);
  });

  test("finishing your own task tells you nothing, and a move that is not to Done tells no maker", async () => {
    const { t, owner, usSales } = await start();
    const own = await owner.mutation(api.tasks.create, { title: "Solo" });
    await owner.mutation(api.tasks.move, { id: own, column: "done", index: 0 });
    const other = await owner.mutation(api.tasks.create, { title: "Started", assignee: US_SALES });
    await usSales.mutation(api.tasks.move, { id: other, column: "doing", index: 0 });
    expect(await told(owner)).toEqual([]);
    expect(await stored(t)).toHaveLength(1);
  });

  test("a card already in Done that is edited is not finished again", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Done once", assignee: US_SALES });
    await usSales.mutation(api.tasks.move, { id, column: "done", index: 0 });
    await usSales.mutation(api.tasks.update, { id, column: "done", title: "Done once more" });
    expect(await told(owner)).toEqual(["finished: Done once"]);
  });
});

describe("a due date changes", () => {
  test("setting, changing and clearing it each tell the holder", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Dated", assignee: US_SALES });
    await owner.mutation(api.tasks.update, { id, due: "2026-10-20" });
    expect((await mine(usSales))[0]).toMatchObject({ kind: "due", due: "2026-10-20" });
    await owner.mutation(api.tasks.update, { id, due: "2026-10-22" });
    expect((await mine(usSales))[0]).toMatchObject({ kind: "due", due: "2026-10-22" });
    await owner.mutation(api.tasks.update, { id, due: null });
    expect((await mine(usSales))[0]).toMatchObject({ kind: "due", due: null });
    expect(await told(usSales)).toHaveLength(4);
  });

  test("the same date saved again, or your own change, tells nobody", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, {
      title: "Steady",
      assignee: US_SALES,
      due: "2026-10-20",
    });
    await owner.mutation(api.tasks.update, { id, due: "2026-10-20" });
    await usSales.mutation(api.tasks.update, { id, due: "2026-10-25" });
    expect(await stored(t)).toHaveLength(1);
  });

  test("a task handed over with a new date is one notification, not two", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Both at once" });
    await owner.mutation(api.tasks.update, {
      id,
      assignee: US_SALES,
      due: "2026-10-20",
      column: "doing",
    });
    expect(await told(usSales)).toEqual(["assigned: Both at once"]);
  });
});

// ── Mentions ────────────────────────────────────────────────────────────────

describe("mentions", () => {
  test("a person named in the list sent with a save is told, once", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan", company: "us" });
    await owner.mutation(api.tasks.update, {
      id,
      notes: "Ask @Sam Sales about the pilot",
      mentions: [US_SALES],
    });
    expect(await told(usSales)).toEqual(["mentioned: Plan"]);
    expect(await stored(t)).toHaveLength(1);
    const task = await t.run((ctx) => ctx.db.get(id));
    expect(task!.mentioned).toEqual([await userId(t, US_SALES)]);
  });

  test("saving again with the same person does not tell them again", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan" });
    const save = () =>
      owner.mutation(api.tasks.update, { id, notes: "@Sam Sales look", mentions: [US_SALES] });
    await save();
    await save();
    await owner.mutation(api.tasks.update, { id, notes: "@Sam Sales look again" });
    await save();
    expect(await stored(t)).toHaveLength(1);
  });

  test("a second person added later is the only one told by that save", async () => {
    const { owner, cofounder, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan" });
    await owner.mutation(api.tasks.update, { id, notes: "@Sam Sales", mentions: [US_SALES] });
    await owner.mutation(api.tasks.update, {
      id,
      notes: "@Sam Sales @Cora Founder",
      mentions: [US_SALES, COFOUNDER],
    });
    expect(await told(usSales)).toEqual(["mentioned: Plan"]);
    expect(await told(cofounder)).toEqual(["mentioned: Plan"]);
  });

  test("a name typed in the text with no entry in the list tells nobody", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Ask @Sam Sales" });
    await owner.mutation(api.tasks.update, { id, notes: `@Sam Sales and @${US_SALES} please` });
    expect(await stored(t)).toEqual([]);
  });

  test("mentioning yourself tells nobody, and the same person twice in one save is told once", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan" });
    await owner.mutation(api.tasks.update, { id, mentions: [OWNER] });
    expect(await stored(t)).toEqual([]);
    await owner.mutation(api.tasks.update, { id, mentions: [US_SALES, ` ${US_SALES.toUpperCase()}`] });
    expect(await told(usSales)).toEqual(["mentioned: Plan"]);
  });

  test.each([
    ["an address that is nobody's", "nobody@example.com", "us"],
    ["someone who is not on the task's company", KZ_ENGINEER, "us"],
  ] as const)("%s is refused, in one sentence, and nothing is saved", async (_what, email, company) => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan", company });
    await expect(
      owner.mutation(api.tasks.update, { id, title: "Changed", mentions: [email] }),
    ).rejects.toThrow(CANNOT_MENTION);
    expect((await t.run((ctx) => ctx.db.get(id)))!.title).toBe("Plan");
    expect(await stored(t)).toEqual([]);
  });

  test("someone the caller shares no company with is refused in the same words", async () => {
    const { t, usSales } = await start();
    const id = await usSales.mutation(api.tasks.create, { title: "Shared plan" });
    await expect(
      usSales.mutation(api.tasks.update, { id, mentions: [KZ_ENGINEER] }),
    ).rejects.toThrow(CANNOT_MENTION);
    expect(await stored(t)).toEqual([]);
  });

  test("a task moving to a company in the same save is judged by the company it ends up with", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan", company: "us" });
    await owner.mutation(api.tasks.update, { id, company: "kz", mentions: [KZ_ENGINEER] });
    expect(await stored(t)).toHaveLength(1);
    await expect(
      owner.mutation(api.tasks.update, { id, mentions: [US_SALES] }),
    ).rejects.toThrow(CANNOT_MENTION);
  });

  test(`more than ${MAX_MENTIONS} in one save is refused`, async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan" });
    const eleven = Array.from({ length: MAX_MENTIONS + 1 }, () => US_SALES);
    await expect(owner.mutation(api.tasks.update, { id, mentions: eleven })).rejects.toThrow(
      TOO_MANY_MENTIONS,
    );
    await owner.mutation(api.tasks.update, { id, mentions: eleven.slice(0, MAX_MENTIONS) });
    expect(await stored(t)).toHaveLength(1);
  });

  test("the refusal does not repeat the address", async () => {
    const { owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Plan" });
    const failure = await owner
      .mutation(api.tasks.update, { id, mentions: ["secret.person@example.com"] })
      .catch((error: unknown) => String(error));
    expect(failure).not.toContain("secret.person");
  });

  test("the board says who is mentioned on a card, by the name the text holds, to those who know them", async () => {
    const { owner, usSales, kzEngineer } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Shared plan" });
    await owner.mutation(api.tasks.update, { id, mentions: [KZ_ENGINEER, COFOUNDER] });
    const card = async (client: Client) => (await client.query(api.tasks.board, {})).backlog[0]!;
    expect((await card(owner)).mentions).toEqual(["Erik Engineer", "Cora Founder"]);
    expect((await card(kzEngineer)).mentions).toEqual(["Erik Engineer", "Cora Founder"]);
    // Sam is on Startup alone and is not told who Erik is.
    expect((await card(usSales)).mentions).toEqual(["Cora Founder"]);
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe("reading notifications", () => {
  test("only the caller's own rows, newest first", async () => {
    const { t, cofounder, usSales } = await start();
    const sam = await userId(t, US_SALES);
    const cora = await userId(t, COFOUNDER);
    await give(t, sam, { title: "Older", createdAt: NOW - 2 });
    await give(t, cora, { title: "SECRET of Cora's" });
    await give(t, sam, { title: "Newer", createdAt: NOW - 1 });
    expect((await mine(usSales)).map((row) => row.title)).toEqual(["Newer", "Older"]);
    expect((await mine(cofounder)).map((row) => row.title)).toEqual(["SECRET of Cora's"]);
    expect(await usSales.query(api.notifications.unreadCount, {})).toBe(2);
    expect(await cofounder.query(api.notifications.unreadCount, {})).toBe(1);
  });

  test("a row about a company the caller is no longer on is neither sent nor counted", async () => {
    const { t, cofounder } = await start();
    const cora = await userId(t, COFOUNDER);
    await give(t, cora, { title: "SECRET kz task", company: "kz" });
    await give(t, cora, { title: "Startup task", company: "us" });
    await give(t, cora, { title: "Shared task" });
    expect(await cofounder.query(api.notifications.unreadCount, {})).toBe(3);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", COFOUNDER))
        .first();
      await ctx.db.patch(row!._id, { companies: ["us"] });
    });
    // Both sides sorted: the template renames the company, and with it the order.
    expect((await mine(cofounder)).map((row) => row.title).sort()).toEqual(["Startup task", "Shared task"].sort());
    expect(await cofounder.query(api.notifications.unreadCount, {})).toBe(2);
    // Not deleted: back on the company, it is theirs to read again.
    expect(await stored(t)).toHaveLength(3);
  });

  test("a deleted task's row still reads, from what was kept, with nothing to open", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Short-lived", assignee: US_SALES });
    expect((await mine(usSales))[0]!.taskId).toBe(id);
    await owner.mutation(api.tasks.remove, { id });
    expect(await mine(usSales)).toMatchObject([
      { kind: "assigned", title: "Short-lived", taskId: null, actor: { name: "Olga Owner" } },
    ]);
  });

  test("a task since moved to a company the caller is not on has nothing to open either", async () => {
    const { owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Shared once" });
    await owner.mutation(api.tasks.update, { id, mentions: [US_SALES] });
    await owner.mutation(api.tasks.update, { id, company: "kz" });
    expect(await mine(usSales)).toMatchObject([{ title: "Shared once", taskId: null }]);
  });

  test("someone who has since lost the board is still told, and is sent only what was kept", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    // A task is given only to someone with the board (`mayTakeWork`); the board can be taken away after.
    const reader = await signInWithAreas(t, "sales", ["finance", "board"]);
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", OWNER))
        .first();
      await ctx.db.patch(user!._id, { name: "Olga Owner" });
    });
    const id = await owner.mutation(api.tasks.create, {
      title: "For the reader",
      notes: "SECRET notes",
      assignee: memberEmail("sales"),
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", memberEmail("sales")))
        .first();
      await ctx.db.patch(row!._id, { areas: ["finance"] });
    });
    const rows = await mine(reader);
    expect(rows).toMatchObject([{ kind: "assigned", title: "For the reader", taskId: id }]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["actor", "column", "company", "createdAt", "decisionId", "due", "handoff", "id", "kind", "read", "summary", "taskId", "title", "to"].sort(),
    );
  });

  test("who did it is named only to someone who shares a company with them", async () => {
    const { t, kzEngineer } = await start();
    const erik = await userId(t, KZ_ENGINEER);
    await give(t, erik, { actor: { type: "user", userId: await userId(t, US_SALES) } });
    await give(t, erik, { actor: { type: "user", userId: await userId(t, COFOUNDER) }, createdAt: NOW - 1 });
    await give(t, erik, { actor: { type: "system", source: "standup" }, createdAt: NOW - 2 });
    expect((await mine(kzEngineer)).map((row) => row.actor)).toEqual([
      { type: "user", name: null },
      { type: "user", name: "Cora Founder" },
      { type: "system", source: "standup" },
    ]);
  });

  test("someone since removed from the team is not named", async () => {
    const { t, owner } = await start();
    await give(t, await userId(t, OWNER), {
      actor: { type: "user", userId: await userId(t, US_SALES) },
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", US_SALES))
        .first();
      await ctx.db.delete(row!._id);
    });
    expect((await mine(owner))[0]!.actor).toEqual({ type: "user", name: null });
  });

  test(`${NOTIFICATION_PAGE} at a time, with more on request`, async () => {
    const { t, usSales } = await start();
    const sam = await userId(t, US_SALES);
    for (let n = 0; n < NOTIFICATION_PAGE + 5; n += 1) {
      await give(t, sam, { title: `Row ${n}`, createdAt: NOW + n });
    }
    const first = await usSales.query(api.notifications.mine, {});
    expect(first.rows).toHaveLength(NOTIFICATION_PAGE);
    expect(first.more).toBe(true);
    expect(first.rows[0]!.title).toBe(`Row ${NOTIFICATION_PAGE + 4}`);
    const second = await usSales.query(api.notifications.mine, { count: NOTIFICATION_PAGE * 2 });
    expect(second.rows).toHaveLength(NOTIFICATION_PAGE + 5);
    expect(second.more).toBe(false);
    expect(second.rows.at(-1)!.title).toBe("Row 0");
  });

  test("a count that is no number, or far too large, is made safe", async () => {
    const { t, usSales } = await start();
    await give(t, await userId(t, US_SALES));
    for (const count of [Number.NaN, -3, 1e9]) {
      expect((await usSales.query(api.notifications.mine, { count })).rows).toHaveLength(1);
    }
  });

  test(`the unread count stops at ${UNREAD_COUNT_CAP}`, async () => {
    const { t, usSales } = await start();
    const sam = await userId(t, US_SALES);
    for (let n = 0; n < UNREAD_COUNT_CAP + 7; n += 1) await give(t, sam, { createdAt: NOW + n });
    expect(await usSales.query(api.notifications.unreadCount, {})).toBe(UNREAD_COUNT_CAP);
  });

  test("a teammate with no page at all is refused, as everywhere", async () => {
    const t = convexTest(schema, modules);
    const nobody = await signInWithAreas(t, "sales", []);
    await expect(nobody.query(api.notifications.mine, {})).rejects.toThrow("not_allowed");
    await expect(nobody.query(api.notifications.unreadCount, {})).rejects.toThrow("not_allowed");
    await expect(nobody.mutation(api.notifications.markAllRead, {})).rejects.toThrow("not_allowed");
  });
});

// ── Marking read ────────────────────────────────────────────────────────────

describe("marking read", () => {
  test("one row: read from then on, and no longer counted", async () => {
    const { t, usSales } = await start();
    const sam = await userId(t, US_SALES);
    const id = await give(t, sam);
    await give(t, sam, { createdAt: NOW - 1 });
    await usSales.mutation(api.notifications.markRead, { id });
    expect((await mine(usSales)).map((row) => row.read)).toEqual([true, false]);
    expect(await usSales.query(api.notifications.unreadCount, {})).toBe(1);
    expect((await stored(t)).find((row) => row._id === id)!.readAt).toBe(NOW);
    // Again is no change.
    vi.setSystemTime(NOW + 5);
    await usSales.mutation(api.notifications.markRead, { id });
    expect((await stored(t)).find((row) => row._id === id)!.readAt).toBe(NOW);
  });

  test("another person's row is refused in the words for one that is gone, and stays unread", async () => {
    const { t, cofounder, usSales } = await start();
    const theirs = await give(t, await userId(t, COFOUNDER));
    const gone = await give(t, await userId(t, US_SALES));
    await t.run((ctx) => ctx.db.delete(gone));
    await expect(usSales.mutation(api.notifications.markRead, { id: theirs })).rejects.toThrow(
      NOTIFICATION_GONE,
    );
    await expect(usSales.mutation(api.notifications.markRead, { id: gone })).rejects.toThrow(
      NOTIFICATION_GONE,
    );
    expect(await cofounder.query(api.notifications.unreadCount, {})).toBe(1);
  });

  test("the owner cannot mark a teammate's row either", async () => {
    const { t, owner } = await start();
    const theirs = await give(t, await userId(t, US_SALES));
    await expect(owner.mutation(api.notifications.markRead, { id: theirs })).rejects.toThrow(
      NOTIFICATION_GONE,
    );
    expect((await stored(t))[0]!.readAt).toBeUndefined();
  });

  test("all of them: the caller's, and nobody else's", async () => {
    const { t, cofounder, usSales } = await start();
    const sam = await userId(t, US_SALES);
    for (let n = 0; n < 3; n += 1) await give(t, sam, { createdAt: NOW + n });
    await give(t, await userId(t, COFOUNDER));
    await usSales.mutation(api.notifications.markAllRead, {});
    expect(await usSales.query(api.notifications.unreadCount, {})).toBe(0);
    expect((await mine(usSales)).every((row) => row.read)).toBe(true);
    expect(await cofounder.query(api.notifications.unreadCount, {})).toBe(1);
  });
});

// ── Keeping the table small ─────────────────────────────────────────────────

describe("retention", () => {
  test(`a person keeps the newest ${MAX_NOTIFICATIONS}: the oldest go as a new one is written`, async () => {
    const { t, owner, usSales } = await start();
    const sam = await userId(t, US_SALES);
    const cora = await userId(t, COFOUNDER);
    await t.run(async (ctx) => {
      const taskId = await ctx.db.insert("tasks", { title: "Old", kind: "task", column: "backlog", order: 9 });
      for (let n = 0; n < MAX_NOTIFICATIONS + 3; n += 1) {
        await ctx.db.insert("notifications", {
          recipient: n === 0 ? cora : sam,
          kind: "assigned",
          actor: { type: "system", source: "standup" },
          taskId,
          title: `Old ${n}`,
          createdAt: NOW - 10_000 + n,
        });
      }
    });
    await owner.mutation(api.tasks.create, { title: "Newest", assignee: US_SALES });
    const rows = (await stored(t)).filter((row) => row.recipient === sam);
    expect(rows).toHaveLength(MAX_NOTIFICATIONS);
    const titles = rows.map((row) => row.title);
    expect(titles).toContain("Newest");
    expect(titles).not.toContain("Old 1");
    expect(titles).not.toContain("Old 3");
    expect(titles).toContain("Old 4");
    // Another person's oldest row is not this person's to lose.
    expect((await stored(t)).filter((row) => row.recipient === cora)).toHaveLength(1);
    expect((await mine(usSales))[0]!.title).toBe("Newest");
  });

  test(`the daily sweep deletes what is older than ${NOTIFICATION_RETENTION_DAYS} days, and nothing newer`, async () => {
    const { t } = await start();
    const sam = await userId(t, US_SALES);
    const cutoff = NOW - NOTIFICATION_RETENTION_DAYS * DAY;
    await give(t, sam, { title: "Too old", createdAt: cutoff - 1 });
    await give(t, sam, { title: "Old and read", createdAt: cutoff - DAY, readAt: 1 });
    await give(t, sam, { title: "On the line", createdAt: cutoff });
    await give(t, sam, { title: "Recent" });
    await t.mutation(internal.notifications.prune, {});
    expect((await stored(t)).map((row) => row.title).sort()).toEqual(["On the line", "Recent"]);
  });

  test("a sweep with more to do than one run takes schedules its own next one", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const { t } = await start();
    const sam = await userId(t, US_SALES);
    await t.run(async (ctx) => {
      const taskId = await ctx.db.insert("tasks", { title: "Old", kind: "task", column: "backlog", order: 0 });
      for (let n = 0; n < 520; n += 1) {
        await ctx.db.insert("notifications", {
          recipient: sam,
          kind: "assigned",
          actor: { type: "system", source: "standup" },
          taskId,
          title: "Old",
          createdAt: n,
        });
      }
    });
    await t.mutation(internal.notifications.prune, {});
    expect(await stored(t)).toHaveLength(20);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((job) => [job.name, job.args])).toEqual([["notifications:prune", [{}]]]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await stored(t)).toEqual([]);
  });

  test("the sweep is on the daily schedule", async () => {
    const crons = (await import("./crons")).default;
    const jobs = Object.entries((crons as unknown as { crons: Record<string, { name: string; schedule: { type: string } }> }).crons);
    const job = jobs.find(([name]) => name === "prune notifications");
    expect(job?.[1]).toMatchObject({ name: "notifications:prune", schedule: { type: "daily" } });
  });
});

// ── Nothing but ids ─────────────────────────────────────────────────────────

test("a stored row holds no name and no address", async () => {
  const { t, owner } = await start();
  const id = await owner.mutation(api.tasks.create, { title: "Pass it on", assignee: US_SALES });
  await owner.mutation(api.tasks.update, { id, assignee: COFOUNDER, mentions: [US_SALES] });
  const text = JSON.stringify(await stored(t));
  expect(text).not.toMatch(/@|Olga|Sam Sales|Cora/);
});
