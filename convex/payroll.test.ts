import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  MAX_LINE_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PAYROLL_AMOUNT,
  MAX_PAYROLL_LINES,
  MAX_PAYROLL_NOTE_LENGTH,
  MAX_PAYROLL_PEOPLE,
  MAX_RUN_CELLS,
} from "./lib/limits";
import schema from "./schema";
import { OWNER, modules, signInAsOwner } from "./test.setup";

// Every name, salary and rate here is made up. None is a statutory figure.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Owner = Awaited<ReturnType<typeof signInAsOwner>>;
type Company = "us" | "kz";
const SEP = "2026-09-01";
const OCT = "2026-10-01";

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  return { t, owner };
};

const addPerson = (owner: Owner, extra: Record<string, unknown> = {}) =>
  owner.mutation(api.payroll.createPerson, {
    company: "kz",
    name: "Ada Example",
    kind: "employee",
    monthlyGross: 500_000_00,
    ...extra,
  } as never) as Promise<Id<"payrollPeople">>;
const addLine = (owner: Owner, extra: Record<string, unknown> = {}) =>
  owner.mutation(api.payroll.createLine, {
    company: "kz",
    appliesTo: "employee",
    name: "Pension",
    paidBy: "employee",
    rateBp: 1000,
    ...extra,
  } as never) as Promise<Id<"payrollLines">>;
const people = (owner: Owner, company: Company = "kz") =>
  owner.query(api.payroll.listPeople, { company });
const lines = (owner: Owner, company: Company = "kz") =>
  owner.query(api.payroll.listLines, { company });
const prepare = (owner: Owner, month = SEP, company: Company = "kz") =>
  owner.mutation(api.payroll.prepareRun, { company, month });
const run = (owner: Owner, month = SEP, company: Company = "kz") =>
  owner.query(api.payroll.getRun, { company, month });
const saved = async (owner: Owner, month = SEP) => (await run(owner, month))!;

// ── When it last changed (the page header's "last change") ──────────────────

describe("payroll: when a person or a line last changed", () => {
  test("made, then edited, archived or reordered: each moves it on", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 1));
      const { owner } = await start();
      const ada = await addPerson(owner);
      const pension = await addLine(owner);
      const tax = await addLine(owner, { name: "Income tax" });
      expect((await people(owner))[0]!.changedAt).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 1));
      vi.setSystemTime(Date.UTC(2026, 9, 3));
      await owner.mutation(api.payroll.updatePerson, { id: ada, title: "Engineer" });
      expect((await people(owner))[0]!.changedAt).toBe(Date.UTC(2026, 9, 3));
      vi.setSystemTime(Date.UTC(2026, 9, 4));
      await owner.mutation(api.payroll.archivePerson, { id: ada, archived: true });
      expect((await people(owner))[0]!.changedAt).toBe(Date.UTC(2026, 9, 4));
      vi.setSystemTime(Date.UTC(2026, 9, 5));
      await owner.mutation(api.payroll.updateLine, { id: pension, rateBp: 900 });
      expect((await lines(owner)).find((l) => l.id === pension)!.changedAt).toBe(Date.UTC(2026, 9, 5));
      vi.setSystemTime(Date.UTC(2026, 9, 6));
      await owner.mutation(api.payroll.reorderLines, {
        company: "kz",
        appliesTo: "employee",
        ids: [tax, pension],
      });
      expect((await lines(owner)).map((l) => l.changedAt)).toEqual([Date.UTC(2026, 9, 6), Date.UTC(2026, 9, 6)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── People ──────────────────────────────────────────────────────────────────

describe("payroll people", () => {
  test("a new person is stored trimmed, in the company's currency, last in order", async () => {
    const { owner } = await start();
    await addPerson(owner, { name: "  Ada Example  ", title: " Engineer " });
    await addPerson(owner, { name: "Ben Example", kind: "contractor", monthlyGross: 0 });
    await addPerson(owner, { company: "us", name: "Cal Example", monthlyGross: 9_000_00 });
    expect(await people(owner)).toMatchObject([
      {
        name: "Ada Example",
        title: "Engineer",
        kind: "employee",
        monthlyGross: 500_000_00,
        currency: "KZT",
        startDate: null,
        endDate: null,
        notes: null,
        archivedAt: null,
        removable: true,
      },
      { name: "Ben Example", title: null, kind: "contractor", monthlyGross: 0, currency: "KZT" },
    ]);
    // Each company has its own people.
    expect(await people(owner, "us")).toMatchObject([{ name: "Cal Example", currency: "USD" }]);
  });

  test("a person's time serving customers and on sales and marketing: 0 unless given, kept by an edit that leaves it out", async () => {
    const { t, owner } = await start();
    const ada = await addPerson(owner);
    const ben = await addPerson(owner, { name: "Ben Example", cogsPercent: 30, salesPercent: 50 });
    expect((await people(owner)).map((p) => [p.name, p.cogsPercent, p.salesPercent])).toEqual([
      ["Ada Example", 0, 0],
      ["Ben Example", 30, 50],
    ]);
    // Nothing is stored for a share that was not given, or given as 0.
    const stored = await t.run((ctx) => ctx.db.query("payrollPeople").collect());
    expect(stored.map((p) => [p.cogsPercent, p.salesPercent])).toEqual([
      [undefined, undefined],
      [30, 50],
    ]);

    await owner.mutation(api.payroll.updatePerson, { id: ada, cogsPercent: 100 });
    await owner.mutation(api.payroll.updatePerson, { id: ben, title: "Support", salesPercent: 0 });
    expect((await people(owner)).map((p) => [p.cogsPercent, p.salesPercent])).toEqual([
      [100, 0],
      [30, 0],
    ]);
  });

  test.each([
    [{ cogsPercent: -1 }, "A share of time is a whole percent from 0 to 100."],
    [{ salesPercent: 101 }, "A share of time is a whole percent from 0 to 100."],
    [{ cogsPercent: 12.5 }, "A share of time is a whole percent from 0 to 100."],
    [{ cogsPercent: 60, salesPercent: 41 }, "Time serving customers and time on sales and marketing add up to more than 100%."],
  ])("shares of time %j are refused, and nothing is written", async (extra, message) => {
    const { t, owner } = await start();
    await expect(addPerson(owner, extra)).rejects.toThrow(message);
    expect(await t.run((ctx) => ctx.db.query("payrollPeople").collect())).toEqual([]);
  });

  test("an edit is held to the sum with the share it leaves as it was", async () => {
    const { owner } = await start();
    const ada = await addPerson(owner, { cogsPercent: 70 });
    await expect(owner.mutation(api.payroll.updatePerson, { id: ada, salesPercent: 40 })).rejects.toThrow(
      "Time serving customers and time on sales and marketing add up to more than 100%.",
    );
    expect((await people(owner))[0]).toMatchObject({ cogsPercent: 70, salesPercent: 0 });
  });

  test("a person can be paid in the other currency", async () => {
    const { owner } = await start();
    await addPerson(owner, { company: "us", currency: "KZT" });
    expect((await people(owner, "us"))[0]).toMatchObject({ currency: "KZT" });
  });

  test("control and direction-override characters never reach a stored name", async () => {
    const { owner } = await start();
    await addPerson(owner, { name: "Ada‮ Exam​ple\nJr", notes: "line one\nline two" });
    expect((await people(owner))[0]).toMatchObject({
      name: "Ada Example Jr",
      notes: "line one line two",
    });
  });

  test.each([
    [{ name: "   " }, "A person needs a name."],
    [{ name: "​​" }, "A person needs a name."],
    [{ name: "x".repeat(MAX_NAME_LENGTH + 1) }, "That name is too long (120 characters at most)."],
    [{ title: "x".repeat(MAX_NAME_LENGTH + 1) }, "That title is too long (120 characters at most)."],
    [{ monthlyGross: -1 }, "The monthly gross must be a whole amount, zero or more."],
    [{ monthlyGross: 100.5 }, "The monthly gross must be a whole amount, zero or more."],
    [{ monthlyGross: Number.NaN }, "The monthly gross must be a whole amount, zero or more."],
    [{ monthlyGross: MAX_PAYROLL_AMOUNT + 1 }, "The monthly gross is too large."],
    [{ startDate: "2026-02-30" }, "The start date is not a date."],
    [{ endDate: "next week" }, "The end date is not a date."],
    [
      { startDate: "2026-09-10", endDate: "2026-09-09" },
      "The end date is before the start date.",
    ],
    [
      { notes: "x".repeat(MAX_PAYROLL_NOTE_LENGTH + 1) },
      `That note is too long (${MAX_PAYROLL_NOTE_LENGTH} characters at most).`,
    ],
  ])("%j is refused", async (extra, message) => {
    const { owner } = await start();
    await expect(addPerson(owner, extra)).rejects.toThrow(message);
    expect(await people(owner)).toEqual([]);
  });

  test("a company that is neither of the two is refused", async () => {
    const { owner } = await start();
    await expect(addPerson(owner, { company: "fr" })).rejects.toThrow(/Validator error/);
  });

  test(`a company holds ${MAX_PAYROLL_PEOPLE} people at most`, async () => {
    const { t, owner } = await start();
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_PAYROLL_PEOPLE; i++) {
        await ctx.db.insert("payrollPeople", {
          company: "kz",
          name: `Person ${i}`,
          kind: "employee",
          monthlyGross: 1,
          currency: "KZT",
          order: i,
        });
      }
    });
    await expect(addPerson(owner)).rejects.toThrow("The payroll is full (200 people at most).");
    // The other company still has room.
    await addPerson(owner, { company: "us" });
  });

  test("update changes what is given, clears with null and keeps the rest", async () => {
    const { owner } = await start();
    const id = await addPerson(owner, { title: "Engineer", startDate: "2026-01-05", notes: "Remote" });
    await owner.mutation(api.payroll.updatePerson, {
      id,
      name: "Ada Renamed",
      monthlyGross: 600_000_00,
      title: null,
      endDate: "2026-12-31",
    });
    expect((await people(owner))[0]).toMatchObject({
      name: "Ada Renamed",
      title: null,
      monthlyGross: 600_000_00,
      startDate: "2026-01-05",
      endDate: "2026-12-31",
      notes: "Remote",
      kind: "employee",
    });
  });

  test.each([
    [{ name: " " }, "A person needs a name."],
    [{ monthlyGross: 1.5 }, "The monthly gross must be a whole amount, zero or more."],
    [{ endDate: "2025-12-31" }, "The end date is before the start date."],
    [{ startDate: "soon" }, "The start date is not a date."],
  ])("update refuses %j", async (change, message) => {
    const { owner } = await start();
    const id = await addPerson(owner, { startDate: "2026-01-05" });
    await expect(
      owner.mutation(api.payroll.updatePerson, { id, ...change } as never),
    ).rejects.toThrow(message);
  });

  test("updating someone who is gone says so", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    await owner.mutation(api.payroll.removePerson, { id });
    await expect(owner.mutation(api.payroll.updatePerson, { id, name: "x" })).rejects.toThrow(
      "That person no longer exists.",
    );
  });

  test("archive and restore", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    await owner.mutation(api.payroll.archivePerson, { id, archived: true });
    expect((await people(owner))[0]!.archivedAt).toEqual(expect.any(Number));
    await owner.mutation(api.payroll.archivePerson, { id, archived: false });
    expect((await people(owner))[0]!.archivedAt).toBeNull();
  });

  test("someone in no saved month can be removed", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    await owner.mutation(api.payroll.removePerson, { id });
    expect(await people(owner)).toEqual([]);
    // Removing them twice does nothing.
    await owner.mutation(api.payroll.removePerson, { id });
  });

  test("someone a saved month holds cannot be removed, draft or paid, until that month is gone", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    await prepare(owner);
    expect((await people(owner))[0]!.removable).toBe(false);
    await expect(owner.mutation(api.payroll.removePerson, { id })).rejects.toThrow(
      "That person is in a saved month. End or archive them instead.",
    );
    expect(await people(owner)).toHaveLength(1);
    await owner.mutation(api.payroll.removeRun, { company: "kz", month: SEP });
    expect((await people(owner))[0]!.removable).toBe(true);
    await owner.mutation(api.payroll.removePerson, { id });
    expect(await people(owner)).toEqual([]);
  });
});

// ── Lines ───────────────────────────────────────────────────────────────────

describe("payroll lines", () => {
  test("a new line: on, no allowance, no cap, last in its kind", async () => {
    const { owner } = await start();
    await addLine(owner, { name: "  Pension  " });
    await addLine(owner, { name: "Levy", paidBy: "company", rateBp: undefined });
    await addLine(owner, { name: "Fee", appliesTo: "contractor", rateBp: 0 });
    expect(await lines(owner)).toMatchObject([
      {
        name: "Pension",
        appliesTo: "employee",
        paidBy: "employee",
        rateBp: 1000,
        lessLineIds: [],
        allowance: 0,
        baseCap: null,
        order: 0,
        active: true,
      },
      // No rate given is "not set", which is not zero.
      { name: "Levy", paidBy: "company", rateBp: null, order: 1 },
      { name: "Fee", appliesTo: "contractor", rateBp: 0, order: 0 },
    ]);
    expect(await lines(owner, "us")).toEqual([]);
  });

  test.each([
    [{ name: " " }, "A line needs a name."],
    [
      { name: "x".repeat(MAX_LINE_NAME_LENGTH + 1) },
      `That name is too long (${MAX_LINE_NAME_LENGTH} characters at most).`,
    ],
    [{ rateBp: -1 }, "A rate is from 0% to 100%, with two decimals at most."],
    [{ rateBp: 10_001 }, "A rate is from 0% to 100%, with two decimals at most."],
    [{ rateBp: 12.5 }, "A rate is from 0% to 100%, with two decimals at most."],
    [{ allowance: -5 }, "The allowance must be a whole amount, zero or more."],
    [{ allowance: MAX_PAYROLL_AMOUNT + 1 }, "The allowance is too large."],
    [{ baseCap: 0.5 }, "The cap must be a whole amount, zero or more."],
    [{ baseCap: MAX_PAYROLL_AMOUNT + 1 }, "The cap is too large."],
  ])("%j is refused", async (extra, message) => {
    const { owner } = await start();
    await expect(addLine(owner, extra)).rejects.toThrow(message);
    expect(await lines(owner)).toEqual([]);
  });

  test("two lines of one kind cannot share a name; the other kind and company can use it", async () => {
    const { owner } = await start();
    await addLine(owner);
    await expect(addLine(owner, { name: " pension " })).rejects.toThrow(
      "There is already a line with that name.",
    );
    await addLine(owner, { appliesTo: "contractor" });
    await addLine(owner, { company: "us" });
  });

  test(`a company holds ${MAX_PAYROLL_LINES} lines at most`, async () => {
    const { owner } = await start();
    for (let i = 0; i < MAX_PAYROLL_LINES; i++) {
      await addLine(owner, { name: `Line ${i}`, appliesTo: i % 2 ? "employee" : "contractor" });
    }
    await expect(addLine(owner, { name: "One more" })).rejects.toThrow(
      "That is every line a company can have (30 at most).",
    );
  });

  test("a line can subtract lines of its own company and kind, and no other", async () => {
    const { owner } = await start();
    const pension = await addLine(owner);
    const contractor = await addLine(owner, { name: "Fee", appliesTo: "contractor" });
    const other = await addLine(owner, { company: "us" });
    const SAME = "A line can subtract only other lines of the same company and kind.";
    await addLine(owner, { name: "Income", lessLineIds: [pension] });
    expect((await lines(owner)).find((l) => l.name === "Income")!.lessLineIds).toEqual([pension]);
    await expect(addLine(owner, { name: "X", lessLineIds: [contractor] })).rejects.toThrow(SAME);
    await expect(addLine(owner, { name: "X", lessLineIds: [other] })).rejects.toThrow(SAME);
    await owner.mutation(api.payroll.removeLine, { id: contractor });
    await expect(addLine(owner, { name: "X", lessLineIds: [contractor] })).rejects.toThrow(SAME);
  });

  test("a circle of subtractions is refused, a line less itself included", async () => {
    const { owner } = await start();
    const a = await addLine(owner, { name: "A" });
    const b = await addLine(owner, { name: "B", lessLineIds: [a] });
    const c = await addLine(owner, { name: "C", lessLineIds: [b] });
    const CIRCLE = "Those lines subtract each other in a circle.";
    await expect(
      owner.mutation(api.payroll.updateLine, { id: a, lessLineIds: [c] }),
    ).rejects.toThrow(CIRCLE);
    await expect(
      owner.mutation(api.payroll.updateLine, { id: a, lessLineIds: [a] }),
    ).rejects.toThrow(CIRCLE);
    expect((await lines(owner)).find((l) => l.name === "A")!.lessLineIds).toEqual([]);
  });

  test("update changes what is given; a rate and a cap are cleared with null", async () => {
    const { owner } = await start();
    const id = await addLine(owner, { baseCap: 700_000_00, allowance: 10 });
    await owner.mutation(api.payroll.updateLine, {
      id,
      name: "Pension fund",
      paidBy: "company",
      rateBp: null,
      baseCap: null,
      active: false,
    });
    expect((await lines(owner))[0]).toMatchObject({
      name: "Pension fund",
      paidBy: "company",
      rateBp: null,
      baseCap: null,
      allowance: 10,
      active: false,
    });
  });

  test.each([
    [{ name: "" }, "A line needs a name."],
    [{ name: "Levy" }, "There is already a line with that name."],
    [{ rateBp: 20_000 }, "A rate is from 0% to 100%, with two decimals at most."],
    [{ allowance: 1.1 }, "The allowance must be a whole amount, zero or more."],
  ])("update refuses %j", async (change, message) => {
    const { owner } = await start();
    const id = await addLine(owner);
    await addLine(owner, { name: "Levy" });
    await expect(
      owner.mutation(api.payroll.updateLine, { id, ...change } as never),
    ).rejects.toThrow(message);
  });

  test("a line keeps its own name on update", async () => {
    const { owner } = await start();
    const id = await addLine(owner);
    await owner.mutation(api.payroll.updateLine, { id, name: "Pension", rateBp: 900 });
    expect((await lines(owner))[0]).toMatchObject({ rateBp: 900 });
  });

  test("updating a line that is gone says so", async () => {
    const { owner } = await start();
    const id = await addLine(owner);
    await owner.mutation(api.payroll.removeLine, { id });
    await expect(owner.mutation(api.payroll.updateLine, { id, name: "x" })).rejects.toThrow(
      "That line no longer exists.",
    );
  });

  test("reorder sets a kind's order, and refuses a list that is not that kind's lines", async () => {
    const { owner } = await start();
    const a = await addLine(owner, { name: "A" });
    const b = await addLine(owner, { name: "B" });
    const c = await addLine(owner, { name: "C" });
    const fee = await addLine(owner, { name: "Fee", appliesTo: "contractor" });
    const reorder = (ids: Id<"payrollLines">[]) =>
      owner.mutation(api.payroll.reorderLines, { company: "kz", appliesTo: "employee", ids });
    await reorder([c, a, b]);
    expect((await lines(owner)).map((l) => l.name)).toEqual(["C", "A", "B", "Fee"]);
    const NOT_THESE = "Those are not this kind's lines. Reload and try again.";
    await expect(reorder([a, b])).rejects.toThrow(NOT_THESE);
    await expect(reorder([a, b, fee])).rejects.toThrow(NOT_THESE);
    await expect(reorder([a, a, b])).rejects.toThrow(NOT_THESE);
  });

  test("removing a line takes it out of the lines that subtracted it", async () => {
    const { owner } = await start();
    const pension = await addLine(owner);
    const medical = await addLine(owner, { name: "Medical" });
    await addLine(owner, { name: "Income", lessLineIds: [pension, medical] });
    await owner.mutation(api.payroll.removeLine, { id: pension });
    expect((await lines(owner)).map((l) => [l.name, l.lessLineIds])).toEqual([
      ["Medical", []],
      ["Income", [medical]],
    ]);
    await owner.mutation(api.payroll.removeLine, { id: pension });
  });
});

describe("payroll.addUsualLines", () => {
  test("for contractors: the same names, as contractor lines, beside the employees' own", async () => {
    const { owner } = await start();
    expect(await owner.mutation(api.payroll.addUsualLines, { company: "kz" })).toBe(7);
    expect(
      await owner.mutation(api.payroll.addUsualLines, { company: "kz", appliesTo: "contractor" }),
    ).toBe(7);
    const all = await lines(owner);
    const names = (kind: string) => all.filter((l) => l.appliesTo === kind).map((l) => l.name);
    expect(names("contractor")).toEqual(names("employee"));
    expect(
      await owner.mutation(api.payroll.addUsualLines, { company: "kz", appliesTo: "contractor" }),
    ).toBe(0);
  });

  test("Kazakhstan's usual names for employees, each with a payer and no rate", async () => {
    const { owner } = await start();
    expect(await owner.mutation(api.payroll.addUsualLines, { company: "kz" })).toBe(7);
    const added = await lines(owner);
    expect(added.map((l) => [l.name, l.paidBy])).toEqual([
      ["ОПВ · pension contribution", "employee"],
      ["ИПН · income tax", "employee"],
      ["ВОСМС · medical insurance contribution", "employee"],
      ["СО · social contributions", "company"],
      ["СН · social tax", "company"],
      ["ООСМС · employer medical insurance", "company"],
      ["ОПВР · employer pension contribution", "company"],
    ]);
    for (const line of added) {
      expect(line).toMatchObject({
        appliesTo: "employee",
        rateBp: null,
        lessLineIds: [],
        allowance: 0,
        baseCap: null,
        active: true,
      });
    }
  });

  test("the United States' usual names, again with no rate", async () => {
    const { owner } = await start();
    expect(await owner.mutation(api.payroll.addUsualLines, { company: "us" })).toBe(7);
    const added = await lines(owner, "us");
    expect(added.map((l) => [l.name, l.paidBy])).toEqual([
      ["Federal income tax withholding", "employee"],
      ["Social Security (employee)", "employee"],
      ["Medicare (employee)", "employee"],
      ["Social Security (employer)", "company"],
      ["Medicare (employer)", "company"],
      ["FUTA", "company"],
      ["State unemployment", "company"],
    ]);
    expect(added.every((l) => l.rateBp === null)).toBe(true);
  });

  test("only the names not already there are added, after the lines that are", async () => {
    const { owner } = await start();
    await addLine(owner, { name: "ИПН · income tax", rateBp: 1000 });
    expect(await owner.mutation(api.payroll.addUsualLines, { company: "kz" })).toBe(6);
    expect(await owner.mutation(api.payroll.addUsualLines, { company: "kz" })).toBe(0);
    const all = await lines(owner);
    expect(all).toHaveLength(7);
    // The rate the owner typed is untouched.
    expect(all[0]).toMatchObject({ name: "ИПН · income tax", rateBp: 1000, order: 0 });
  });

  test("refused when the usual lines would not fit", async () => {
    const { owner } = await start();
    for (let i = 0; i < MAX_PAYROLL_LINES - 3; i++) await addLine(owner, { name: `Line ${i}` });
    await expect(owner.mutation(api.payroll.addUsualLines, { company: "kz" })).rejects.toThrow(
      "That is every line a company can have (30 at most).",
    );
    expect(await lines(owner)).toHaveLength(MAX_PAYROLL_LINES - 3);
  });
});

// ── Months ──────────────────────────────────────────────────────────────────

describe("payroll.prepareRun", () => {
  test("a draft of frozen rows, with totals by kind and overall", async () => {
    const { owner } = await start();
    await addPerson(owner, { title: "Engineer" });
    await addPerson(owner, { name: "Ben Example", kind: "contractor", monthlyGross: 200_000_00 });
    const pension = await addLine(owner);
    await addLine(owner, { name: "Income", rateBp: 1000, lessLineIds: [pension], allowance: 50_000_00 });
    await addLine(owner, { name: "Levy", paidBy: "company", rateBp: 350 });
    expect(await run(owner)).toBeNull();
    await prepare(owner);

    const month = await saved(owner);
    expect(month).toMatchObject({ month: SEP, status: "draft", paidOn: null });
    expect(month.rows).toMatchObject([
      {
        name: "Ada Example",
        title: "Engineer",
        kind: "employee",
        currency: "KZT",
        gross: 500_000_00,
        adjustment: 0,
        adjustmentNote: null,
        lines: [
          { name: "Pension", paidBy: "employee", rateBp: 1000, base: 500_000_00, amount: 50_000_00 },
          // 500,000 − 50,000 − 50,000 = 400,000.
          { name: "Income", paidBy: "employee", rateBp: 1000, base: 400_000_00, amount: 40_000_00 },
          { name: "Levy", paidBy: "company", rateBp: 350, base: 500_000_00, amount: 17_500_00 },
        ],
        withheld: 90_000_00,
        companyPaid: 17_500_00,
        net: 410_000_00,
        cost: 517_500_00,
        notComputed: 0,
      },
      { name: "Ben Example", kind: "contractor", lines: [], net: 200_000_00, cost: 200_000_00 },
    ]);
    expect(month.totals).toHaveLength(1);
    expect(month.totals[0]).toMatchObject({
      currency: "KZT",
      byKind: {
        employee: { people: 1, gross: 500_000_00, withheld: 90_000_00, net: 410_000_00 },
        contractor: { people: 1, gross: 200_000_00, net: 200_000_00, cost: 200_000_00 },
      },
      overall: {
        people: 2,
        gross: 700_000_00,
        withheld: 90_000_00,
        net: 610_000_00,
        companyPaid: 17_500_00,
        cost: 717_500_00,
        notComputed: 0,
      },
    });
  });

  test("holds the people active in that month, and nobody archived", async () => {
    const { owner } = await start();
    await addPerson(owner, { name: "No dates" });
    await addPerson(owner, { name: "Starts on the last day", startDate: "2026-09-30" });
    await addPerson(owner, { name: "Starts next month", startDate: "2026-10-01" });
    await addPerson(owner, { name: "Ended on the first day", endDate: "2026-09-01" });
    await addPerson(owner, { name: "Ended the day before", endDate: "2026-08-31" });
    const archived = await addPerson(owner, { name: "Archived" });
    await owner.mutation(api.payroll.archivePerson, { id: archived, archived: true });
    await addPerson(owner, { company: "us", name: "Other company" });

    await prepare(owner);
    expect((await saved(owner)).rows.map((r) => r.name)).toEqual([
      "No dates",
      "Starts on the last day",
      "Ended on the first day",
    ]);
    await prepare(owner, OCT);
    expect((await saved(owner, OCT)).rows.map((r) => r.name)).toEqual([
      "No dates",
      "Starts on the last day",
      "Starts next month",
    ]);
  });

  test.each(["2026-09-15", "2026-13-01", "September", "2026-9-1"])(
    "%s is not a month",
    async (month) => {
      const { owner } = await start();
      await addPerson(owner);
      await expect(prepare(owner, month)).rejects.toThrow("That is not a month.");
    },
  );

  test("a month with nobody in it is not saved", async () => {
    const { owner } = await start();
    await addPerson(owner, { startDate: "2026-10-01" });
    await expect(prepare(owner)).rejects.toThrow("Nobody is on the payroll in that month.");
    expect(await run(owner)).toBeNull();
  });

  test("a month too large for one document is refused", async () => {
    const { t, owner } = await start();
    for (let i = 0; i < 11; i++) await addLine(owner, { name: `Line ${i}` });
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_RUN_CELLS / 11; i++) {
        await ctx.db.insert("payrollPeople", {
          company: "kz",
          name: `Person ${i}`,
          kind: "employee",
          monthlyGross: 1,
          currency: "KZT",
          order: i,
        });
      }
    });
    await expect(prepare(owner)).rejects.toThrow(
      "That month is too large to save. Switch off lines that are not used, or end people who have left.",
    );
  });

  test("someone paid in another currency is listed and totalled apart", async () => {
    const { owner } = await start();
    await addPerson(owner, { company: "us", name: "Cal Example", monthlyGross: 9_000_00 });
    await addPerson(owner, {
      company: "us",
      name: "Dana Example",
      kind: "contractor",
      currency: "KZT",
      monthlyGross: 800_000_00,
    });
    await prepare(owner, SEP, "us");
    const month = (await run(owner, SEP, "us"))!;
    expect(month.totals.map((t) => [t.currency, t.overall.people, t.overall.cost])).toEqual([
      ["USD", 1, 9_000_00],
      ["KZT", 1, 800_000_00],
    ]);
  });
});

describe("a saved month is frozen", () => {
  const setUp = async () => {
    const { owner } = await start();
    const person = await addPerson(owner);
    const line = await addLine(owner);
    await prepare(owner);
    return { owner, person, line };
  };
  const change = async (owner: Owner, person: Id<"payrollPeople">, line: Id<"payrollLines">) => {
    await owner.mutation(api.payroll.updateLine, { id: line, rateBp: 2000, name: "Renamed" });
    await owner.mutation(api.payroll.updatePerson, {
      id: person,
      monthlyGross: 900_000_00,
      name: "Ada Renamed",
    });
    await addLine(owner, { name: "New levy", paidBy: "company", rateBp: 100 });
    await addPerson(owner, { name: "New hire" });
  };
  const ORIGINAL = {
    name: "Ada Example",
    gross: 500_000_00,
    lines: [{ name: "Pension", rateBp: 1000, base: 500_000_00, amount: 50_000_00 }],
    net: 450_000_00,
    cost: 500_000_00,
  };

  test("changing a rate, a salary, a name or the lines leaves a saved draft as it was", async () => {
    const { owner, person, line } = await setUp();
    await change(owner, person, line);
    const month = await saved(owner);
    expect(month.rows).toHaveLength(1);
    expect(month.rows[0]).toMatchObject(ORIGINAL);
    expect(month.rows[0]!.lines).toHaveLength(1);
  });

  test("and a paid month too, when a line and a person are later removed or archived", async () => {
    const { owner, person, line } = await setUp();
    await owner.mutation(api.payroll.markPaid, { company: "kz", month: SEP, paidOn: "2026-10-05" });
    await change(owner, person, line);
    await owner.mutation(api.payroll.removeLine, { id: line });
    await owner.mutation(api.payroll.archivePerson, { id: person, archived: true });
    const month = await saved(owner);
    expect(month).toMatchObject({ status: "paid", paidOn: "2026-10-05" });
    expect(month.rows).toHaveLength(1);
    expect(month.rows[0]).toMatchObject(ORIGINAL);
  });

  test("recalculating a draft takes today's people and lines", async () => {
    const { owner, person, line } = await setUp();
    await change(owner, person, line);
    await prepare(owner);
    const month = await saved(owner);
    expect(month.rows).toMatchObject([
      {
        name: "Ada Renamed",
        gross: 900_000_00,
        lines: [
          { name: "Renamed", rateBp: 2000, amount: 180_000_00 },
          { name: "New levy", rateBp: 100, amount: 9_000_00 },
        ],
        net: 720_000_00,
        cost: 909_000_00,
      },
      { name: "New hire" },
    ]);
  });

  test("recalculating keeps each person's adjustment, and drops one for someone no longer in", async () => {
    const { owner, person } = await setUp();
    const leaver = await addPerson(owner, { name: "Leaver" });
    await prepare(owner);
    const adjust = (personId: Id<"payrollPeople">, amount: number, note: string) =>
      owner.mutation(api.payroll.setAdjustment, { company: "kz", month: SEP, personId, amount, note });
    await adjust(person, 25_000_00, "Bonus");
    await adjust(leaver, -1_000_00, "Advance");
    await owner.mutation(api.payroll.updatePerson, { id: leaver, endDate: "2026-08-31" });
    await prepare(owner);
    const month = await saved(owner);
    expect(month.rows).toHaveLength(1);
    expect(month.rows[0]).toMatchObject({
      adjustment: 25_000_00,
      adjustmentNote: "Bonus",
      net: 475_000_00,
      cost: 525_000_00,
    });
  });
});

describe("payroll.setAdjustment", () => {
  const setUp = async () => {
    const { owner } = await start();
    const person = await addPerson(owner);
    const line = await addLine(owner);
    await addLine(owner, { name: "Levy", paidBy: "company", rateBp: 500 });
    await prepare(owner);
    const adjust = (amount: number, note?: string, personId = person, month = SEP) =>
      owner.mutation(api.payroll.setAdjustment, {
        company: "kz",
        month,
        personId,
        amount,
        ...(note === undefined ? null : { note }),
      });
    return { owner, person, line, adjust };
  };

  test("a bonus or a deduction re-works net and cost and no line", async () => {
    const { owner, adjust } = await setUp();
    await adjust(30_000_00, "  Quarterly‮ bonus ");
    expect((await saved(owner)).rows[0]).toMatchObject({
      adjustment: 30_000_00,
      adjustmentNote: "Quarterly bonus",
      lines: [{ amount: 50_000_00 }, { amount: 25_000_00 }],
      net: 480_000_00,
      cost: 555_000_00,
    });
    await adjust(-20_000_00);
    expect((await saved(owner)).rows[0]).toMatchObject({
      adjustment: -20_000_00,
      adjustmentNote: null,
      net: 430_000_00,
      cost: 505_000_00,
    });
    await adjust(0, "left behind");
    expect((await saved(owner)).rows[0]).toMatchObject({
      adjustment: 0,
      adjustmentNote: null,
      net: 450_000_00,
      cost: 525_000_00,
    });
  });

  test("the month is not paid, so it is worked from today's lines, as the page shows it", async () => {
    const { owner, line, adjust } = await setUp();
    await owner.mutation(api.payroll.updateLine, { id: line, rateBp: 5000 });
    await adjust(10_000_00);
    expect((await saved(owner)).rows[0]).toMatchObject({
      lines: [{ rateBp: 5000, amount: 250_000_00 }, { amount: 25_000_00 }],
      net: 260_000_00,
    });
  });

  test.each([
    [0.5, "An adjustment must be a whole amount."],
    [Number.NaN, "An adjustment must be a whole amount."],
    [MAX_PAYROLL_AMOUNT + 1, "That adjustment is too large."],
    [-(MAX_PAYROLL_AMOUNT + 1), "That adjustment is too large."],
    [-500_000_01, "A deduction cannot be more than the month's gross."],
  ])("%d is refused", async (amount, message) => {
    const { owner, adjust } = await setUp();
    await expect(adjust(amount)).rejects.toThrow(message);
    expect((await saved(owner)).rows[0]!.adjustment).toBe(0);
  });

  test("a note has a length, and someone not in the month has no adjustment", async () => {
    const { owner, adjust } = await setUp();
    await expect(adjust(1, "x".repeat(MAX_PAYROLL_NOTE_LENGTH + 1))).rejects.toThrow(
      `That note is too long (${MAX_PAYROLL_NOTE_LENGTH} characters at most).`,
    );
    const other = await addPerson(owner, { name: "Not in it" });
    await owner.mutation(api.payroll.updatePerson, { id: other, startDate: "2026-10-01" });
    await expect(adjust(1, undefined, other)).rejects.toThrow("That person is not in this month.");
    await expect(adjust(1, undefined, other, "2026-08-01")).rejects.toThrow(
      "That person is not in this month.",
    );
    expect(await run(owner, "2026-08-01")).toBeNull();
  });
});

describe("marking a month paid", () => {
  const PAID = "That month is marked paid. Reopen it to change it.";
  const setUp = async () => {
    const { owner } = await start();
    const person = await addPerson(owner);
    const line = await addLine(owner);
    await prepare(owner);
    const pay = (paidOn = "2026-10-05", month = SEP) =>
      owner.mutation(api.payroll.markPaid, { company: "kz", month, paidOn });
    return { owner, person, line, pay };
  };

  test("a paid month is read-only until it is reopened", async () => {
    const { owner, person, pay } = await setUp();
    await pay();
    expect(await saved(owner)).toMatchObject({ status: "paid", paidOn: "2026-10-05" });

    await expect(prepare(owner)).rejects.toThrow(PAID);
    await expect(
      owner.mutation(api.payroll.setAdjustment, {
        company: "kz",
        month: SEP,
        personId: person,
        amount: 1,
      }),
    ).rejects.toThrow(PAID);
    await expect(pay("2026-10-06")).rejects.toThrow(PAID);
    await expect(
      owner.mutation(api.payroll.removeRun, { company: "kz", month: SEP }),
    ).rejects.toThrow("A paid month is not deleted. Reopen it first.");
    expect(await saved(owner)).toMatchObject({ status: "paid", paidOn: "2026-10-05" });

    await owner.mutation(api.payroll.reopenRun, { company: "kz", month: SEP });
    expect(await saved(owner)).toMatchObject({ status: "draft", paidOn: null });
    await owner.mutation(api.payroll.setAdjustment, {
      company: "kz",
      month: SEP,
      personId: person,
      amount: 1,
    });
    await prepare(owner);
    await owner.mutation(api.payroll.removeRun, { company: "kz", month: SEP });
    expect(await run(owner)).toBeNull();
  });

  test("a payment date must be a date, and a month a month", async () => {
    const { owner, pay } = await setUp();
    await expect(pay("2026-02-30")).rejects.toThrow("The payment date is not a date.");
    await expect(pay("2026-10-05", "soon")).rejects.toThrow("That is not a month.");
    expect((await saved(owner)).status).toBe("draft");
  });

  test("a month with a rate not set cannot be marked paid until the rate is set or the line is off", async () => {
    const { owner, pay } = await setUp();
    const levy = await addLine(owner, { name: "Levy", paidBy: "company", rateBp: undefined });
    await prepare(owner);
    expect((await saved(owner)).rows[0]).toMatchObject({
      lines: [{ name: "Pension" }, { name: "Levy", base: 500_000_00, amount: null, skipped: "rate_not_set" }],
      notComputed: 1,
      cost: 500_000_00,
    });
    expect((await saved(owner)).totals[0]!.overall.notComputed).toBe(1);
    const BLOCKED =
      "Some lines have no amount. Set each rate or switch the line off, then mark the month paid.";
    await expect(pay()).rejects.toThrow(BLOCKED);

    // Setting the rate is enough: marking paid works the month out as it is then.
    await owner.mutation(api.payroll.updateLine, { id: levy, rateBp: 300 });
    await pay();
    expect((await saved(owner)).rows[0]).toMatchObject({ cost: 515_000_00, notComputed: 0 });
  });

  test("switching the line off is the other way through", async () => {
    const { owner, pay } = await setUp();
    const levy = await addLine(owner, { name: "Levy", paidBy: "company", rateBp: undefined });
    await prepare(owner);
    await owner.mutation(api.payroll.updateLine, { id: levy, active: false });
    await prepare(owner);
    expect((await saved(owner)).rows[0]!.lines).toHaveLength(1);
    await pay();
    expect((await saved(owner)).status).toBe("paid");
  });

  test("reopening a draft, or a month that was never saved", async () => {
    const { owner } = await setUp();
    await owner.mutation(api.payroll.reopenRun, { company: "kz", month: SEP });
    expect((await saved(owner)).status).toBe("draft");
    await expect(
      owner.mutation(api.payroll.reopenRun, { company: "kz", month: OCT }),
    ).rejects.toThrow("Nothing is saved for that month.");
    // Removing a month that is not there does nothing.
    await owner.mutation(api.payroll.removeRun, { company: "kz", month: OCT });
  });
});

describe("a month is live until it is marked paid", () => {
  // The page shows a month that is not paid worked out from today's people
  // and lines; a stored draft is only where its adjustments are kept. Marking
  // it paid freezes it at that moment, in one mutation.
  const pay = (owner: Owner, month = SEP, paidOn = "2026-10-05") =>
    owner.mutation(api.payroll.markPaid, { company: "kz", month, paidOn });
  const adjust = (owner: Owner, personId: Id<"payrollPeople">, amount: number, month = SEP) =>
    owner.mutation(api.payroll.setAdjustment, { company: "kz", month, personId, amount });

  test("marking a month with nothing saved freezes it as it is now", async () => {
    const { owner } = await start();
    await addPerson(owner);
    await addLine(owner);
    expect(await run(owner)).toBeNull();
    await pay(owner);
    const month = await saved(owner);
    expect(month).toMatchObject({ status: "paid", paidOn: "2026-10-05" });
    expect(month.rows).toMatchObject([{ name: "Ada Example", gross: 500_000_00, net: 450_000_00 }]);
  });

  test("a draft saved before the rates were set is frozen with today's rates", async () => {
    const { owner } = await start();
    await addPerson(owner, { payBasis: "net", monthlyGross: undefined, monthlyNet: 450_000_00 });
    const pension = await addLine(owner, { rateBp: undefined });
    await prepare(owner);
    expect((await saved(owner)).rows[0]).toMatchObject({ gross: null, grossMissing: "rate_not_set" });
    await owner.mutation(api.payroll.updateLine, { id: pension, rateBp: 1000 });
    await pay(owner);
    expect((await saved(owner)).rows[0]).toMatchObject({
      gross: 500_000_00,
      grossMissing: null,
      net: 450_000_00,
      notComputed: 0,
    });
  });

  test("marking keeps each adjustment, and refuses a month with a missing figure, writing nothing", async () => {
    const { owner } = await start();
    const person = await addPerson(owner);
    await addLine(owner);
    await adjust(owner, person, 10_000_00);
    const levy = await addLine(owner, { name: "Levy", paidBy: "company", rateBp: undefined });
    await expect(pay(owner)).rejects.toThrow(
      "Some lines have no amount. Set each rate or switch the line off, then mark the month paid.",
    );
    expect((await saved(owner)).status).toBe("draft");
    await expect(pay(owner, OCT)).rejects.toThrow("Some lines have no amount.");
    expect(await run(owner, OCT)).toBeNull();
    await owner.mutation(api.payroll.updateLine, { id: levy, rateBp: 100 });
    await pay(owner);
    expect((await saved(owner)).rows[0]).toMatchObject({
      adjustment: 10_000_00,
      net: 460_000_00,
      cost: 515_000_00,
    });
  });

  test("a month with nobody in it is not paid", async () => {
    const { owner } = await start();
    await addPerson(owner, { startDate: "2026-10-01" });
    await expect(pay(owner)).rejects.toThrow("Nobody is on the payroll in that month.");
    expect(await run(owner)).toBeNull();
  });

  test("an adjustment needs no prepared month, and reaches someone added after a draft", async () => {
    const { owner } = await start();
    const person = await addPerson(owner);
    await addLine(owner);
    await adjust(owner, person, 5_000_00);
    expect((await saved(owner)).rows).toMatchObject([{ adjustment: 5_000_00, net: 455_000_00 }]);
    const hire = await addPerson(owner, { name: "New hire", monthlyGross: 100_000_00 });
    await adjust(owner, hire, -1_000_00);
    expect((await saved(owner)).rows).toMatchObject([
      { name: "Ada Example", adjustment: 5_000_00 },
      { name: "New hire", adjustment: -1_000_00, net: 89_000_00 },
    ]);
  });

  test("a deduction is held to today's gross", async () => {
    const { owner } = await start();
    const person = await addPerson(owner);
    await prepare(owner);
    await owner.mutation(api.payroll.updatePerson, { id: person, monthlyGross: 100_000_00 });
    await expect(adjust(owner, person, -100_000_01)).rejects.toThrow(
      "A deduction cannot be more than the month's gross.",
    );
    await adjust(owner, person, -100_000_00);
  });
});

describe("payroll.listRuns", () => {
  test("a company's saved months, newest first, with status, people and totals", async () => {
    const { owner } = await start();
    await addPerson(owner);
    await addPerson(owner, { name: "Ben Example", startDate: "2026-10-01", monthlyGross: 100_000_00 });
    await addLine(owner);
    await addPerson(owner, { company: "us", name: "Cal Example", monthlyGross: 9_000_00 });
    await prepare(owner, SEP);
    await prepare(owner, OCT);
    await prepare(owner, SEP, "us");
    await owner.mutation(api.payroll.markPaid, { company: "kz", month: SEP, paidOn: "2026-10-05" });

    const months = await owner.query(api.payroll.listRuns, { company: "kz" });
    expect(months).toMatchObject([
      { month: OCT, status: "draft", paidOn: null, people: 2 },
      { month: SEP, status: "paid", paidOn: "2026-10-05", people: 1 },
    ]);
    expect(months[0]!.totals[0]).toMatchObject({
      currency: "KZT",
      overall: { gross: 600_000_00, net: 540_000_00, cost: 600_000_00 },
    });
    expect(await owner.query(api.payroll.listRuns, { company: "us" })).toHaveLength(1);
  });
});

// ── Whose it is ─────────────────────────────────────────────────────────────

describe("who may call it", () => {
  // The gate of every function, for each role and a signed-out caller, is in
  // convex/access.test.ts. This is the same thing said once in plain sight.
  test("a signed-out caller is refused, reading or writing", async () => {
    const { t } = await start();
    await expect(t.query(api.payroll.listPeople, { company: "kz" })).rejects.toThrow("not_allowed");
    await expect(t.query(api.payroll.getRun, { company: "kz", month: SEP })).rejects.toThrow(
      "not_allowed",
    );
    await expect(
      t.mutation(api.payroll.createPerson, {
        company: "kz",
        name: "x",
        kind: "employee",
        monthlyGross: 1,
      }),
    ).rejects.toThrow("not_allowed");
  });

  test("no refusal quotes a name or an amount", async () => {
    const { owner } = await start();
    const id = await addPerson(owner, { name: "SECRET Person", monthlyGross: 987_654_321 });
    await prepare(owner);
    const refusals = await Promise.all(
      [
        owner.mutation(api.payroll.removePerson, { id }),
        owner.mutation(api.payroll.updatePerson, { id, monthlyGross: 987_654_321.5 }),
        owner.mutation(api.payroll.setAdjustment, {
          company: "kz",
          month: SEP,
          personId: id,
          amount: -987_654_322,
        }),
        addLine(owner, { name: "SECRET Line", rateBp: 98_765 }),
      ].map((call) => call.then(() => "no refusal", (error: Error) => error.message)),
    );
    for (const message of refusals) {
      expect(message).not.toBe("no refusal");
      expect(message).not.toContain("SECRET");
      expect(message).not.toMatch(/98.?765/);
    }
  });
});
