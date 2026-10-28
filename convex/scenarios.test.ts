import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { BAD_CHANGE, MAX_SCENARIOS, NEEDS_A_NAME, SCENARIOS_FULL } from "./scenarios";
import { OWNER, modules, signInAsOwner, signInWithAreas } from "./test.setup";

// Runway scenarios. Every name and amount here is made up.

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
const hire = {
  kind: "hire" as const,
  label: "Made-up engineer",
  startMonth: "2026-12",
  amount: 6_500_00,
  currency: "USD" as const,
  fromPayroll: { salary: 5_000_00, basis: "net" as const },
};

describe("scenarios", () => {
  test("saved, read back cleaned, edited and deleted", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.scenarios.save, {
      company: "us",
      name: "  Hire\u0000 two  ",
      changes: [hire, { ...hire, kind: "cash_in", label: "Made-up raise", endMonth: "2027-03", fromPayroll: undefined }],
    });
    let list = await owner.query(api.scenarios.list, { company: "us" });
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Hire two");
    // A one-off keeps no end month.
    expect(list[0]!.changes[1]!.endMonth).toBeNull();
    expect(list[0]!.changes[0]!.fromPayroll).toEqual({ salary: 5_000_00, basis: "net" });

    await owner.mutation(api.scenarios.save, { company: "us", id, name: "Hire one", changes: [hire] });
    list = await owner.query(api.scenarios.list, { company: "us" });
    expect(list.map((s) => [s.name, s.changes.length])).toEqual([["Hire one", 1]]);

    await owner.mutation(api.scenarios.remove, { id });
    expect(await owner.query(api.scenarios.list, { company: "us" })).toEqual([]);
  });

  test("ten a company at most", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    for (let i = 0; i < MAX_SCENARIOS; i += 1) {
      await owner.mutation(api.scenarios.save, { company: "kz", name: `S${i}`, changes: [] });
    }
    await expect(
      owner.mutation(api.scenarios.save, { company: "kz", name: "One more", changes: [] }),
    ).rejects.toThrow(SCENARIOS_FULL);
    // The other company's are its own.
    await owner.mutation(api.scenarios.save, { company: "us", name: "Startup's", changes: [] });
  });

  test("a bad change or no name is refused", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    const save = (change: object, name = "x") =>
      owner.mutation(api.scenarios.save, { company: "us", name, changes: [{ ...hire, ...change }] });
    await expect(save({}, "   ")).rejects.toThrow(NEEDS_A_NAME);
    await expect(save({ amount: -1 })).rejects.toThrow(BAD_CHANGE);
    await expect(save({ amount: 1.5 })).rejects.toThrow(BAD_CHANGE);
    await expect(save({ startMonth: "2026-13" })).rejects.toThrow(BAD_CHANGE);
    await expect(save({ endMonth: "2026-11" })).rejects.toThrow(BAD_CHANGE);
    await expect(save({ kind: "cost", fromPayroll: { salary: 1, basis: "gross" } })).rejects.toThrow(BAD_CHANGE);
    // A saving is a negative cost.
    await save({ kind: "cost", amount: -1_00, fromPayroll: undefined });
  });

  test("one company's scenarios are not the other's", async () => {
    const t = start();
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.scenarios.save, { company: "us", name: "Startup's", changes: [] });
    const kzOnly = await signInWithAreas(t, "cofounder", ["finance"], ["kz"]);
    await expect(kzOnly.query(api.scenarios.list, { company: "us" })).rejects.toThrow("not_allowed");
    await expect(kzOnly.mutation(api.scenarios.remove, { id })).rejects.toThrow("not_allowed");
    await expect(
      kzOnly.mutation(api.scenarios.save, { company: "kz", id, name: "Mine now", changes: [] }),
    ).rejects.toThrow("not_allowed");
    expect(await owner.query(api.scenarios.list, { company: "us" })).toHaveLength(1);
  });
});
