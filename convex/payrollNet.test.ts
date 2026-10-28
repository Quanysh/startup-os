import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_PAYROLL_AMOUNT } from "./lib/limits";
import schema from "./schema";
import { OWNER, modules, signInAsOwner } from "./test.setup";

// Pay entered as net, and the gross worked out from it. Every name, salary
// and rate here is made up. None is a statutory figure.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Owner = Awaited<ReturnType<typeof signInAsOwner>>;
const SEP = "2026-09-01";
const KZ_SEP = { company: "kz", month: SEP } as const;
const NET_ONLY = "Someone entered as net needs a monthly net, and no monthly gross.";
const GROSS_ONLY = "Someone entered as gross needs a monthly gross, and no monthly net.";

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  return { t, owner };
};
const addPerson = (owner: Owner, extra: Record<string, unknown> = {}) =>
  owner.mutation(api.payroll.createPerson, {
    company: "kz",
    name: "Nia Example",
    kind: "employee",
    payBasis: "net",
    monthlyNet: 450_000_00,
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
const people = (owner: Owner) => owner.query(api.payroll.listPeople, { company: "kz" });
const only = async (owner: Owner) => (await people(owner))[0]!;
const prepare = (owner: Owner) => owner.mutation(api.payroll.prepareRun, KZ_SEP);
const saved = async (owner: Owner) => (await owner.query(api.payroll.getRun, KZ_SEP))!;
const row = async (owner: Owner) => (await saved(owner)).rows[0]!;

describe("a person's pay basis", () => {
  test("entered as net: the net is stored, and no gross", async () => {
    const { t, owner } = await start();
    await addPerson(owner);
    expect(await only(owner)).toMatchObject({
      payBasis: "net",
      monthlyNet: 450_000_00,
      monthlyGross: null,
    });
    const stored = await t.run((ctx) => ctx.db.query("payrollPeople").first());
    expect(stored).toMatchObject({ payBasis: "net", monthlyNet: 450_000_00 });
    expect(stored).not.toHaveProperty("monthlyGross");
  });

  test("entered as gross, said or not said: the gross is stored, and no net", async () => {
    const { owner } = await start();
    await addPerson(owner, { payBasis: "gross", monthlyNet: undefined, monthlyGross: 500_000_00 });
    await addPerson(owner, { name: "Old Caller", payBasis: undefined, monthlyNet: undefined, monthlyGross: 1 });
    expect(await people(owner)).toMatchObject([
      { payBasis: "gross", monthlyGross: 500_000_00, monthlyNet: null },
      { payBasis: "gross", monthlyGross: 1, monthlyNet: null },
    ]);
  });

  test("someone from before there was a choice is gross-based, exactly as they were", async () => {
    const { t, owner } = await start();
    await t.run((ctx) =>
      ctx.db.insert("payrollPeople", {
        company: "kz",
        name: "Before Example",
        kind: "employee",
        monthlyGross: 500_000_00,
        currency: "KZT",
        order: 0,
      }),
    );
    await addLine(owner);
    expect(await only(owner)).toMatchObject({
      payBasis: "gross",
      monthlyGross: 500_000_00,
      monthlyNet: null,
    });
    await prepare(owner);
    expect(await row(owner)).toMatchObject({
      basis: "gross",
      targetNet: null,
      gross: 500_000_00,
      net: 450_000_00,
    });
    // Editing something else leaves the row without a basis of its own.
    const id = (await only(owner)).id;
    await owner.mutation(api.payroll.updatePerson, { id, title: "Engineer" });
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored).not.toHaveProperty("payBasis");
    expect(stored).toMatchObject({ monthlyGross: 500_000_00 });
  });

  test.each([
    [{ monthlyNet: undefined }, NET_ONLY],
    [{ monthlyGross: 500_000_00 }, NET_ONLY],
    [{ monthlyNet: undefined, monthlyGross: 500_000_00 }, NET_ONLY],
    [{ payBasis: "gross" }, GROSS_ONLY],
    [{ payBasis: "gross", monthlyGross: 1 }, GROSS_ONLY],
    [{ payBasis: undefined }, GROSS_ONLY],
    [{ payBasis: "gross", monthlyNet: undefined }, GROSS_ONLY],
    [{ monthlyNet: -1 }, "The monthly net must be a whole amount, zero or more."],
    [{ monthlyNet: 100.5 }, "The monthly net must be a whole amount, zero or more."],
    [{ monthlyNet: MAX_PAYROLL_AMOUNT + 1 }, "The monthly net is too large."],
  ])("create with %j is refused", async (extra, message) => {
    const { owner } = await start();
    await expect(addPerson(owner, extra)).rejects.toThrow(message);
    expect(await people(owner)).toEqual([]);
  });

  test("a basis that is neither is refused", async () => {
    const { owner } = await start();
    await expect(addPerson(owner, { payBasis: "hourly" })).rejects.toThrow(/Validator error/);
  });

  test("update: the net changes; the basis switches only with its own figure; the other figure goes", async () => {
    const { t, owner } = await start();
    const id = await addPerson(owner);
    const update = (change: Record<string, unknown>) =>
      owner.mutation(api.payroll.updatePerson, { id, ...change } as never);

    await update({ monthlyNet: 460_000_00 });
    expect(await only(owner)).toMatchObject({ payBasis: "net", monthlyNet: 460_000_00 });

    await expect(update({ monthlyGross: 1 })).rejects.toThrow(NET_ONLY);
    await expect(update({ payBasis: "gross" })).rejects.toThrow(GROSS_ONLY);
    await expect(update({ payBasis: "gross", monthlyGross: 1, monthlyNet: 1 })).rejects.toThrow(
      GROSS_ONLY,
    );
    await expect(update({ monthlyNet: 0.5 })).rejects.toThrow(
      "The monthly net must be a whole amount, zero or more.",
    );
    expect(await only(owner)).toMatchObject({ payBasis: "net", monthlyNet: 460_000_00 });

    await update({ payBasis: "gross", monthlyGross: 500_000_00 });
    expect(await only(owner)).toMatchObject({
      payBasis: "gross",
      monthlyGross: 500_000_00,
      monthlyNet: null,
    });
    expect(await t.run((ctx) => ctx.db.get(id))).not.toHaveProperty("monthlyNet");

    await expect(update({ monthlyNet: 1 })).rejects.toThrow(GROSS_ONLY);
    await expect(update({ payBasis: "net" })).rejects.toThrow(NET_ONLY);
    await update({ payBasis: "net", monthlyNet: 410_000_00 });
    expect(await only(owner)).toMatchObject({
      payBasis: "net",
      monthlyNet: 410_000_00,
      monthlyGross: null,
    });
  });
});

describe("a month with someone entered as net", () => {
  test("the row stores the gross worked out, the net asked for and that it was net-based", async () => {
    const { t, owner } = await start();
    await addPerson(owner, { monthlyNet: 410_000_00 });
    const pension = await addLine(owner);
    await addLine(owner, { name: "Income", lessLineIds: [pension], allowance: 50_000_00 });
    await addLine(owner, { name: "Levy", paidBy: "company", rateBp: 350 });
    await prepare(owner);
    expect(await row(owner)).toMatchObject({
      basis: "net",
      targetNet: 410_000_00,
      gross: 500_000_00,
      grossMissing: null,
      lines: [
        { name: "Pension", base: 500_000_00, amount: 50_000_00 },
        { name: "Income", base: 400_000_00, amount: 40_000_00 },
        { name: "Levy", base: 500_000_00, amount: 17_500_00 },
      ],
      withheld: 90_000_00,
      net: 410_000_00,
      companyPaid: 17_500_00,
      cost: 517_500_00,
      notComputed: 0,
    });
    const stored = (await t.run((ctx) => ctx.db.query("payrollRuns").first()))!.rows[0];
    expect(stored).toMatchObject({ basis: "net", targetNet: 410_000_00, gross: 500_000_00 });
    expect((await saved(owner)).totals[0]!.overall).toMatchObject({
      gross: 500_000_00,
      net: 410_000_00,
      cost: 517_500_00,
      notComputed: 0,
    });
  });

  test("frozen: a rate or a net changed afterwards leaves the saved gross; recalculating re-derives it", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    const pension = await addLine(owner);
    await prepare(owner);
    expect(await row(owner)).toMatchObject({ gross: 500_000_00, targetNet: 450_000_00 });

    await owner.mutation(api.payroll.updateLine, { id: pension, rateBp: 2000 });
    await owner.mutation(api.payroll.updatePerson, { id, monthlyNet: 400_000_00 });
    expect(await row(owner)).toMatchObject({ gross: 500_000_00, targetNet: 450_000_00, net: 450_000_00 });

    await prepare(owner);
    // 400,000 is 80% of 500,000.
    expect(await row(owner)).toMatchObject({
      gross: 500_000_00,
      targetNet: 400_000_00,
      net: 400_000_00,
      lines: [{ rateBp: 2000, amount: 100_000_00 }],
    });
  });

  test("a paid month never changes, whatever is done to the person or the lines", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    const pension = await addLine(owner);
    await prepare(owner);
    await owner.mutation(api.payroll.markPaid, { ...KZ_SEP, paidOn: "2026-10-05" });
    await owner.mutation(api.payroll.updateLine, { id: pension, rateBp: null });
    await owner.mutation(api.payroll.updatePerson, { id, payBasis: "gross", monthlyGross: 1 });
    expect(await saved(owner)).toMatchObject({ status: "paid" });
    expect(await row(owner)).toMatchObject({
      basis: "net",
      targetNet: 450_000_00,
      gross: 500_000_00,
      net: 450_000_00,
    });
  });

  test("an adjustment is added to the net and the cost, on the gross worked out from today's lines", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    const pension = await addLine(owner);
    await owner.mutation(api.payroll.setAdjustment, { ...KZ_SEP, personId: id, amount: 20_000_00 });
    expect(await row(owner)).toMatchObject({
      gross: 500_000_00,
      targetNet: 450_000_00,
      adjustment: 20_000_00,
      net: 470_000_00,
      cost: 520_000_00,
    });
    // The month is not paid, so a rate changed since is in it once it is
    // saved again; the adjustment is kept, on top of the new gross.
    await owner.mutation(api.payroll.updateLine, { id: pension, rateBp: 5000 });
    await owner.mutation(api.payroll.markPaid, { ...KZ_SEP, paidOn: "2026-10-05" });
    expect(await row(owner)).toMatchObject({
      gross: 900_000_00,
      adjustment: 20_000_00,
      net: 470_000_00,
      cost: 920_000_00,
    });
  });

  test("a withheld rate not set: no gross is saved, the month is incomplete and cannot be marked paid", async () => {
    const { owner } = await start();
    const id = await addPerson(owner);
    const pension = await addLine(owner, { rateBp: undefined });
    await addLine(owner, { name: "Levy", paidBy: "company", rateBp: 350 });
    await prepare(owner);
    expect(await row(owner)).toMatchObject({
      basis: "net",
      targetNet: 450_000_00,
      gross: null,
      cost: null,
      grossMissing: "rate_not_set",
      lines: [
        { name: "Pension", amount: null, base: null, skipped: "rate_not_set" },
        { name: "Levy", rateBp: 350, amount: null, skipped: "gross_unknown" },
      ],
      net: 450_000_00,
      rateNotSet: 1,
      grossUnknown: 1,
      notComputed: 2,
    });
    expect((await saved(owner)).totals[0]!.overall).toMatchObject({
      people: 1,
      gross: 0,
      net: 450_000_00,
      notComputed: 2,
    });
    const BLOCKED =
      "Some lines have no amount. Set each rate or switch the line off, then mark the month paid.";
    const pay = () => owner.mutation(api.payroll.markPaid, { ...KZ_SEP, paidOn: "2026-10-05" });
    await expect(pay()).rejects.toThrow(BLOCKED);

    // A deduction is held to the net entered, there being no gross to hold it to.
    await expect(
      owner.mutation(api.payroll.setAdjustment, { ...KZ_SEP, personId: id, amount: -450_000_01 }),
    ).rejects.toThrow("A deduction cannot be more than the month's gross.");
    await owner.mutation(api.payroll.setAdjustment, { ...KZ_SEP, personId: id, amount: -50_000_00 });
    expect(await row(owner)).toMatchObject({ net: 400_000_00, gross: null, cost: null });

    // Once the rate is set, marking paid works the month out as it is then.
    await owner.mutation(api.payroll.updateLine, { id: pension, rateBp: 1000 });
    await pay();
    expect(await saved(owner)).toMatchObject({ status: "paid" });
    expect(await row(owner)).toMatchObject({ gross: 500_000_00, net: 400_000_00, grossMissing: null });
  });

  test("a company-paid rate not set: the gross is saved, the cost is incomplete", async () => {
    const { owner } = await start();
    await addPerson(owner);
    await addLine(owner);
    await addLine(owner, { name: "Levy", paidBy: "company", rateBp: undefined });
    await prepare(owner);
    expect(await row(owner)).toMatchObject({
      gross: 500_000_00,
      grossMissing: null,
      cost: 500_000_00,
      rateNotSet: 1,
      notComputed: 1,
    });
  });

  test("paid in the other currency, with a withheld line that has an allowance: unknowable", async () => {
    const { owner } = await start();
    await addPerson(owner, { currency: "USD", monthlyNet: 4_000_00 });
    await addLine(owner, { allowance: 1_000 });
    await prepare(owner);
    expect(await row(owner)).toMatchObject({
      currency: "USD",
      gross: null,
      grossMissing: "other_currency",
      lines: [{ skipped: "other_currency" }],
      net: 4_000_00,
    });
    await expect(
      owner.mutation(api.payroll.markPaid, { ...KZ_SEP, paidOn: "2026-10-05" }),
    ).rejects.toThrow("Some lines have no amount.");
  });

  test("withheld rates that leave no gross: said on the row, and the month is not paid", async () => {
    const { owner } = await start();
    await addPerson(owner);
    await addLine(owner, { rateBp: 10_000 });
    await prepare(owner);
    expect(await row(owner)).toMatchObject({
      gross: null,
      grossMissing: "no_gross",
      lines: [{ rateBp: 10_000, skipped: "gross_unknown" }],
    });
    await expect(
      owner.mutation(api.payroll.markPaid, { ...KZ_SEP, paidOn: "2026-10-05" }),
    ).rejects.toThrow("Some lines have no amount.");
  });

  test("no refusal about a net quotes it", async () => {
    const { owner } = await start();
    const message = await addPerson(owner, { name: "SECRET Person", monthlyNet: 987_654_321.5 }).then(
      () => "no refusal",
      (error: Error) => error.message,
    );
    expect(message).toContain("The monthly net must be a whole amount");
    expect(message).not.toContain("SECRET");
    expect(message).not.toMatch(/98.?765/);
  });
});
