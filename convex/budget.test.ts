import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { ACTUAL_IS_MERCURYS, COSTS_NEED_COSTS, PAY_NEEDS_PAYROLL } from "./budget";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas } from "./test.setup";

// The budget: a plan per month and category. Every amount here is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 14, 6));
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const start = () => convexTest(schema, modules);
const view = { company: "kz" as const, first: "2026-10", count: 12 };

describe("the grid", () => {
  test("a cell saved is read back; a cell cleared is no plan, not a zero", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.budget.setCells, {
      company: "kz",
      cells: [
        { month: "2026-10", category: "cloud", amount: 100_000_00 },
        { month: "2026-11", category: "cloud", amount: 120_000_00 },
      ],
    });
    await owner.mutation(api.budget.setCells, {
      company: "kz",
      cells: [{ month: "2026-11", category: "cloud", amount: null }],
    });
    const got = await owner.query(api.budget.view, view);
    expect(got.currency).toBe("KZT");
    expect(got.cells).toEqual([{ month: "2026-10", category: "cloud", amount: 100_000_00 }]);
  });

  test("saving again replaces the cell", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    const save = (amount: number) =>
      owner.mutation(api.budget.setCells, {
        company: "us",
        cells: [{ month: "2026-10", category: "software", amount }],
      });
    await save(1_00);
    await save(2_00);
    const got = await owner.query(api.budget.view, { ...view, company: "us" });
    expect(got.cells).toEqual([{ month: "2026-10", category: "software", amount: 2_00 }]);
  });

  test("an amount that is not whole, negative or not a month is refused", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    const set = (cell: { month: string; amount: number }) =>
      owner.mutation(api.budget.setCells, { company: "us", cells: [{ category: "cloud", ...cell }] });
    await expect(set({ month: "2026-10", amount: 1.5 })).rejects.toThrow("whole number");
    await expect(set({ month: "2026-10", amount: -1 })).rejects.toThrow("whole number");
    await expect(set({ month: "2026-13", amount: 1 })).rejects.toThrow("not a month");
  });
});

// Payroll and Costs are the owner's alone: a Finance teammate, whatever their
// row says, is a viewer without either register.
describe("pay in the budget is for whoever holds Payroll: the owner", () => {
  test("to a teammate, even one whose row still says Payroll, the Payroll row is neither sent nor written", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.budget.setCells, {
      company: "us",
      cells: [
        { month: "2026-10", category: "payroll", amount: 50_000_00 },
        { month: "2026-10", category: "cloud", amount: 1_000_00 },
      ],
    });
    const finance = await signInWithAreas(t, "cofounder", ["finance", "payroll", "costs"]);
    const got = await finance.query(api.budget.view, { ...view, company: "us" });
    expect(got.payroll).toBe("hidden");
    expect(got.costs).toBe("hidden");
    expect(got.cells).toEqual([]);
    await expect(
      finance.mutation(api.budget.setCells, {
        company: "us",
        cells: [{ month: "2026-10", category: "payroll", amount: 1 }],
      }),
    ).rejects.toThrow(PAY_NEEDS_PAYROLL);
  });

  test("to the owner it is", async () => {
    const t = start();
    const both = await signInAsOwner(t);
    await both.mutation(api.budget.setCells, {
      company: "us",
      cells: [{ month: "2026-10", category: "payroll", amount: 50_000_00 }],
    });
    const got = await both.query(api.budget.view, { ...view, company: "us" });
    expect(got.payroll).toBe("shown");
    expect(got.cells).toHaveLength(1);
  });
});

describe("the Costs rows are for whoever holds Costs: the owner", () => {
  const typed = [
    { month: "2026-10", category: "payroll" as const, amount: 50_000_00 },
    { month: "2026-10", category: "cloud" as const, amount: 1_000_00 },
    { month: "2026-11", category: "office" as const, amount: 2_000_00 },
  ];

  test("to a teammate whose row still says Costs, no Costs row's typed cell is sent, and none can be written", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.budget.setCells, { company: "us", cells: typed });
    const payOnly = await signInWithAreas(t, "cofounder", ["finance", "costs"]);
    const got = await payOnly.query(api.budget.view, { ...view, company: "us" });
    expect(got.costs).toBe("hidden");
    expect(got.payroll).toBe("hidden");
    expect(got.cells).toEqual([]);
    await expect(
      payOnly.mutation(api.budget.setCells, {
        company: "us",
        cells: [{ month: "2026-10", category: "cloud", amount: 1 }],
      }),
    ).rejects.toThrow(COSTS_NEED_COSTS);
    // A save with a Costs cell in it writes nothing.
    await expect(
      payOnly.mutation(api.budget.setCells, {
        company: "us",
        cells: [
          { month: "2026-12", category: "office", amount: 1 },
          { month: "2026-12", category: "cloud", amount: 1 },
        ],
      }),
    ).rejects.toThrow(COSTS_NEED_COSTS);
    expect((await owner.query(api.budget.view, { ...view, company: "us" })).cells).toHaveLength(3);
  });

  test("with Finance alone, nothing of either register is sent: no typed cell at all", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.budget.setCells, { company: "us", cells: typed });
    const finance = await signInWithAreas(t, "cofounder", ["finance"]);
    const got = await finance.query(api.budget.view, { ...view, company: "us" });
    expect(got).toMatchObject({ payroll: "hidden", costs: "hidden", cells: [] });
    // An empty save is still theirs to send: the gate is Finance.
    await finance.mutation(api.budget.setCells, { company: "us", cells: [] });
  });

  test("to the owner they are sent and written", async () => {
    const t = start();
    const costs = await signInAsOwner(t);
    await costs.mutation(api.budget.setCells, { company: "us", cells: typed.slice(1) });
    const got = await costs.query(api.budget.view, { ...view, company: "us" });
    expect(got.costs).toBe("shown");
    expect(got.cells).toHaveLength(2);
  });
});

describe("Globex's actual spending, typed in", () => {
  test("set, read and cleared", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.budget.setActual, { company: "kz", month: "2026-09", amount: 7_000_000_00 });
    expect((await owner.query(api.budget.view, { ...view, first: "2026-09" })).actuals).toEqual([
      { month: "2026-09", amount: 7_000_000_00 },
    ]);
    await owner.mutation(api.budget.setActual, { company: "kz", month: "2026-09", amount: null });
    expect((await owner.query(api.budget.view, { ...view, first: "2026-09" })).actuals).toEqual([]);
  });

  test("Startup's comes from Mercury and is not typed", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.budget.setActual, { company: "us", month: "2026-09", amount: 1 }),
    ).rejects.toThrow(ACTUAL_IS_MERCURYS);
  });
});

describe("one company's budget is not the other's", () => {
  test("someone on Globex alone is refused Startup's, both ways", async () => {
    const t = start();
    const kzOnly = await signInWithAreas(t, "cofounder", ["finance", "payroll"], ["kz"]);
    await expect(kzOnly.query(api.budget.view, { ...view, company: "us" })).rejects.toThrow("not_allowed");
    await expect(
      kzOnly.mutation(api.budget.setCells, {
        company: "us",
        cells: [{ month: "2026-10", category: "cloud", amount: 1 }],
      }),
    ).rejects.toThrow("not_allowed");
    await expect(
      kzOnly.mutation(api.budget.setActual, { company: "us", month: "2026-09", amount: 1 }),
    ).rejects.toThrow("not_allowed");
  });

  test("without finance, nothing", async () => {
    const t = start();
    const sales = await signInWithAreas(t, "sales", ["sales", "costs"]);
    await expect(sales.query(api.budget.view, view)).rejects.toThrow("not_allowed");
  });
});
