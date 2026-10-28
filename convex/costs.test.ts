import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { NO_ACCOUNT_NUMBERS } from "./lib/costs";
import { MAX_COST_LINES } from "./lib/limits";
import {
  GRANTABLE_AREAS,
  MEMBER_ROLES,
  PAY_AND_COSTS_ARE_THE_OWNERS,
  PRESET_AREAS,
  areasOf,
  isSensitiveArea,
} from "./lib/roles";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAsMember,
  signInAsOwner,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// Costs: what a company pays for besides pay. Every vendor, note and amount
// here is made up; what must reach nobody without the area carries SECRET.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 13, 6));
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Client = Awaited<ReturnType<typeof signInAsOwner>>;
const OCT = "2026-10";
const US_AMOUNT = 765_432_19;
const KZ_AMOUNT = 876_543_21;

const start = () => convexTest(schema, modules);

/** One line per company, written straight to the table. */
async function seed(t: TestBackend) {
  return await t.run(async (ctx) => {
    const line = (company: "us" | "kz", amount: number) =>
      ctx.db.insert("costs", {
        company,
        name: `SECRET ${company} VENDOR`,
        category: "cloud",
        amount,
        currency: company === "us" ? "USD" : "KZT",
        cadence: "monthly",
        startsOn: "2026-01",
        variable: false,
        paidBy: `SECRET ${company} PAYER`,
        note: `SECRET ${company} NOTE`,
        createdAt: 1,
        updatedAt: 1,
      });
    return { us: await line("us", US_AMOUNT), kz: await line("kz", KZ_AMOUNT) };
  });
}
type Ids = Awaited<ReturnType<typeof seed>>;

const base = { name: "Example Cloud", category: "cloud", amount: 100_00, cadence: "monthly", startsOn: OCT } as const;
const rows = (t: TestBackend) => t.run((ctx) => ctx.db.query("costs").collect());

/** Every costs function, aimed at one company's line. */
const CALLS: Record<string, (c: Client, company: "us" | "kz", ids: Ids) => Promise<unknown>> = {
  list: (c, company) => c.query(api.costs.list, { company }),
  summary: (c, company) => c.query(api.costs.summary, { company, month: OCT }),
  add: (c, company) => c.mutation(api.costs.add, { company, ...base }),
  update: (c, company, ids) => c.mutation(api.costs.update, { id: ids[company], name: "Theirs" }),
  archive: (c, company, ids) => c.mutation(api.costs.archive, { id: ids[company] }),
  restore: (c, company, ids) => c.mutation(api.costs.restore, { id: ids[company] }),
  remove: (c, company, ids) => c.mutation(api.costs.remove, { id: ids[company] }),
};

const said = async (call: Promise<unknown>) =>
  JSON.stringify(
    await call.then(
      (value) => value ?? null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
  );
const leaks = (text: string) =>
  text.includes("SECRET") || text.includes(String(US_AMOUNT)) || text.includes(String(KZ_AMOUNT));

describe("the costs area", () => {
  test("is the owner's alone: it cannot be given, and no role's starting set or usual pages holds it", () => {
    expect(GRANTABLE_AREAS).not.toContain("costs");
    expect(isSensitiveArea("costs")).toBe(false);
    expect(PRESET_AREAS).not.toContain("costs");
    for (const role of MEMBER_ROLES) expect(areasOf(role)).not.toContain("costs");
    expect(areasOf("owner")).toContain("costs");
  });

  test("there are seven functions, each gated by the costs area alone, and this file calls each", async () => {
    const loaded = (await modules["./costs.ts"]!()) as Record<string, unknown>;
    const exposed = Object.entries(loaded).filter(
      ([, value]) => typeof value === "function" && (value as { isPublic?: boolean }).isPublic === true,
    );
    expect(exposed.map(([name]) => name).sort()).toEqual(Object.keys(CALLS).sort());
    expect(exposed).toHaveLength(7);
    for (const [name, value] of exposed) {
      expect([name, (value as { gate?: unknown }).gate]).toEqual([name, { areas: ["costs"] }]);
    }
  });

  test.each(Object.keys(CALLS))("%s is refused to a teammate with every other page, and tells nothing", async (name) => {
    const t = start();
    const ids = await seed(t);
    const before = await rows(t);
    const teammate = await signInWithAreas(t, "cofounder", [...GRANTABLE_AREAS]);
    const text = await said(CALLS[name]!(teammate, "kz", ids));
    expect(text).toContain("not_allowed");
    expect(leaks(text)).toBe(false);
    expect(await rows(t)).toEqual(before);
  });

  test.each(Object.keys(CALLS))("%s is refused to a row that still says Payroll and Costs", async (name) => {
    const t = start();
    const ids = await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["payroll", "costs", "finance"]);
    await expect(CALLS[name]!(holder, "us", ids)).rejects.toThrow("not_allowed");
  });

  test("a row that still says Costs opens Payroll no more than Costs", async () => {
    const t = start();
    const holder = await signInWithAreas(t, "engineer", ["costs"]);
    await expect(holder.query(api.payroll.listPeople, { company: "us" })).rejects.toThrow("not_allowed");
    await expect(holder.query(api.payroll.listLines, { company: "kz" })).rejects.toThrow("not_allowed");
  });

  test.each(Object.keys(CALLS))(
    "%s refuses a row on Globex that says Costs, aimed at Startup, and tells and changes nothing",
    async (name) => {
      const t = start();
      const ids = await seed(t);
      const before = await rows(t);
      const holder = await signInWithAreas(t, "engineer", ["costs"], ["kz"]);
      const text = await said(CALLS[name]!(holder, "us", ids));
      expect(text).toContain("not_allowed");
      expect(leaks(text)).toBe(false);
      expect(await rows(t)).toEqual(before);
    },
  );

  test("the same the other way round: a row on Startup cannot reach Globex's", async () => {
    const t = start();
    const ids = await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["costs"], ["us"]);
    for (const name of Object.keys(CALLS)) {
      await expect(CALLS[name]!(holder, "kz", ids)).rejects.toThrow("not_allowed");
    }
  });

  test("what a line counts as is the owner's to mark; a row that says Costs marks nothing", async () => {
    const t = start();
    const ids = await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["costs"], ["kz"]);
    await expect(holder.mutation(api.costs.update, { id: ids.kz, bucket: "operating" })).rejects.toThrow("not_allowed");
    expect((await rows(t)).map((row) => row.bucket)).toEqual([undefined, undefined]);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.costs.update, { id: ids.kz, bucket: "sales_marketing" });
    expect((await rows(t)).map((row) => row.bucket)).toEqual([undefined, "sales_marketing"]);
  });

  test("the owner is sent both companies' lines; a row on Globex that says Costs, neither", async () => {
    const t = start();
    await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["costs"], ["kz"]);
    const text = await said(holder.query(api.costs.list, { company: "kz" }));
    expect(text).toContain("not_allowed");
    expect(leaks(text)).toBe(false);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.costs.list, { company: "us" })).toHaveLength(1);
    expect(await owner.query(api.costs.list, { company: "kz" })).toHaveLength(1);
  });

  test("writing Costs onto a row by hand opens nothing on the next call", async () => {
    const t = start();
    await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["board"], ["kz"]);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", "engineer.kz@gmail.com"))
        .unique();
      await ctx.db.patch(row!._id, { areas: ["board", "costs"] });
    });
    await expect(holder.query(api.costs.list, { company: "kz" })).rejects.toThrow("not_allowed");
  });
});

describe("nobody gives Costs: it is the owner's alone", () => {
  const teammate = {
    email: "new.person@gmail.com",
    role: "engineer" as const,
    companies: ["kz" as const],
  };

  test("the owner cannot tick it for a person", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.team.add, { ...teammate, areas: ["board", "costs"] })).rejects.toThrow(
      PAY_AND_COSTS_ARE_THE_OWNERS,
    );
    expect(await owner.query(api.team.list, {})).toEqual([]);
  });

  test("nor can a team manager", async () => {
    const t = start();
    const manager = await signInAsMember(t, "cofounder", ["kz"], "manager.kz@gmail.com", ["team"]);
    await expect(
      manager.mutation(api.team.add, {
        email: "another.person@gmail.com",
        role: "engineer",
        companies: ["kz"],
        areas: ["costs"],
      }),
    ).rejects.toThrow(PAY_AND_COSTS_ARE_THE_OWNERS);
  });

  test("a role's usual pages cannot hold it", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.roles.create, { name: "Made-up role", focus: "general", areas: ["costs"] }),
    ).rejects.toThrow(PAY_AND_COSTS_ARE_THE_OWNERS);
  });
});

describe("adding and changing a line", () => {
  async function owned() {
    const t = start();
    return { t, owner: await signInAsOwner(t) };
  }

  test("a line is stored cleaned, in the company's currency unless another is said", async () => {
    const { t, owner } = await owned();
    await owner.mutation(api.costs.add, {
      company: "kz",
      name: "  Office​ rent ",
      category: "office",
      amount: 450_000_00,
      cadence: "monthly",
      startsOn: OCT,
      paidBy: " Kaspi ",
      note: "Made-up note",
    });
    await owner.mutation(api.costs.add, { company: "kz", ...base, currency: "USD", variable: true });
    const stored = await rows(t);
    expect(stored.map((row) => [row.name, row.currency, row.variable, row.paidBy ?? null])).toEqual([
      ["Office rent", "KZT", false, "Kaspi"],
      ["Example Cloud", "USD", true, null],
    ]);
    expect(stored[0]!.createdAt).toBe(Date.UTC(2026, 9, 13, 6));
    expect(stored[0]!.updatedAt).toBe(stored[0]!.createdAt);
  });

  test.each([
    [{ name: "   " }, "A cost needs a name."],
    [{ name: "x".repeat(81) }, "That name is too long (80 characters at most)."],
    [{ paidBy: "x".repeat(61) }, "That “paid by” is too long (60 characters at most)."],
    [{ note: "x".repeat(301) }, "That note is too long (300 characters at most)."],
    [{ amount: 0 }, "The amount must be a whole amount above zero."],
    [{ amount: -5 }, "The amount must be a whole amount above zero."],
    [{ amount: 10.5 }, "The amount must be a whole amount above zero."],
    [{ amount: 100_000_000_001 }, "The amount is too large."],
    [{ startsOn: "2026-10-01" }, "The start is not a month."],
    [{ startsOn: "2026-13" }, "The start is not a month."],
    [{ endsOn: "soon" }, "The end is not a month."],
    [{ endsOn: "2026-09" }, "The end is before the start."],
  ])("%j is refused: %s", async (extra, message) => {
    const { t, owner } = await owned();
    await expect(owner.mutation(api.costs.add, { company: "us", ...base, ...extra })).rejects.toThrow(message);
    expect(await rows(t)).toEqual([]);
  });

  test.each(["name", "note", "paidBy"] as const)(
    "a %s that looks like a card or account number is refused in fixed words, and is not echoed",
    async (field) => {
      const { t, owner } = await owned();
      const text = await said(
        owner.mutation(api.costs.add, { company: "us", ...base, [field]: "card 4111 1111 1111 1111" }),
      );
      expect(text).toContain(NO_ACCOUNT_NUMBERS);
      expect(text).not.toContain("4111");
      expect(await rows(t)).toEqual([]);
    },
  );

  test("an edit is held to the same check", async () => {
    const { t, owner } = await owned();
    const id = await owner.mutation(api.costs.add, { company: "us", ...base });
    await expect(owner.mutation(api.costs.update, { id, note: "KZ86125KZT5004100100" })).rejects.toThrow(
      NO_ACCOUNT_NUMBERS,
    );
    expect((await rows(t))[0]!.note).toBeUndefined();
  });

  test("what a line counts as is stored only when chosen, listed as chosen, and cleared with null", async () => {
    const { t, owner } = await owned();
    const chosen = await owner.mutation(api.costs.add, { company: "us", ...base, category: "software", bucket: "cogs" });
    const left = await owner.mutation(api.costs.add, { company: "us", ...base, name: "Example Ads", category: "marketing" });
    const stored = await rows(t);
    expect(stored.map((row) => row.bucket)).toEqual(["cogs", undefined]);
    // The list says what was chosen; none is null, and the page reads the category's default.
    const listed = await owner.query(api.costs.list, { company: "us" });
    expect(Object.fromEntries(listed.map((line) => [line.id, line.bucket]))).toEqual({ [chosen]: "cogs", [left]: null });

    await owner.mutation(api.costs.update, { id: left, bucket: "operating" });
    await owner.mutation(api.costs.update, { id: chosen, name: "Example Model API" });
    expect((await rows(t)).map((row) => row.bucket)).toEqual(["cogs", "operating"]);
    await owner.mutation(api.costs.update, { id: chosen, bucket: null });
    expect((await rows(t)).map((row) => row.bucket)).toEqual([undefined, "operating"]);
  });

  test("a bucket that is not one of the three is refused before anything is written", async () => {
    const { t, owner } = await owned();
    await expect(
      owner.mutation(api.costs.add, { company: "us", ...base, bucket: "payroll" as "cogs" }),
    ).rejects.toThrow('Expected one of literal, literal, literal, got `"payroll"`');
    expect(await rows(t)).toEqual([]);
  });

  test("a one-off keeps no end", async () => {
    const { t, owner } = await owned();
    await owner.mutation(api.costs.add, { company: "us", ...base, cadence: "once", endsOn: "2027-01" });
    expect((await rows(t))[0]!.endsOn).toBeUndefined();
  });

  test("an edit changes what it names, clears with null, and stamps the change", async () => {
    const { t, owner } = await owned();
    const id = await owner.mutation(api.costs.add, {
      company: "us",
      ...base,
      endsOn: "2027-03",
      paidBy: "Mercury card",
      note: "Made-up",
    });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 6));
    await owner.mutation(api.costs.update, { id, amount: 250_00, endsOn: null, paidBy: null, variable: true });
    const [row] = await rows(t);
    expect([row!.amount, row!.endsOn, row!.paidBy, row!.note, row!.variable, row!.name]).toEqual([
      250_00, undefined, undefined, "Made-up", true, "Example Cloud",
    ]);
    expect(row!.updatedAt).toBe(Date.UTC(2026, 9, 14, 6));
    expect(row!.createdAt).toBe(Date.UTC(2026, 9, 13, 6));
  });

  test("an edit cannot leave the end before the start", async () => {
    const { owner } = await owned();
    const id = await owner.mutation(api.costs.add, { company: "us", ...base, endsOn: "2027-03" });
    await expect(owner.mutation(api.costs.update, { id, startsOn: "2027-04" })).rejects.toThrow(
      "The end is before the start.",
    );
    await expect(owner.mutation(api.costs.update, { id, amount: 0 })).rejects.toThrow(
      "The amount must be a whole amount above zero.",
    );
  });

  test("a line that is gone says so", async () => {
    const { t, owner } = await owned();
    const id = await owner.mutation(api.costs.add, { company: "us", ...base });
    await t.run((ctx) => ctx.db.delete(id));
    for (const call of [
      owner.mutation(api.costs.update, { id, name: "x" }),
      owner.mutation(api.costs.archive, { id }),
      owner.mutation(api.costs.restore, { id }),
    ]) {
      await expect(call).rejects.toThrow("That line no longer exists.");
    }
    expect(await owner.mutation(api.costs.remove, { id })).toBeNull();
  });

  test("archive and restore; only an archived line is deleted", async () => {
    const { t, owner } = await owned();
    const id = await owner.mutation(api.costs.add, { company: "us", ...base });
    await expect(owner.mutation(api.costs.remove, { id })).rejects.toThrow(
      "Archive the line first: only an archived line is deleted.",
    );
    await owner.mutation(api.costs.archive, { id });
    expect((await rows(t))[0]!.archivedAt).toBe(Date.UTC(2026, 9, 13, 6));
    const summary = await owner.query(api.costs.summary, { company: "us", month: OCT });
    expect(summary.currencies[0]!.runRate).toBe(0);
    await owner.mutation(api.costs.restore, { id });
    expect((await rows(t))[0]!.archivedAt).toBeUndefined();
    await owner.mutation(api.costs.archive, { id });
    await owner.mutation(api.costs.remove, { id });
    expect(await rows(t)).toEqual([]);
  });

  test("a company holds 300 active lines at most, counted apart from the other company's and from archived ones", async () => {
    const { t, owner } = await owned();
    const archived = await t.run(async (ctx) => {
      const make = (company: "us" | "kz", archivedAt?: number) =>
        ctx.db.insert("costs", {
          company,
          name: "Made-up line",
          category: "other",
          amount: 1_00,
          currency: "USD",
          cadence: "monthly",
          startsOn: OCT,
          variable: false,
          createdAt: 1,
          updatedAt: 1,
          archivedAt,
        });
      for (let n = 0; n < MAX_COST_LINES - 1; n++) await make("us");
      await make("kz");
      return await make("us", 5);
    });
    await owner.mutation(api.costs.add, { company: "us", ...base });
    const full = "That is every line a company can have (300 at most). Archive one first.";
    await expect(owner.mutation(api.costs.add, { company: "us", ...base })).rejects.toThrow(full);
    await expect(owner.mutation(api.costs.restore, { id: archived })).rejects.toThrow(full);
    await owner.mutation(api.costs.add, { company: "kz", ...base });
  });

  test("no name, note or amount is written to any other table", async () => {
    const { t, owner } = await owned();
    const id = await owner.mutation(api.costs.add, {
      company: "us",
      ...base,
      name: "SECRET VENDOR",
      note: "SECRET NOTE",
      amount: US_AMOUNT,
    });
    await owner.mutation(api.costs.update, { id, paidBy: "SECRET PAYER" });
    await owner.mutation(api.costs.archive, { id });
    const others = await t.run(async (ctx) => {
      const found: unknown[] = [];
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
        if (table !== "costs") found.push(...(await ctx.db.query(table).collect()));
      }
      return JSON.stringify(found);
    });
    expect(leaks(others)).toBe(false);
  });
});

describe("the summary", () => {
  const fx = (t: TestBackend, value: number, periodStart = "2026-09-01") =>
    t.run((ctx) =>
      ctx.db.insert("metricSnapshots", {
        key: "fx_usd_kzt",
        scope: "company",
        period: "month",
        periodStart,
        value,
        source: "cfo_workbook",
        syncedAt: 1,
      }),
    );

  async function mixed() {
    const t = start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.costs.add, { company: "kz", ...base, amount: 500_000_00, category: "office" });
    await owner.mutation(api.costs.add, { company: "kz", ...base, amount: 100_00, currency: "USD", variable: true });
    await owner.mutation(api.costs.add, {
      company: "kz",
      ...base,
      cadence: "yearly",
      amount: 1_200_000_00,
      startsOn: "2026-12",
    });
    return { t, owner };
  }

  test("is the pure arithmetic over the company's lines: run-rate and cash due apart, per currency", async () => {
    const { owner } = await mixed();
    const summary = await owner.query(api.costs.summary, { company: "kz", month: OCT });
    expect(summary.month).toBe(OCT);
    expect([summary.lines, summary.estimates]).toEqual([2, 1]);
    expect(summary.currencies.map((c) => [c.currency, c.runRate, c.cashDue, c.next3])).toEqual([
      ["KZT", 500_000_00, 500_000_00, 1_500_000_00 + 1_200_000_00],
      ["USD", 100_00, 100_00, 300_00],
    ]);
  });

  test("with no exchange rate on record the total across currencies is not known, and nothing is guessed", async () => {
    const { owner } = await mixed();
    const summary = await owner.query(api.costs.summary, { company: "kz", month: OCT });
    expect(summary.combined).toEqual({ kind: "unknown" });
    expect(summary.fx).toBeNull();
  });

  test("with one, the total is in US dollars at the latest stored rate, which is named", async () => {
    const { t, owner } = await mixed();
    await fx(t, 400, "2026-08-01");
    await fx(t, 500, "2026-09-01");
    const summary = await owner.query(api.costs.summary, { company: "kz", month: OCT });
    expect(summary.fx).toEqual({ rate: 500, periodStart: "2026-09-01" });
    expect(summary.combined).toMatchObject({ kind: "converted", currency: "USD", rate: 500, runRate: 1_100_00 });
  });

  test("the other company's lines are in neither", async () => {
    const { owner } = await mixed();
    const us = await owner.query(api.costs.summary, { company: "us", month: OCT });
    expect(us.currencies.map((c) => [c.currency, c.runRate])).toEqual([["USD", 0]]);
    expect(us.lines).toBe(0);
  });

  test("a month that is no month is refused", async () => {
    const { owner } = await mixed();
    await expect(owner.query(api.costs.summary, { company: "kz", month: "2026-10-01" })).rejects.toThrow(
      "That is not a month.",
    );
  });
});
