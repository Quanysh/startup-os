import { describe, expect, test } from "vitest";
import { chartScale, niceTicks } from "./chart";

describe("the runway chart's scale", () => {
  test("always holds zero, so the line it is measured against is in view", () => {
    const scale = chartScale([[100, 80, 60]]);
    expect(scale.min).toBe(0);
    expect(scale.max).toBeGreaterThanOrEqual(100);
    expect(scale.y(0)).toBe(100);
    expect(scale.y(scale.max)).toBe(0);
  });

  test("reaches below zero when cash does", () => {
    const scale = chartScale([[50, -20], [10, 5]]);
    expect(scale.min).toBeLessThanOrEqual(-20);
    expect(scale.y(0)).toBeGreaterThan(0);
    expect(scale.y(0)).toBeLessThan(100);
  });

  test("ticks are round numbers covering the range, zero among them", () => {
    expect(niceTicks(0, 95_000_00)).toEqual([0, 20_000_00, 40_000_00, 60_000_00, 80_000_00, 100_000_00]);
    expect(niceTicks(-30, 90)).toContain(0);
  });
});

describe("small ranges", () => {
  test("ticks are whole, distinct and rising, even when every value is zero or small", () => {
    for (const [min, max] of [[0, 0], [0, 1], [0, 3], [-2, 0], [0, 4]] as const) {
      const ticks = niceTicks(min, max);
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks.every((t, i) => i === 0 || t > ticks[i - 1]!)).toBe(true);
      expect(ticks[0]!).toBeLessThanOrEqual(min);
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(max);
    }
  });
});

