import { describe, expect, test } from "vitest";
import { US, clinic } from "./fixtures";
import {
  NO_FILTERS,
  applyFilters,
  assess,
  baaText,
  dateText,
  feeText,
  filtersFromParams,
  filtersToQuery,
  hasFilters,
  healthCounts,
  nextTouchText,
  owedText,
  usageText,
} from "./view";

// The register was pushed on the 10th: ages are counted to that day.
const REG = { day: "2026-10-10", label: "Oct 10" };
const NOW = Date.UTC(2026, 9, 12, 12);
const LATE = { lastPaymentDate: "2026-06-01" };

describe("filtersFromParams and filtersToQuery", () => {
  test("no parameters is no filter", () => {
    expect(filtersFromParams(new URLSearchParams(""))).toEqual(NO_FILTERS);
    expect(filtersToQuery(NO_FILTERS)).toBe("");
    expect(hasFilters(NO_FILTERS)).toBe(false);
  });

  test("the links the home page uses", () => {
    expect(filtersFromParams(new URLSearchParams("health=at_risk"))).toEqual({
      ...NO_FILTERS,
      health: "at_risk",
    });
    expect(filtersFromParams(new URLSearchParams("baa=missing"))).toEqual({
      ...NO_FILTERS,
      baaMissing: true,
    });
  });

  test("a round trip", () => {
    const filters = { health: "watch" as const, baaMissing: true, market: "us" as const, archived: true };
    const query = filtersToQuery(filters);
    expect(query).toBe("?health=watch&baa=missing&market=us&archived=1");
    expect(filtersFromParams(new URLSearchParams(query))).toEqual(filters);
    expect(hasFilters(filters)).toBe(true);
  });

  test("what it does not recognise is ignored", () => {
    expect(
      filtersFromParams(new URLSearchParams("health=terrible&market=uk&baa=yes&archived=true")),
    ).toEqual(NO_FILTERS);
  });

  test("showing archived clinics is not itself a filter", () => {
    expect(hasFilters({ ...NO_FILTERS, archived: true })).toBe(false);
  });
});

describe("applyFilters", () => {
  const rows = assess(
    [
      clinic({ name: "SECRET A" }),
      clinic({ name: "SECRET B", ...LATE }),
      clinic({ name: "SECRET C", ...US }),
      clinic({ name: "SECRET D", ...US, baaDate: "2026-03-03" }),
      clinic({ name: "SECRET E", ...LATE, archived: true }),
    ],
    REG,
  );
  const names = (filters: Partial<typeof NO_FILTERS>) =>
    applyFilters(rows, { ...NO_FILTERS, ...filters }).map((r) => r.clinic.name);

  test("archived clinics are hidden until asked for", () => {
    expect(names({})).toEqual(["SECRET A", "SECRET B", "SECRET C", "SECRET D"]);
    expect(names({ archived: true })).toHaveLength(5);
  });

  test("by health", () => {
    expect(names({ health: "at_risk" })).toEqual(["SECRET B"]);
    // The archived clinic paid late too, and is not assessed.
    expect(names({ health: "not_assessed", archived: true })).toEqual(["SECRET E"]);
  });

  test("US clinics with no BAA date on record", () => {
    expect(names({ baaMissing: true })).toEqual(["SECRET C"]);
  });

  test("by market, and filters combine", () => {
    expect(names({ market: "us" })).toEqual(["SECRET C", "SECRET D"]);
    expect(names({ market: "us", health: "at_risk" })).toEqual([]);
  });
});

describe("healthCounts", () => {
  test("counts clinics still in the register, by level", () => {
    const rows = assess(
      [
        clinic(),
        clinic(LATE),
        clinic({ lastUsageDate: "2026-09-20" }),
        clinic({ lastPaymentDate: null, amountOwed: null, lastUsageDate: null }),
        clinic({ status: "paused" }),
        clinic({ ...LATE, archived: true }),
      ],
      REG,
    );
    expect(healthCounts(rows)).toEqual({
      at_risk: 1,
      watch: 1,
      unknown: 1,
      good: 1,
      not_assessed: 1,
    });
  });
});

describe("how a value reads", () => {
  test("a date", () => {
    expect(dateText("2026-10-01", NOW)).toBe("Oct 1");
    expect(dateText("2025-03-01", NOW)).toBe("Mar 1, 2025");
    expect(dateText(null, NOW)).toBe("Not on record");
  });

  test("a fee and a balance that are not on record say so; they are never zero", () => {
    const blank = clinic({ monthlyFee: null, amountOwed: null });
    expect(feeText(blank)).toBe("Not on record");
    expect(owedText(blank)).toBe("Not on record");
    expect(`${feeText(blank)} ${owedText(blank)}`).not.toMatch(/0/);
  });

  test("a fee and a balance on record, in the market's currency", () => {
    expect(feeText(clinic())).toBe("₸200K");
    expect(owedText(clinic({ amountOwed: 120_000 }))).toBe("₸120K");
    expect(owedText(clinic({ ...US, amountOwed: 1_500 }))).toBe("$1,500");
    expect(owedText(clinic({ amountOwed: 0 }))).toBe("Nothing owed");
  });

  test("no usage date is unknown, not never", () => {
    expect(usageText(clinic({ lastUsageDate: null }), NOW)).toBe("Unknown");
    expect(usageText(clinic(), NOW)).toBe("Oct 9");
  });

  test("a BAA date: on record, not on record, or not applicable", () => {
    expect(baaText(clinic({ ...US, baaDate: "2026-03-03" }), NOW)).toBe("Mar 3");
    // A blank cell proves there is no date in the register, not that there is no BAA.
    expect(baaText(clinic(US), NOW)).toBe("No date on record");
    expect(baaText(clinic(), NOW)).toBe("Not applicable");
  });

  test("the next touch", () => {
    expect(nextTouchText(clinic(), NOW)).toBe("Not set");
    expect(nextTouchText(clinic({ nextTouch: "2026-10-20" }), NOW)).toBe("Oct 20");
  });
});
