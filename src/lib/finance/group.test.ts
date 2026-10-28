import { describe, expect, test } from "vitest";
import { financeSummary } from "@/lib/metrics/finance";
import type { Tile } from "@/lib/metrics/scorecard";
import {
  globexFigures,
  groupBudgetTotal,
  groupFigures,
  groupRunway,
  groupSum,
  latestRate,
  ownRunway,
  startupFigures,
  type CompanyFigures,
} from "./group";

// Every figure here is made up.

const tile = (key: string, scope: string, points: [string, number][]): Tile => ({
  key,
  scope,
  firstPeriodStart: points[0]?.[0] ?? null,
  latest:
    points.length === 0
      ? null
      : { periodStart: points.at(-1)![0], value: points.at(-1)![1], currency: null, source: "manual", syncedAt: 0 },
  series: points.map(([periodStart, value]) => ({ periodStart, value })),
});

describe("a group figure: Startup's dollars plus Globex's tenge at the stored rate", () => {
  test("both companies and a rate: one figure in dollars", () => {
    expect(groupSum({ us: 1_000, kz: 500_000 }, 500)).toEqual({ kind: "known", usd: 2_000 });
  });

  test("with no rate on record the group is not known, and says why; never Startup's figure alone", () => {
    expect(groupSum({ us: 1_000, kz: 500_000 }, null)).toEqual({ kind: "unknown", missing: ["fx"] });
    // A rate that is not a rate is none.
    expect(groupSum({ us: 1_000, kz: 500_000 }, 0)).toEqual({ kind: "unknown", missing: ["fx"] });
  });

  test("a company with no figure makes the group not known, whichever it is", () => {
    expect(groupSum({ us: null, kz: 500_000 }, 500)).toEqual({ kind: "unknown", missing: ["us"] });
    expect(groupSum({ us: 1_000, kz: null }, null)).toEqual({ kind: "unknown", missing: ["kz"] });
    expect(groupSum({ us: null, kz: 5 }, null)).toEqual({ kind: "unknown", missing: ["us", "fx"] });
  });

  test("zero tenge needs no rate to be zero dollars", () => {
    expect(groupSum({ us: 1_000, kz: 0 }, null)).toEqual({ kind: "known", usd: 1_000 });
  });

  test("in minor units the tenge part is rounded to a whole cent", () => {
    expect(groupSum({ us: 100, kz: 1_001 }, 500, { minor: true })).toEqual({ kind: "known", usd: 102 });
  });
});

describe("a month's budget for the group", () => {
  const known = (amount: number, excludes: ("payroll" | "costs")[] = []) => ({ kind: "known" as const, amount, excludes });

  test("Startup's total plus Globex's at the rate, in cents", () => {
    expect(groupBudgetTotal(known(1_000_00), known(500_000_00), 500)).toEqual({
      amount: { kind: "known", usd: 2_000_00 },
      excludes: [],
    });
  });

  test("what the viewer may not see is left out of both, and the group says so", () => {
    expect(groupBudgetTotal(known(1_000_00, ["payroll"]), known(500_000_00, ["payroll"]), 500)).toEqual({
      amount: { kind: "known", usd: 2_000_00 },
      excludes: ["payroll"],
    });
  });

  test("no rate, or a company's total not known: the group's is not known, never Startup's alone", () => {
    expect(groupBudgetTotal(known(1_000_00), known(500_000_00), null)).toEqual({
      amount: { kind: "unknown", missing: ["fx"] },
      excludes: [],
    });
    expect(groupBudgetTotal(known(1_000_00), { kind: "unknown", excludes: [] }, 500)).toEqual({
      amount: { kind: "unknown", missing: ["kz"] },
      excludes: [],
    });
    expect(groupBudgetTotal({ kind: "loading" }, known(1), 500)).toEqual({ kind: "loading" });
  });
});

describe("group runway: group cash ÷ group net burn", () => {
  const usd = (value: number) => ({ kind: "known" as const, usd: value });

  test("months of the group's cash at the group's burn", () => {
    expect(groupRunway(usd(12_000), usd(1_000))).toEqual({ kind: "months", months: 12 });
  });

  test("a group that takes in more than it spends is not burning", () => {
    expect(groupRunway(usd(12_000), usd(0))).toEqual({ kind: "not_burning" });
    expect(groupRunway(usd(12_000), usd(-50))).toEqual({ kind: "not_burning" });
  });

  test("either part not known: not known, with everything that is missing, never 0", () => {
    expect(groupRunway({ kind: "unknown", missing: ["fx"] }, usd(1_000))).toEqual({ kind: "unknown", missing: ["fx"] });
    expect(groupRunway({ kind: "unknown", missing: ["fx"] }, { kind: "unknown", missing: ["kz", "fx"] })).toEqual({
      kind: "unknown",
      missing: ["kz", "fx"],
    });
  });
});

describe("each company's own figures, in its own currency", () => {
  const CURRENT = "2026-10-01";
  const READ = Date.parse("2026-10-02T06:00:00Z");
  const kzCash: { periodStart: string; value: number }[] = [
    { periodStart: "2026-07-31", value: 5_569_500 },
    { periodStart: "2026-08-31", value: 5_369_500 },
    { periodStart: "2026-09-30", value: 5_000_000 },
  ];
  // Startup sent nothing these months; Globex's own burn reads it.
  const nothingSent = tile("cash_to_subsidiary", "us", [["2026-07-01", 0], ["2026-08-01", 0], ["2026-09-01", 0]]);

  test("Globex's balance, burn and MRR are in tenge with no rate on record", () => {
    const tiles = [tile("cash", "kz", [["2026-09-30", 5_000_000]]), tile("mrr", "kz", [["2026-09-01", 900_000]]), nothingSent];
    const got = globexFigures(tiles, kzCash, CURRENT, READ);
    expect(got.cash).toEqual({ amount: 5_000_000, periodStart: "2026-09-30" });
    // August fell 200,000 and September 369,500; July has no close before it.
    expect(got.netBurn).toEqual({ amount: 284_750, months: ["2026-08-01", "2026-09-01"] });
    // Its part of the group is its own burn.
    expect(got.groupBurn).toEqual(got.netBurn);
    expect(got.unsent).toEqual([]);
    expect(got.mrr).toEqual({ amount: 900_000, periodStart: "2026-09-01" });
    expect(ownRunway(got)).toEqual({ kind: "months", months: 5_000_000 / 284_750 });
  });

  test("financing that propped the balance up is taken out of Globex's burn", () => {
    const tiles = [tile("financing_in", "kz", [["2026-09-01", 1_000_000]]), nothingSent];
    expect(globexFigures(tiles, kzCash, CURRENT, READ).netBurn?.amount).toBe((200_000 + 1_369_500) / 2);
  });

  test("with no figures there are none: not zeros", () => {
    const none = { cash: null, netBurn: null, groupBurn: null, unsent: [], mrr: null };
    expect(globexFigures([], [], CURRENT, READ)).toEqual(none);
    expect(ownRunway(none)).toBeNull();
  });

  test("Startup's are the Finance page's own, from Mercury and the typed MRR", () => {
    const tiles = [
      tile("cash", "us", [["2026-10-01", 120_000]]),
      tile("cash_in", "us", [["2026-09-01", 2_000]]),
      tile("cash_out", "us", [["2026-09-01", 12_000]]),
      tile("cash_to_subsidiary", "us", [["2026-09-01", 0]]),
      tile("mrr", "us", [["2026-10-01", 5_500]]),
    ];
    const summary = financeSummary(tiles, [], CURRENT, READ, ["us"]);
    expect(startupFigures(summary, tiles)).toEqual({
      cash: { amount: 120_000, periodStart: "2026-10-01" },
      netBurn: { amount: 10_000, months: ["2026-09-01"] },
      groupBurn: { amount: 10_000, months: ["2026-09-01"] },
      unsent: [],
      mrr: { amount: 5_500, periodStart: "2026-10-01" },
    });
  });
});

describe("Startup funding its subsidiary: financing for Globex, never its income", () => {
  // Made up, at ₸500 per $1. In August Startup takes in $2,000, spends $10,000
  // outside the group and sends Globex $20,000 (₸10M): Mercury's money out
  // is $30,000. Globex starts August with ₸50M, receives the ₸10M and
  // spends ₸12.5M ($25,000), ending on ₸47.5M. Outside the group, $35,000
  // went out and $2,000 came in: the group burned $33,000, $8,000 of it
  // Startup's own and $25,000 Globex's.
  const CURRENT = "2026-09-01";
  const readAt = Date.parse("2026-09-02T06:00:00Z");
  const rate = tile("fx_usd_kzt", "company", [["2026-08-01", 500]]);
  const sent = tile("cash_to_subsidiary", "us", [["2026-08-01", 20_000]]);
  const startupTiles = [
    tile("cash", "us", [["2026-09-01", 500_000]]),
    tile("cash_in", "us", [["2026-08-01", 2_000]]),
    tile("cash_out", "us", [["2026-08-01", 30_000]]),
    sent,
  ];
  const kzCash = [
    { periodStart: "2026-07-31", value: 50_000_000 },
    { periodStart: "2026-08-31", value: 47_500_000 },
  ];
  const kzTiles = (financing: [string, number][] = []) => [
    tile("cash", "kz", [["2026-08-31", 47_500_000]]),
    tile("financing_in", "kz", financing),
    rate,
    sent,
  ];
  const startup = startupFigures(financeSummary(startupTiles, [], CURRENT, readAt, ["us"]), startupTiles);
  const globex = globexFigures(kzTiles(), kzCash, CURRENT, readAt);
  // The group's net burn as it was worked out before: Startup's whole burn plus
  // Globex's from its balances alone, the funding cancelling between them.
  const before = 28_000 + 2_500_000 / 500;

  test("Startup's own burn is the bank's, what it sent included; its part of the group is its own spending", () => {
    expect(startup.netBurn).toEqual({ amount: 28_000, months: ["2026-08-01"] });
    expect(startup.groupBurn).toEqual({ amount: 8_000, months: ["2026-08-01"] });
  });

  test("Globex's own burn takes what Startup sent out as financing: what it spent of its own", () => {
    // ₸2.5M fall in balance plus the ₸10M that lifted it.
    expect(globex.netBurn).toEqual({ amount: 12_500_000, months: ["2026-08-01"] });
    expect(globex.groupBurn).toEqual(globex.netBurn);
    // Its runway is how long its cash lasts without new money from Startup.
    expect(ownRunway(globex)).toEqual({ kind: "months", months: 47_500_000 / 12_500_000 });
  });

  test("the split adds up to the group's figure, and that figure is what it was", () => {
    const group = groupFigures(startup, globex, 500);
    expect(group.netBurn).toEqual({ kind: "known", usd: startup.groupBurn!.amount + globex.groupBurn!.amount / 500 });
    expect(group.netBurn).toEqual({ kind: "known", usd: before });
    expect(before).toBe(33_000);
  });

  test("over three months, funding that varies, the parts still add up to the old group figure exactly", () => {
    // Made up. Startup: out $30K/$25K/$40K, in $2K, sent $20K/$0/$35K.
    // Globex's balance: ₸50M, ₸47.5M, ₸45M, ₸52.5M; ₸500 per $1.
    const months = ["2026-06-01", "2026-07-01", "2026-08-01"] as const;
    const out = [30_000, 25_000, 40_000];
    const sentEach = [20_000, 0, 35_000];
    const tiles = [
      tile("cash", "us", [["2026-09-01", 500_000]]),
      tile("cash_in", "us", months.map((m) => [m, 2_000])),
      tile("cash_out", "us", months.map((m, i) => [m, out[i]!])),
      tile("cash_to_subsidiary", "us", months.map((m, i) => [m, sentEach[i]!])),
      tile("cash", "kz", [["2026-08-31", 52_500_000]]),
      rate,
    ];
    const balances = [
      { periodStart: "2026-05-31", value: 50_000_000 },
      { periodStart: "2026-06-30", value: 47_500_000 },
      { periodStart: "2026-07-31", value: 45_000_000 },
      { periodStart: "2026-08-31", value: 52_500_000 },
    ];
    const us = startupFigures(financeSummary(tiles, [], CURRENT, readAt, ["us"]), tiles);
    const kz = globexFigures(tiles, balances, CURRENT, readAt);
    // Before: Startup's whole burn, ($28K + $23K + $38K) ÷ 3 = $29,666.67, plus
    // Globex's from balances, (₸2.5M + ₸2.5M − ₸7.5M) ÷ 3 = −₸833,333.33,
    // i.e. −$1,666.67: $28,000.
    const old = (28_000 + 23_000 + 38_000) / 3 + (2_500_000 + 2_500_000 - 7_500_000) / 3 / 500;
    const got = groupFigures(us, kz, 500).netBurn;
    expect(got.kind === "known" && got.usd).toBeCloseTo(old, 6);
    expect(old).toBeCloseTo(28_000, 6);
    // The parts: Startup's own spending ($8K + $23K + $3K) ÷ 3 = $11,333.33;
    // Globex's (₸12.5M + ₸2.5M + ₸10M) ÷ 3 = ₸8,333,333.33, i.e. $16,666.67.
    expect(us.groupBurn?.amount).toBeCloseTo(34_000 / 3, 6);
    expect(kz.netBurn?.amount).toBeCloseTo(25_000_000 / 3, 2);
  });

  test("Startup's own burn does not change for the part it sent: cash_out stays the bank's total", () => {
    const without = startupTiles.filter((t) => t.key !== "cash_to_subsidiary");
    expect(startupFigures(financeSummary(without, [], CURRENT, readAt, ["us"]), without).netBurn).toEqual(startup.netBurn);
  });

  test("typed as Globex's financing as well, the transfer would be counted twice: so it never is", () => {
    const twice = globexFigures(kzTiles([["2026-08-01", 10_000_000]]), kzCash, CURRENT, readAt);
    // $53,000: the $20,000 is taken out of Globex's income twice.
    expect(groupFigures(startup, twice, 500).netBurn).toEqual({ kind: "known", usd: 53_000 });
  });

  test("a month with no figure of what was sent is left out of both parts, never as if nothing were sent", () => {
    const holed = [...startupTiles.filter((t) => t !== sent), tile("cash_to_subsidiary", "us", [])];
    const us = startupFigures(financeSummary(holed, [], CURRENT, readAt, ["us"]), holed);
    const kz = globexFigures([...kzTiles().filter((t) => t !== sent), tile("cash_to_subsidiary", "us", [])], kzCash, CURRENT, readAt);
    // Startup's own burn is the bank's and needs no such figure; its part does.
    expect(us.netBurn).toEqual(startup.netBurn);
    expect(us.groupBurn).toBeNull();
    expect(us.unsent).toEqual([{ month: "2026-08-01", lacks: "sent" }]);
    expect(kz.netBurn).toBeNull();
    expect(kz.unsent).toEqual([{ month: "2026-08-01", lacks: "sent" }]);
    expect(groupFigures(us, kz, 500).netBurn).toEqual({ kind: "unknown", missing: ["us", "kz"] });
  });

  test("dollars sent and no rate: Globex's part waits for the rate, and the group says the rate", () => {
    const noRate = kzTiles().filter((t) => t !== rate);
    const kz = globexFigures(noRate, kzCash, CURRENT, readAt);
    expect(kz.netBurn).toBeNull();
    expect(kz.unsent).toEqual([{ month: "2026-08-01", lacks: "fx" }]);
    expect(groupFigures(startup, kz, null).netBurn).toEqual({ kind: "unknown", missing: ["fx"] });
    expect(groupFigures(startup, kz, null).runway).toEqual({ kind: "unknown", missing: ["fx"] });
  });

  test("a month Mercury read before it ended holds part of what was sent: left out the same way", () => {
    const early = Date.parse("2026-08-20T06:00:00Z");
    expect(globexFigures(kzTiles(), kzCash, CURRENT, early).unsent).toEqual([{ month: "2026-08-01", lacks: "sent" }]);
  });
});

describe("the group: an example, and the case with no rate", () => {
  const startup: CompanyFigures = {
    cash: { amount: 400_000, periodStart: "2026-10-12" },
    netBurn: { amount: 20_000, months: ["2026-08-01", "2026-09-01"] },
    groupBurn: { amount: 20_000, months: ["2026-08-01", "2026-09-01"] },
    unsent: [],
    mrr: { amount: 5_500, periodStart: "2026-10-01" },
  };
  const globex: CompanyFigures = {
    cash: { amount: 5_000_000, periodStart: "2026-09-30" },
    netBurn: { amount: 284_750, months: ["2026-08-01", "2026-09-01"] },
    groupBurn: { amount: 284_750, months: ["2026-08-01", "2026-09-01"] },
    unsent: [],
    mrr: { amount: 5_000_000, periodStart: "2026-09-01" },
  };

  test("at ₸500 per $1: cash $410K, burn about $20,570 a month, runway about 19.9 months", () => {
    const got = groupFigures(startup, globex, 500);
    expect(got.cash).toEqual({ kind: "known", usd: 410_000 });
    expect(got.netBurn.kind === "known" && Math.round(got.netBurn.usd)).toBe(20_570);
    expect(got.mrr).toEqual({ kind: "known", usd: 15_500 });
    expect(got.runway.kind === "months" && Math.round(got.runway.months * 10) / 10).toBe(19.9);
  });

  test("with no rate: every group figure is not known for want of one, and nothing is zero", () => {
    const got = groupFigures(startup, globex, null);
    expect(got).toEqual({
      cash: { kind: "unknown", missing: ["fx"] },
      netBurn: { kind: "unknown", missing: ["fx"] },
      mrr: { kind: "unknown", missing: ["fx"] },
      runway: { kind: "unknown", missing: ["fx"] },
    });
  });

  test("the rate is the newest stored one, and only a real one", () => {
    const tiles = [tile("fx_usd_kzt", "company", [["2026-08-01", 470], ["2026-09-01", 500], ["2026-10-01", 0]])];
    expect(latestRate(tiles)).toEqual({ rate: 500, periodStart: "2026-09-01" });
    expect(latestRate([])).toBeNull();
  });
});
