import { describe, expect, test } from "vitest";
import { BENCHMARKS, classify, type Benchmark } from "./benchmarks";

const growth: Benchmark = {
  id: "test_growth",
  label: "Growth",
  better: "higher",
  typical: [15, 25],
  bands: "<10% / 15–25% / >25%",
  derived: false,
  source: { name: "Test", url: "https://example.com", year: "2025" },
};

const burn: Benchmark = { ...growth, id: "test_burn", better: "lower", typical: [2, 3] };

describe("classify", () => {
  test("inside the published typical band is typical", () => {
    expect(classify(18, growth)).toBe("typical");
    expect(classify(2.5, burn)).toBe("typical");
  });

  test("a value on either edge of the band counts as typical", () => {
    expect(classify(15, growth)).toBe("typical");
    expect(classify(25, growth)).toBe("typical");
    expect(classify(2, burn)).toBe("typical");
    expect(classify(3, burn)).toBe("typical");
  });

  test("higher-is-better: below the band is weaker, above it stronger", () => {
    expect(classify(8, growth)).toBe("weaker");
    expect(classify(60, growth)).toBe("stronger");
  });

  test("a value between the weak band and the typical band is weaker than typical, not in range", () => {
    // 12% month-over-month sits between "<10%" and "15–25%". Calling it in
    // range would contradict the band printed next to it.
    expect(classify(12, growth)).toBe("weaker");
  });

  test("lower-is-better: above the band is weaker, below it stronger", () => {
    expect(classify(3.4, burn)).toBe("weaker");
    expect(classify(1.2, burn)).toBe("stronger");
  });

  test("no verdict for a value that is not a number", () => {
    expect(classify(Number.NaN, growth)).toBeNull();
    expect(classify(Number.POSITIVE_INFINITY, growth)).toBeNull();
  });
});

describe("benchmark registry", () => {
  const all = Object.values(BENCHMARKS);

  test("ids match their keys", () => {
    for (const [key, b] of Object.entries(BENCHMARKS)) expect(b.id).toBe(key);
  });

  test("every benchmark cites a source with an https URL and a year", () => {
    for (const b of all) {
      expect(b.source.url, b.id).toMatch(/^https:\/\//);
      expect(b.source.year, b.id).toMatch(/\d{4}/);
      expect(b.source.name.length, b.id).toBeGreaterThan(0);
    }
  });

  test("every typical band runs low to high", () => {
    for (const b of all) expect(b.typical[0], b.id).toBeLessThan(b.typical[1]);
  });

  test("month-over-month growth of 12% reads as weaker than typical", () => {
    expect(classify(12, BENCHMARKS.mrr_growth_mom)).toBe("weaker");
    expect(classify(20, BENCHMARKS.mrr_growth_mom)).toBe("typical");
  });

  test("a burn multiple of 3.5 is weaker, and 1.2 stronger", () => {
    expect(classify(3.5, BENCHMARKS.burn_multiple)).toBe("weaker");
    expect(classify(1.2, BENCHMARKS.burn_multiple)).toBe("stronger");
  });
});
