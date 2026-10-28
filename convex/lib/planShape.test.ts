import { describe, expect, test } from "vitest";
import {
  PLAN_KEY_DEFS,
  PLAN_KEYS,
  PLAN_SCENARIOS,
  isPlanKey,
  isPlanScenario,
} from "./planShape";

describe("the plan's shape", () => {
  test("the scenarios, in the order they are shown", () => {
    expect([...PLAN_SCENARIOS]).toEqual(["bear", "base", "bull"]);
  });

  test("the figures, in the order the Finance page lists them", () => {
    expect([...PLAN_KEYS]).toEqual([
      "arr",
      "revenue",
      "net_burn",
      "cash_end",
      "headcount",
      "paying_customers",
      "capital_raised",
    ]);
  });

  test("every figure has a label, a unit and limits that leave room for a value", () => {
    for (const key of PLAN_KEYS) {
      const def = PLAN_KEY_DEFS[key];
      expect(def.label.length, key).toBeGreaterThan(0);
      expect(["currency", "count"], key).toContain(def.unit);
      expect(def.min, key).toBeLessThan(def.max);
    }
  });

  test("isPlanKey knows the figures and nothing else", () => {
    expect(isPlanKey("arr")).toBe(true);
    expect(isPlanKey("mrr")).toBe(false);
    expect(isPlanKey(undefined)).toBe(false);
  });

  test("isPlanScenario knows the scenarios and nothing else", () => {
    expect(isPlanScenario("base")).toBe(true);
    expect(isPlanScenario("moon")).toBe(false);
    expect(isPlanScenario(3)).toBe(false);
  });
});
