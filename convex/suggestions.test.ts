import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { MAX_SUGGESTIONS_PER_DAY, SUGGESTION_WORDS } from "./lib/suggestion";
import schema from "./schema";
import {
  OWNER,
  memberEmail,
  modules,
  signInAs,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// "Suggest a change": who may send one, what is refused, the card it makes and
// who is told what about it. Every name and address here is made up.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const start = () => convexTest(schema, modules);
const tasks = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());
const sentRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("suggestionsSent").collect());
const TEXT = "Show which month is still open";

/** Give a user a name, as Google does when they first sign in. */
const named = async (t: TestBackend, email: string, name: string) =>
  t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    await ctx.db.patch(user!._id, { name });
  });

describe("who may send a suggestion", () => {
  test("the owner, and a teammate of every role", async () => {
    const t = start();
    for (const signIn of [signInAsOwner, signInAsCofounder, signInAsSales, signInAsEngineer]) {
      const client = await signIn(t);
      expect(await client.mutation(api.suggestions.create, { text: TEXT })).toBeNull();
    }
    expect(await tasks(t)).toHaveLength(4);
  });

  test("a teammate with one page that is not the board", async () => {
    const t = start();
    const client = await signInWithAreas(t, "sales", ["finance"]);
    await client.mutation(api.suggestions.create, { text: TEXT });
    expect(await tasks(t)).toHaveLength(1);
  });

  test("a teammate with no page at all is refused, as everywhere", async () => {
    const t = start();
    const client = await signInWithAreas(t, "sales", []);
    await expect(client.mutation(api.suggestions.create, { text: TEXT })).rejects.toThrow(
      "not_allowed",
    );
    expect(await tasks(t)).toHaveLength(0);
  });

  test("a signed-out caller and a stranger are refused", async () => {
    const t = start();
    await expect(t.mutation(api.suggestions.create, { text: TEXT })).rejects.toThrow("not_allowed");
    const stranger = await signInAs(t, { email: "nobody@gmail.com", emailVerificationTime: 1 });
    await expect(stranger.mutation(api.suggestions.create, { text: TEXT })).rejects.toThrow(
      "not_allowed",
    );
    expect(await tasks(t)).toHaveLength(0);
    expect(await sentRows(t)).toHaveLength(0);
  });
});

describe("what is refused", () => {
  test.each([
    ["too short", { text: "Hmm" }, SUGGESTION_WORDS.too_short],
    ["blank", { text: "   \n  " }, SUGGESTION_WORDS.too_short],
    ["too long", { text: "x".repeat(501) }, SUGGESTION_WORDS.too_long],
    ["a page too long", { text: TEXT, page: "p".repeat(201) }, SUGGESTION_WORDS.page_too_long],
  ])("%s, in fixed words, and nothing is written", async (_name, args, words) => {
    const t = start();
    const client = await signInAsSales(t);
    await expect(client.mutation(api.suggestions.create, args)).rejects.toThrow(words);
    expect(await tasks(t)).toHaveLength(0);
    expect(await sentRows(t)).toHaveLength(0);
  });

  test("no refusal quotes what was typed", async () => {
    const t = start();
    const client = await signInAsSales(t);
    const error = await client
      .mutation(api.suggestions.create, { text: "SECRET ".repeat(100) })
      .catch((e: Error) => e.message);
    expect(error).toContain(SUGGESTION_WORDS.too_long);
    expect(error).not.toContain("SECRET");
  });
});

describe("the card a suggestion makes", () => {
  test("a shared task at the bottom of Backlog, with its origin and who made it", async () => {
    const t = start();
    await t.run((ctx) =>
      ctx.db.insert("tasks", { title: "Already there", kind: "task", column: "backlog", order: 0 }),
    );
    const client = await signInAsSales(t, ["us"]);
    await client.mutation(api.suggestions.create, {
      text: `${TEXT}\nIt took me a while to see why October looked low.`,
      page: "/finance",
    });
    const [, card] = await tasks(t);
    const suggester = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", memberEmail("sales", ["us"])))
        .first(),
    );
    expect(card).toMatchObject({
      title: TEXT,
      notes: "It took me a while to see why October looked low.\n\nPage: /finance",
      kind: "task",
      column: "backlog",
      order: 1,
      origin: { source: "suggestion" },
      createdBy: suggester!._id,
    });
    // Shared by both companies, given to nobody, with no date or goal.
    for (const field of ["company", "assignee", "due", "goalId", "doneAt"] as const) {
      expect(card).not.toHaveProperty(field);
    }
  });

  test("the text is cleaned before it is stored", async () => {
    const t = start();
    const client = await signInAsSales(t);
    await client.mutation(api.suggestions.create, {
      text: "  Fix\u0000 the​ page‮ now  \n\n",
      page: " /gtm\u0007 ",
    });
    expect((await tasks(t))[0]).toMatchObject({ title: "Fix the page now", notes: "Page: /gtm" });
  });

  test("the mutation returns nothing: not the card, its id or anything of the board", async () => {
    const t = start();
    const client = await signInWithAreas(t, "sales", ["finance"]);
    expect(await client.mutation(api.suggestions.create, { text: TEXT })).toBeNull();
  });
});

describe("who sees the card, and what they are told", () => {
  test("someone without the board cannot read it back, though it landed there", async () => {
    const t = start();
    const sender = await signInWithAreas(t, "sales", ["finance"]);
    await sender.mutation(api.suggestions.create, { text: TEXT });
    await expect(sender.query(api.tasks.board, {})).rejects.toThrow("not_allowed");
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.tasks.board, {})).backlog.map((c) => c.title)).toEqual([TEXT]);
  });

  test("the board says who suggested it by name, and never by address", async () => {
    const t = start();
    const sender = await signInAsSales(t, ["us"]);
    await named(t, memberEmail("sales", ["us"]), "Sam Placeholder");
    await sender.mutation(api.suggestions.create, { text: TEXT });

    const owner = await signInAsOwner(t);
    const [card] = (await owner.query(api.tasks.board, {})).backlog;
    expect(card!.origin).toEqual({ source: "suggestion", suggestedBy: "Sam Placeholder" });
    expect(JSON.stringify(card)).not.toContain(memberEmail("sales", ["us"]));
    // Everyone on a company the sender is on is told the same.
    const colleague = await signInAsEngineer(t, ["us"]);
    expect((await colleague.query(api.tasks.board, {})).backlog[0]!.origin).toEqual(card!.origin);
  });

  test("a teammate who shares no company with the sender sees the card, unnamed", async () => {
    const t = start();
    const sender = await signInAsSales(t, ["us"]);
    await named(t, memberEmail("sales", ["us"]), "Sam Placeholder");
    await sender.mutation(api.suggestions.create, { text: TEXT });
    const elsewhere = await signInAsEngineer(t, ["kz"]);
    const [card] = (await elsewhere.query(api.tasks.board, {})).backlog;
    expect(card).toMatchObject({ title: TEXT, company: null });
    expect(card!.origin).toEqual({ source: "suggestion", suggestedBy: null });
    expect(JSON.stringify(card)).not.toContain("Sam Placeholder");
  });

  test("the owner's own suggestion is named to everyone: the owner is on both companies", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await named(t, OWNER, "Owner Example");
    await owner.mutation(api.suggestions.create, { text: TEXT });
    const engineer = await signInAsEngineer(t, ["kz"]);
    expect((await engineer.query(api.tasks.board, {})).backlog[0]!.origin).toEqual({
      source: "suggestion",
      suggestedBy: "Owner Example",
    });
  });

  test("a sender since removed from the team is no longer named", async () => {
    const t = start();
    const sender = await signInAsSales(t, ["us"]);
    await named(t, memberEmail("sales", ["us"]), "Sam Placeholder");
    await sender.mutation(api.suggestions.create, { text: TEXT });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("members").collect()) await ctx.db.delete(row._id);
    });
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.tasks.board, {})).backlog[0]!.origin).toEqual({
      source: "suggestion",
      suggestedBy: null,
    });
  });

  test("a sender with no name on record is unnamed, not shown by address", async () => {
    const t = start();
    const sender = await signInAsSales(t, ["us"]);
    await sender.mutation(api.suggestions.create, { text: TEXT });
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.tasks.board, {})).backlog[0]!.origin).toEqual({
      source: "suggestion",
      suggestedBy: null,
    });
  });

  test("a card from the standup still reads as it did", async () => {
    const t = start();
    const origin = { source: "standup" as const, meetingDate: "2026-10-12", meetingId: "m1" };
    await t.run((ctx) =>
      ctx.db.insert("tasks", { title: "From it", kind: "task", column: "backlog", order: 0, origin }),
    );
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.tasks.board, {})).backlog[0]!.origin).toEqual(origin);
  });

  test("a suggested issue on the scorecard carries the same origin", async () => {
    const t = start();
    const sender = await signInAsSales(t);
    await sender.mutation(api.suggestions.create, { text: TEXT });
    await t.run(async (ctx) => {
      const [card] = await ctx.db.query("tasks").collect();
      await ctx.db.patch(card!._id, { kind: "issue" });
    });
    const [issue] = await sender.query(api.tasks.openIssues, {});
    expect(issue!.origin).toEqual({ source: "suggestion", suggestedBy: null });
  });
});

describe("the limit: so many a day, each person", () => {
  const fill = async (client: Awaited<ReturnType<typeof signInAsSales>>) => {
    for (let i = 0; i < MAX_SUGGESTIONS_PER_DAY; i += 1) {
      await client.mutation(api.suggestions.create, { text: `Suggestion number ${i}` });
    }
  };

  test("the one after the last is refused in fixed words, and adds no card", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T10:00:00Z"));
    const t = start();
    const client = await signInAsSales(t);
    await fill(client);
    await expect(client.mutation(api.suggestions.create, { text: TEXT })).rejects.toThrow(
      SUGGESTION_WORDS.too_many,
    );
    expect(await tasks(t)).toHaveLength(MAX_SUGGESTIONS_PER_DAY);
    expect(await sentRows(t)).toHaveLength(MAX_SUGGESTIONS_PER_DAY);
  });

  test("it is each person's own: someone else can still send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T10:00:00Z"));
    const t = start();
    await fill(await signInAsSales(t));
    const other = await signInAsEngineer(t);
    expect(await other.mutation(api.suggestions.create, { text: TEXT })).toBeNull();
  });

  test("deleting the cards does not give the day back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T10:00:00Z"));
    const t = start();
    const client = await signInAsSales(t);
    await fill(client);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("tasks").collect()) await ctx.db.delete(row._id);
    });
    await expect(client.mutation(api.suggestions.create, { text: TEXT })).rejects.toThrow(
      SUGGESTION_WORDS.too_many,
    );
  });

  test("the next UTC day starts again, and yesterday's count is forgotten", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T23:50:00Z"));
    const t = start();
    const client = await signInAsSales(t);
    await fill(client);
    vi.setSystemTime(Date.parse("2026-10-14T00:05:00Z"));
    expect(await client.mutation(api.suggestions.create, { text: TEXT })).toBeNull();
    const rows = await sentRows(t);
    expect(rows.map((row) => row.day)).toEqual(["2026-10-14"]);
  });

  test("what the limit counts holds no text", async () => {
    const t = start();
    const client = await signInAsSales(t);
    await client.mutation(api.suggestions.create, { text: "SECRET wording of a suggestion" });
    expect(JSON.stringify(await sentRows(t))).not.toContain("SECRET");
  });
});
