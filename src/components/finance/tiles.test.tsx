// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { getMetric } from "@convex/lib/metricRegistry";
import type { CombinedPoint } from "@/lib/metrics/derive";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { supplyOf } from "@/lib/metrics/scorecard";
import { BurnMultipleTile } from "./burn-multiple-tile";
import { CashTile } from "./cash-tile";
import { NetBurnTile } from "./net-burn-tile";
import { RunwayTile } from "./runway-tile";

/**
 * The four tiles of a finance summary, as cards (the Dashboard's frame): the
 * page's hero draws the first three larger, with MRR, and the burn multiple
 * under Revenue health. Their words are the same in every frame.
 */
function FourTiles({ summary, now }: { summary: FinanceSummary; now: number }) {
  return (
    <>
      <CashTile cash={summary.cash} now={now} markets={summary.markets} />
      <NetBurnTile summary={summary} now={now} />
      <RunwayTile summary={summary} now={now} />
      <BurnMultipleTile burnMultiple={summary.burnMultiple} now={now} markets={summary.markets} />
    </>
  );
}

afterEach(cleanup);

const NOW = Date.UTC(2026, 9, 12, 12);
const EXPECTED = ["2026-07-01", "2026-08-01", "2026-09-01"];
const US = { scope: "us" as const, native: 400_000, usd: 400_000, periodStart: "2026-10-12" };
const KZ = { scope: "kz" as const, native: 5_000_000, usd: 10_000, periodStart: "2026-09-30" };
const base: FinanceSummary = {
  currentMonth: "2026-10-01",
  markets: ["us", "kz"],
  kzClosedMonths: [],
  burn: [],
  mrr: null,
  coverage: { us: true, kz: true },
  average: { value: 21_000, months: EXPECTED, expected: EXPECTED },
  cash: { usd: 410_000, rate: 500, ratePeriodStart: "2026-09-01", missing: [], parts: [US, KZ] },
  runway: { kind: "months", months: 19.5 },
  burnMultiple: { kind: "value", value: 2, months: 6, from: "2026-04-01", to: "2026-09-01" },
  lateCloses: [],
  financingProblems: [],
  unfinishedUsMonths: [],
  usFlowsReadAt: Date.UTC(2026, 9, 12, 6),
  funding: null,
};
const show = (patch: Partial<FinanceSummary> = {}) =>
  render(<FourTiles summary={{ ...base, ...patch }} now={NOW} />);
const tile = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);
const BURN = "Net burn";
/** A month of company burn, complete unless it is said what it is missing. */
const burnMonth = (periodStart: string, missing: CombinedPoint["missing"] = []): CombinedPoint => ({
  periodStart,
  value: 21_000,
  complete: missing.length === 0,
  missing,
  rate: 440,
  ratePeriodStart: "2026-06-01",
  parts: { us: missing.includes("us") ? null : 20_000, kz: 1_000 },
});
const [JUL, AUG, SEP] = EXPECTED as [string, string, string];

describe("Cash", () => {
  test("the total, each market with its date, and the rate used", () => {
    show();
    const cash = tile("Cash");
    expect(cash.getByText("$410K")).toBeTruthy();
    expect(cash.getByText("US $400K · Oct 12")).toBeTruthy();
    expect(cash.getByText("Kazakhstan ₸5M · Sep 30")).toBeTruthy();
    expect(cash.getByText("Converted at ₸500 per $1, the Sep 2026 rate.")).toBeTruthy();
    expect(cash.queryByText("partial")).toBeNull();
  });

  test("with no balance anywhere it says where each comes from", () => {
    show({ cash: null, runway: null });
    const cash = tile("Cash");
    expect(cash.getByText("No value yet")).toBeTruthy();
    expect(
      cash.getByText("US cash arrives with Mercury. Kazakhstan's balance is typed in."),
    ).toBeTruthy();
  });

  test("tenge alone with no rate is not shown as zero dollars", () => {
    show({ cash: { usd: 0, rate: null, ratePeriodStart: null, missing: ["us", "fx"], parts: [] }, runway: null });
    const cash = tile("Cash");
    expect(cash.getByText("No value yet")).toBeTruthy();
    expect(cash.queryByText("$0")).toBeNull();
    expect(
      cash.getByText("Kazakhstan is left out until a USD/KZT rate arrives with the CFO workbook."),
    ).toBeTruthy();
  });

  test("a market with no balance makes the total partial and says how to fix it", () => {
    show({ cash: { usd: 400_000, rate: null, ratePeriodStart: null, missing: ["kz"], parts: [US] }, runway: null });
    const cash = tile("Cash");
    expect(cash.getByText("partial")).toBeTruthy();
    expect(cash.getByText("US $400K · Oct 12")).toBeTruthy();
    expect(cash.getByRole("link", { name: "Enter Kazakhstan's balance" }).getAttribute("href")).toBe(
      "/finance?metric=cash&scope=kz#record-a-figure",
    );
  });

  test("a missing US balance points at Mercury", () => {
    show({ cash: { usd: 10_000, rate: 500, ratePeriodStart: "2026-09-01", missing: ["us"], parts: [KZ] }, runway: null });
    expect(tile("Cash").getByText("No US balance yet. It arrives with Mercury.")).toBeTruthy();
  });

  test("an old balance is marked out of date", () => {
    const old = { ...KZ, periodStart: "2026-07-31" };
    show({ cash: { ...base.cash!, parts: [US, old] } });
    expect(tile("Cash").getByText("Kazakhstan ₸5M · Jul 31 · out of date")).toBeTruthy();
    expect(tile("Runway").getByText("Uses a balance that is out of date.")).toBeTruthy();
  });
});

describe("Net burn", () => {
  test("before Mercury's first sync", () => {
    show({
      coverage: { us: false, kz: false },
      average: null,
      runway: null,
      burnMultiple: null,
      usFlowsReadAt: null,
    });
    expect(tile(BURN).getByText("Arrives with Mercury's first sync.")).toBeTruthy();
  });

  test("after a sync that has not yet seen a month to its end, it does not wait for a first sync", () => {
    show({ coverage: { us: false, kz: true }, average: null, runway: null, burnMultiple: null });
    expect(lines(BURN)).toEqual(["No value yet", "Needs a month Mercury has read to its end."]);
    expect(tile(BURN).queryByText(/first sync/)).toBeNull();
  });

  test("a US-only figure is withheld, with the reason and the fix", () => {
    show({ coverage: { us: true, kz: false }, average: null, runway: null, burnMultiple: null });
    const burn = tile(BURN);
    expect(burn.getByText("No value yet")).toBeTruthy();
    expect(burn.getByText(/US only so far, which would understate it\./)).toBeTruthy();
    expect(burn.getByRole("link", { name: "Enter Kazakhstan's balance" }).getAttribute("href")).toBe(
      "/finance?metric=cash&scope=kz#record-a-figure",
    );
  });

  test("no complete month among the last three", () => {
    show({ average: null, runway: null });
    expect(tile(BURN).getByText("None of the last three months is complete yet.")).toBeTruthy();
  });

  test("says which months the average is of", () => {
    show();
    const burn = tile(BURN);
    expect(burn.getByText("$21K / mo")).toBeTruthy();
    expect(burn.getByText("Average of Jul–Sep 2026.")).toBeTruthy();
  });

  test("an average of fewer months says so", () => {
    show({ average: { value: 21_000, months: ["2026-09-01"], expected: EXPECTED } });
    expect(
      tile(BURN).getByText("Average of 1 of the last 3 months. The rest are not complete."),
    ).toBeTruthy();
  });

  test("a company making money is not burning, and is asked whether that was a raise", () => {
    show({ average: { value: -4_000, months: EXPECTED, expected: EXPECTED } });
    const burn = tile(BURN);
    expect(burn.getByText("Not burning")).toBeTruthy();
    expect(burn.getByText("Money in exceeded money out by $4,000 a month.")).toBeTruthy();
    expect(burn.getByRole("link", { name: "financing received" }).getAttribute("href")).toBe(
      "/finance?metric=financing_in&scope=us#record-a-figure",
    );
  });

  test("a month-end balance entered late is said out loud", () => {
    show({ lateCloses: [{ month: "2026-09-01", date: "2026-10-02" }] });
    expect(
      tile(BURN).getByText(
        "Kazakhstan's Sep 2026 close is dated Oct 2, after the month ended. Money that moved in between is counted in Sep 2026.",
      ),
    ).toBeTruthy();
    const runway = tile("Runway");
    expect(
      runway.getByText("A month-end balance was entered late, so no benchmark verdict; see net burn."),
    ).toBeTruthy();
    expect(runway.queryByText(/typical for seed/i)).toBeNull();
  });

  test("financing that cannot be true is named, with its month", () => {
    show({ financingProblems: ["2026-09-01"] });
    expect(
      tile(BURN).getByText(
        "Sep 2026 has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.",
      ),
    ).toBeTruthy();
  });
});

describe("Runway", () => {
  test("months, with the seed benchmark", () => {
    show();
    const runway = tile("Runway");
    expect(runway.getByText("19.5 mo")).toBeTruthy();
    expect(runway.getByText(/typical for seed/i)).toBeTruthy();
    expect(runway.getByText("Cash ÷ average net burn.")).toBeTruthy();
  });

  test("one month of burn gives a number but no verdict", () => {
    show({ average: { value: 21_000, months: ["2026-09-01"], expected: EXPECTED } });
    const runway = tile("Runway");
    expect(runway.getByText("19.5 mo")).toBeTruthy();
    expect(runway.queryByText(/typical for seed/i)).toBeNull();
    expect(
      runway.getByText("One month of burn so far, so no benchmark verdict yet."),
    ).toBeTruthy();
  });

  test("withheld without net burn", () => {
    show({ average: null, runway: null });
    expect(tile("Runway").getByText("Needs net burn first.")).toBeTruthy();
  });

  test("withheld while a market's cash is missing", () => {
    show({ runway: null, cash: { usd: 400_000, rate: null, ratePeriodStart: null, missing: ["kz"], parts: [US] } });
    expect(tile("Runway").getByText("Needs every market's cash balance first.")).toBeTruthy();
  });

  test("not burning", () => {
    show({ runway: { kind: "not_burning" } });
    expect(
      tile("Runway").getByText("Cash is not falling, so there is nothing to count down."),
    ).toBeTruthy();
    expect(tile("Runway").queryByText(/Based on/)).toBeNull();
  });

  test("not burning on fewer than three months says how many it rests on", () => {
    show({
      runway: { kind: "not_burning" },
      average: { value: -4_000, months: ["2026-09-01"], expected: EXPECTED },
    });
    expect(lines("Runway")).toEqual([
      "Not burning",
      "Cash is not falling, so there is nothing to count down.",
      "Based on 1 of the last 3 months.",
    ]);
  });

  test("an absurdly long runway gets no number of months and no verdict", () => {
    show({ runway: { kind: "months", months: 41_000_000 } });
    const runway = tile("Runway");
    expect(runway.getByText("10+ years")).toBeTruthy();
    expect(runway.queryByText(/typical for seed/i)).toBeNull();
  });
});

describe("Burn multiple", () => {
  test("six months: the number, the run and the benchmark", () => {
    show();
    const multiple = tile("Burn multiple");
    expect(multiple.getByText("2")).toBeTruthy();
    expect(multiple.getByText("Net burn ÷ net new ARR, Apr–Sep 2026.")).toBeTruthy();
    expect(multiple.getByText(/typical for seed/i)).toBeTruthy();
  });

  test("no benchmark verdict on fewer than six months", () => {
    show({
      burnMultiple: { kind: "value", value: 2.5, months: 3, from: "2026-07-01", to: "2026-09-01" },
    });
    const multiple = tile("Burn multiple");
    expect(multiple.getByText("2.5")).toBeTruthy();
    expect(multiple.getByText("The benchmark is for six months or more; this is 3.")).toBeTruthy();
    expect(multiple.queryByText(/typical for seed/i)).toBeNull();
  });

  test("nothing to compute it from", () => {
    show({ burnMultiple: null });
    expect(tile("Burn multiple").getByText("Needs net burn and company MRR.")).toBeTruthy();
  });

  test("early in the month it names the month it is waiting for", () => {
    show({ burnMultiple: { kind: "none", reason: "last_month_incomplete" } });
    expect(
      tile("Burn multiple").getByText("Appears once Sep 2026 has complete burn and MRR."),
    ).toBeTruthy();
  });

  test("too little history", () => {
    show({ burnMultiple: { kind: "none", reason: "too_little_history" } });
    expect(
      tile("Burn multiple").getByText(
        "Needs three complete months of burn in a row, and MRR for the month before them.",
      ),
    ).toBeTruthy();
  });

  test("no growth is said in words, not shown as a number", () => {
    show({ burnMultiple: { kind: "none", reason: "no_growth" } });
    expect(tile("Burn multiple").getByText("No growth")).toBeTruthy();
  });

  test("not burning", () => {
    show({ burnMultiple: { kind: "none", reason: "not_burning" } });
    expect(
      tile("Burn multiple").getByText("Money in exceeded money out over the run."),
    ).toBeTruthy();
  });
});

// Every <p> of a tile in the order it is read: the value first, then the notes.
const lines = (label: string) =>
  Array.from(
    screen.getByRole("heading", { name: label }).closest("article")!.querySelectorAll("p"),
    (p) => p.textContent,
  );

describe("Cash, the rest of its table", () => {
  test("the value comes first, then each market, then the rate", () => {
    show();
    expect(lines("Cash")).toEqual([
      "$410K",
      "US $400K · Oct 12",
      "Kazakhstan ₸5M · Sep 30",
      "Converted at ₸500 per $1, the Sep 2026 rate.",
    ]);
  });

  test("the exact figure is the value's tooltip", () => {
    show({ cash: { ...base.cash!, usd: 410_123.4 } });
    expect(tile("Cash").getByText("$410.1K").getAttribute("title")).toBe("$410,123.4");
  });

  test("with no balance anywhere there is no list to read missing lines from", () => {
    show({ cash: null, runway: null });
    expect(lines("Cash")).toEqual([
      "No value yet",
      "US cash arrives with Mercury. Kazakhstan's balance is typed in.",
    ]);
  });

  test("tenge alone with no rate: where cash comes from, then each thing missing, and no badge", () => {
    show({ cash: { usd: 0, rate: null, ratePeriodStart: null, missing: ["us", "fx"], parts: [] }, runway: null });
    expect(lines("Cash")).toEqual([
      "No value yet",
      "US cash arrives with Mercury. Kazakhstan's balance is typed in.",
      "No US balance yet. It arrives with Mercury.",
      "Kazakhstan is left out until a USD/KZT rate arrives with the CFO workbook.",
    ]);
    expect(tile("Cash").queryByText("partial")).toBeNull();
  });

  test("a missing Kazakhstan balance is said in words, and nothing was converted", () => {
    show({ cash: { usd: 400_000, rate: null, ratePeriodStart: null, missing: ["kz"], parts: [US] }, runway: null });
    expect(lines("Cash")).toEqual([
      "$400K",
      "US $400K · Oct 12",
      "No Kazakhstan balance yet. Enter Kazakhstan's balance",
    ]);
  });

  test("a US total while tenge waits for a rate is partial and says what is left out", () => {
    show({ cash: { usd: 400_000, rate: null, ratePeriodStart: null, missing: ["fx"], parts: [US] }, runway: null });
    const cash = tile("Cash");
    expect(cash.getByText("partial")).toBeTruthy();
    expect(lines("Cash")).toEqual([
      "$400K",
      "US $400K · Oct 12",
      "Kazakhstan is left out until a USD/KZT rate arrives with the CFO workbook.",
    ]);
  });

  test("a Kazakhstan total alone is partial and still says the rate it used", () => {
    show({ cash: { usd: 10_000, rate: 500, ratePeriodStart: "2026-09-01", missing: ["us"], parts: [KZ] }, runway: null });
    expect(tile("Cash").getByText("partial")).toBeTruthy();
    expect(lines("Cash")).toEqual([
      "$10K",
      "Kazakhstan ₸5M · Sep 30",
      "Converted at ₸500 per $1, the Sep 2026 rate.",
      "No US balance yet. It arrives with Mercury.",
    ]);
  });

  test("the US balance goes out of date after three days, and a day in another year says which", () => {
    const usOld = { ...US, periodStart: "2026-10-08" };
    const kzOld = { ...KZ, periodStart: "2025-12-31" };
    show({ cash: { ...base.cash!, parts: [usOld, kzOld] } });
    const cash = tile("Cash");
    expect(cash.getByText("US $400K · Oct 8 · out of date")).toBeTruthy();
    expect(cash.getByText("Kazakhstan ₸5M · Dec 31, 2025 · out of date")).toBeTruthy();
  });

  test("a US balance three days old is still current", () => {
    show({ cash: { ...base.cash!, parts: [{ ...US, periodStart: "2026-10-09" }, KZ] } });
    expect(tile("Cash").getByText("US $400K · Oct 9")).toBeTruthy();
    expect(tile("Runway").queryByText("Uses a balance that is out of date.")).toBeNull();
  });
});

describe("Net burn, the rest of its table", () => {
  test("the exact figure is the value's tooltip", () => {
    show({ average: { value: 21_034.5, months: EXPECTED, expected: EXPECTED } });
    expect(tile(BURN).getByText("$21K / mo").getAttribute("title")).toBe("$21,034.5");
  });

  test("the US-only reason is one sentence ending in the fix", () => {
    show({ coverage: { us: true, kz: false }, average: null, runway: null, burnMultiple: null });
    expect(lines(BURN)).toEqual([
      "No value yet",
      "US only so far, which would understate it. Enter Kazakhstan's bank balance at two month-ends in a row. Enter Kazakhstan's balance",
    ]);
  });

  test("Mercury comes first: with neither market in, it does not ask for a balance", () => {
    show({
      coverage: { us: false, kz: false },
      average: null,
      runway: null,
      burnMultiple: null,
      usFlowsReadAt: null,
    });
    expect(lines(BURN)).toEqual(["No value yet", "Arrives with Mercury's first sync."]);
    expect(tile(BURN).queryByRole("link")).toBeNull();
  });

  test("not burning: the surplus, then the question about a raise, whole", () => {
    show({ average: { value: -4_000, months: EXPECTED, expected: EXPECTED } });
    expect(lines(BURN)).toEqual([
      "Not burning",
      "Money in exceeded money out by $4,000 a month.",
      "If investor money arrived, record it as financing received, so it is not counted as income.",
    ]);
  });

  test("not burning on fewer than three months says how many, and what the others lack", () => {
    show({
      average: { value: -4_000, months: ["2026-09-01"], expected: EXPECTED },
      burn: [burnMonth(AUG, ["kz"]), burnMonth(SEP)],
    });
    expect(lines(BURN)).toEqual([
      "Not burning",
      "Money in exceeded money out by $4,000 a month.",
      "Average of 1 of the last 3 months. The rest are not complete.",
      "Jul 2026 has no figures yet.",
      "Aug 2026 is missing Kazakhstan's month-end balance.",
      "If investor money arrived, record it as financing received, so it is not counted as income.",
    ]);
  });

  test("so does a burn of exactly zero", () => {
    show({
      average: { value: 0, months: [AUG, SEP], expected: EXPECTED },
      burn: [burnMonth(JUL, ["fx"]), burnMonth(AUG), burnMonth(SEP)],
    });
    expect(lines(BURN).slice(0, 4)).toEqual([
      "Not burning",
      "Money in matched money out.",
      "Average of 2 of the last 3 months. The rest are not complete.",
      "Jul 2026 is missing a USD/KZT rate.",
    ]);
  });

  test("not burning does not hide a late close or a financing problem", () => {
    show({
      average: { value: -4_000, months: EXPECTED, expected: EXPECTED },
      financingProblems: ["2026-08-01"],
      lateCloses: [{ month: "2026-09-01", date: "2026-10-02" }],
    });
    expect(lines(BURN).slice(3)).toEqual([
      "Aug 2026 has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.",
      "Kazakhstan's Sep 2026 close is dated Oct 2, after the month ended. Money that moved in between is counted in Sep 2026.",
    ]);
  });

  test("a run across a year boundary names both years", () => {
    const expected = ["2025-11-01", "2025-12-01", "2026-01-01"];
    show({ average: { value: 21_000, months: expected, expected } });
    expect(tile(BURN).getByText("Average of Nov 2025–Jan 2026.")).toBeTruthy();
  });

  test("two of three months", () => {
    show({ average: { value: 21_000, months: ["2026-08-01", "2026-09-01"], expected: EXPECTED } });
    expect(
      tile(BURN).getByText("Average of 2 of the last 3 months. The rest are not complete."),
    ).toBeTruthy();
  });

  test("a financing problem in the only US month explains why Mercury's figure is absent", () => {
    show({
      coverage: { us: false, kz: true },
      average: null,
      runway: null,
      burnMultiple: null,
      financingProblems: ["2026-09-01"],
    });
    expect(lines(BURN)).toEqual([
      "No value yet",
      "Needs a month Mercury has read to its end.",
      "Sep 2026 has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.",
    ]);
  });

  test("the row's own note, then every financing problem, then every late close", () => {
    show({
      financingProblems: ["2026-08-01", "2026-09-01"],
      lateCloses: [
        { month: "2025-12-01", date: "2026-01-02" },
        { month: "2026-09-01", date: "2026-10-02" },
      ],
    });
    expect(lines(BURN)).toEqual([
      "$21K / mo",
      "Average of Jul–Sep 2026.",
      "Aug 2026 has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.",
      "Sep 2026 has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.",
      "Kazakhstan's Dec 2025 close is dated Jan 2, after the month ended. Money that moved in between is counted in Dec 2025.",
      "Kazakhstan's Sep 2026 close is dated Oct 2, after the month ended. Money that moved in between is counted in Sep 2026.",
    ]);
  });
});

describe("Net burn: a month Mercury did not finish reading", () => {
  const SHORT = "Sep 2026 is not counted: Mercury was last read on Sep 20, before the month ended.";
  const short = {
    unfinishedUsMonths: ["2026-09-01"],
    usFlowsReadAt: Date.parse("2026-09-20T06:00:00Z"),
  };
  const twoOfThree = { value: 21_000, months: ["2026-07-01", "2026-08-01"], expected: EXPECTED };

  test("is named, with the day Mercury was last read", () => {
    show({
      ...short,
      average: twoOfThree,
      burn: [burnMonth(JUL), burnMonth(AUG), burnMonth(SEP, ["us"])],
    });
    expect(lines(BURN)).toEqual([
      "$21K / mo",
      "Average of 2 of the last 3 months. The rest are not complete.",
      SHORT,
    ]);
  });

  test.each<[string, Partial<FinanceSummary>]>([
    ["before the US is covered", { coverage: { us: false, kz: true }, average: null, runway: null }],
    ["before Kazakhstan is covered", { coverage: { us: true, kz: false }, average: null, runway: null }],
    ["with no complete month", { average: null, runway: null }],
    ["when not burning", { average: { ...twoOfThree, value: -4_000 } }],
    ["under a whole average", {}],
  ])("is said in every state: %s", (_name, patch) => {
    show({ ...short, ...patch });
    expect(tile(BURN).getByText(SHORT)).toBeTruthy();
  });

  test("each short month has its own line, oldest first, before the other doubts", () => {
    show({
      unfinishedUsMonths: ["2026-08-01", "2026-09-01"],
      usFlowsReadAt: Date.parse("2026-08-14T06:00:00Z"),
      average: { value: 21_000, months: ["2026-07-01"], expected: EXPECTED },
      burn: [burnMonth(JUL), burnMonth(AUG, ["us"]), burnMonth(SEP, ["us"])],
      financingProblems: ["2026-06-01"],
    });
    expect(lines(BURN).slice(2)).toEqual([
      "Aug 2026 is not counted: Mercury was last read on Aug 14, before the month ended.",
      "Sep 2026 is not counted: Mercury was last read on Aug 14, before the month ended.",
      "Jun 2026 has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.",
    ]);
  });

  test("a read in another year says which year", () => {
    show({ unfinishedUsMonths: ["2025-12-01"], usFlowsReadAt: Date.parse("2025-12-20T06:00:00Z") });
    expect(
      tile(BURN).getByText(
        "Dec 2025 is not counted: Mercury was last read on Dec 20, 2025, before the month ended.",
      ),
    ).toBeTruthy();
  });

  test("with no successful read on record there is no day to name, so it says that once", () => {
    show({
      coverage: { us: false, kz: true },
      average: null,
      runway: null,
      unfinishedUsMonths: ["2026-08-01", "2026-09-01"],
      usFlowsReadAt: null,
    });
    expect(lines(BURN)).toEqual([
      "No value yet",
      "Arrives with Mercury's first sync.",
      "Mercury's months are not counted: no successful read is on record.",
    ]);
  });

  test("months read whole are not mentioned", () => {
    show();
    expect(tile(BURN).queryByText(/is not counted/)).toBeNull();
    expect(tile(BURN).queryByText(/are not counted/)).toBeNull();
  });
});

describe("Net burn: what an incomplete month is missing", () => {
  test("with no complete month, each of the three says what it lacks, oldest first", () => {
    show({
      average: null,
      runway: null,
      burn: [burnMonth(JUL, ["kz"]), burnMonth(AUG, ["fx"]), burnMonth(SEP, ["us"])],
    });
    expect(lines(BURN)).toEqual([
      "No value yet",
      "None of the last three months is complete yet.",
      "Jul 2026 is missing Kazakhstan's month-end balance.",
      "Aug 2026 is missing a USD/KZT rate.",
      "Sep 2026 is missing Mercury's figures.",
    ]);
  });

  test("a month with no figure from either market says so", () => {
    show({ average: null, runway: null, burn: [burnMonth(JUL, ["kz"]), burnMonth(AUG, ["kz"])] });
    expect(lines(BURN).slice(2)).toEqual([
      "Jul 2026 is missing Kazakhstan's month-end balance.",
      "Aug 2026 is missing Kazakhstan's month-end balance.",
      "Sep 2026 has no figures yet.",
    ]);
  });

  test("a month lacking two things names both in one sentence", () => {
    show({
      average: null,
      runway: null,
      burn: [burnMonth(JUL, ["kz", "fx"]), burnMonth(AUG, ["us", "fx"]), burnMonth(SEP, ["us", "kz", "fx"])],
    });
    expect(lines(BURN).slice(2)).toEqual([
      "Jul 2026 is missing Kazakhstan's month-end balance and a USD/KZT rate.",
      "Aug 2026 is missing Mercury's figures and a USD/KZT rate.",
      "Sep 2026 is missing Mercury's figures, Kazakhstan's month-end balance and a USD/KZT rate.",
    ]);
  });

  test("an average of fewer months says what each month left out is missing", () => {
    show({
      average: { value: 21_000, months: [SEP], expected: EXPECTED },
      burn: [burnMonth(AUG, ["kz"]), burnMonth(SEP)],
    });
    expect(lines(BURN)).toEqual([
      "$21K / mo",
      "Average of 1 of the last 3 months. The rest are not complete.",
      "Jul 2026 has no figures yet.",
      "Aug 2026 is missing Kazakhstan's month-end balance.",
    ]);
  });

  test("a missing US figure that already has its own line is not said twice", () => {
    show({
      average: null,
      runway: null,
      burn: [burnMonth(JUL, ["kz"]), burnMonth(AUG, ["us"]), burnMonth(SEP, ["us"])],
      financingProblems: [AUG],
      unfinishedUsMonths: [SEP],
      usFlowsReadAt: Date.parse("2026-09-20T06:00:00Z"),
    });
    expect(lines(BURN)).toEqual([
      "No value yet",
      "None of the last three months is complete yet.",
      "Jul 2026 is missing Kazakhstan's month-end balance.",
      "Sep 2026 is not counted: Mercury was last read on Sep 20, before the month ended.",
      "Aug 2026 has no burn figure: the financing recorded is more than the money that came in. Check which month it is filed under.",
    ]);
  });

  test("the months are the three before the summary's own month, whatever year that is", () => {
    render(
      <FourTiles
        summary={{ ...base, currentMonth: "2027-01-01", average: null, runway: null }}
        now={Date.UTC(2027, 0, 3)}
      />,
    );
    expect(lines(BURN).slice(2)).toEqual([
      "Oct 2026 has no figures yet.",
      "Nov 2026 has no figures yet.",
      "Dec 2026 has no figures yet.",
    ]);
  });

  test("a whole average and a company not burning list nothing", () => {
    show();
    expect(tile(BURN).queryByText(/is missing|has no figures yet/)).toBeNull();
    cleanup();
    show({ average: { value: -4_000, months: EXPECTED, expected: EXPECTED } });
    expect(tile(BURN).queryByText(/is missing|has no figures yet|Average of/)).toBeNull();
  });

  test("a balance that is on record is not called missing: the one before it is", () => {
    // Balances for Sep 30 and Oct 31, seen in November.
    render(
      <FourTiles
        summary={{
          ...base,
          currentMonth: "2026-11-01",
          kzClosedMonths: [SEP, "2026-10-01"],
          average: { value: 21_000, months: ["2026-10-01"], expected: [AUG, SEP, "2026-10-01"] },
          burn: [burnMonth(AUG, ["kz"]), burnMonth(SEP, ["kz"]), burnMonth("2026-10-01")],
        }}
        now={Date.UTC(2026, 10, 5)}
      />,
    );
    expect(lines(BURN)).toEqual([
      "$21K / mo",
      "Average of 1 of the last 3 months. The rest are not complete.",
      "Aug 2026 is missing Kazakhstan's month-end balance.",
      "Sep 2026 has no Kazakhstan burn figure: the balance at the end of Aug 2026 is missing.",
    ]);
  });

  test("across a year end the balance before is named with its year", () => {
    render(
      <FourTiles
        summary={{
          ...base,
          currentMonth: "2027-02-01",
          kzClosedMonths: ["2027-01-01"],
          average: null,
          runway: null,
          burn: [burnMonth("2027-01-01", ["us", "kz"])],
        }}
        now={Date.UTC(2027, 1, 5)}
      />,
    );
    expect(lines(BURN).at(-1)).toBe(
      "Jan 2027 is missing Mercury's figures. Jan 2027 has no Kazakhstan burn figure: the balance at the end of Dec 2026 is missing.",
    );
  });
});

describe("Net burn: exactly nothing burned", () => {
  test("an average of zero is not burning, and nothing 'exceeded' anything", () => {
    show({ average: { value: 0, months: EXPECTED, expected: EXPECTED } });
    expect(lines(BURN)).toEqual([
      "Not burning",
      "Money in matched money out.",
      "If investor money arrived, record it as financing received, so it is not counted as income.",
    ]);
  });

  test("a small surplus is still a surplus, with its amount", () => {
    show({ average: { value: -50, months: EXPECTED, expected: EXPECTED } });
    expect(lines(BURN).slice(0, 2)).toEqual([
      "Not burning",
      "Money in exceeded money out by $50 a month.",
    ]);
  });

  test("a surplus too small to show is not written as $0", () => {
    show({ average: { value: -0.4, months: EXPECTED, expected: EXPECTED } });
    expect(lines(BURN).slice(0, 2)).toEqual(["Not burning", "Money in matched money out."]);
  });
});

describe("Runway, the rest of its table", () => {
  test("the verdict, then how it is worked out", () => {
    show();
    const runway = tile("Runway");
    expect(lines("Runway")).toEqual(["19.5 mo", "Cash ÷ average net burn."]);
    const chip = runway.getByRole("button", { name: /typical for seed/i });
    const note = runway.getByText("Cash ÷ average net burn.");
    expect(chip.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("an out-of-date balance is the last thing said", () => {
    show({ cash: { ...base.cash!, parts: [US, { ...KZ, periodStart: "2026-07-31" }] } });
    expect(lines("Runway")).toEqual([
      "19.5 mo",
      "Cash ÷ average net burn.",
      "Uses a balance that is out of date.",
    ]);
  });

  test("one month of burn and a late close: both reasons, and no verdict", () => {
    show({
      average: { value: 21_000, months: ["2026-09-01"], expected: EXPECTED },
      lateCloses: [{ month: "2026-09-01", date: "2026-10-02" }],
    });
    expect(lines("Runway")).toEqual([
      "19.5 mo",
      "One month of burn so far, so no benchmark verdict yet.",
      "A month-end balance was entered late, so no benchmark verdict; see net burn.",
      "Cash ÷ average net burn.",
    ]);
    expect(tile("Runway").queryByText(/typical for seed/i)).toBeNull();
  });

  test("two months of burn are enough for a verdict", () => {
    show({ average: { value: 21_000, months: ["2026-08-01", "2026-09-01"], expected: EXPECTED } });
    const runway = tile("Runway");
    expect(runway.getByText(/typical for seed/i)).toBeTruthy();
    expect(runway.queryByText(/no benchmark verdict/)).toBeNull();
  });

  test("without net burn, that is the reason given even when cash is missing too", () => {
    show({
      average: null,
      runway: null,
      cash: { usd: 400_000, rate: null, ratePeriodStart: null, missing: ["kz"], parts: [US] },
    });
    expect(lines("Runway")).toEqual(["No value yet", "Needs net burn first."]);
  });

  test("withheld for cash: no number and no verdict", () => {
    show({ runway: null, cash: { usd: 400_000, rate: null, ratePeriodStart: null, missing: ["kz"], parts: [US] } });
    expect(lines("Runway")).toEqual(["No value yet", "Needs every market's cash balance first."]);
    expect(tile("Runway").queryByText(/typical for seed/i)).toBeNull();
  });

  test("not burning is the value, with no verdict", () => {
    show({ runway: { kind: "not_burning" } });
    expect(lines("Runway")).toEqual([
      "Not burning",
      "Cash is not falling, so there is nothing to count down.",
    ]);
    expect(tile("Runway").queryByText(/typical for seed/i)).toBeNull();
  });

  test("an absurdly long runway says only how it is worked out", () => {
    show({ runway: { kind: "months", months: 41_000_000 } });
    expect(lines("Runway")).toEqual(["10+ years", "Cash ÷ average net burn."]);
    expect(tile("Runway").getByText("10+ years").getAttribute("title")).toBeNull();
  });

  test("ten years exactly is still a number of months; a day more is not", () => {
    show({ runway: { kind: "months", months: 120 } });
    expect(tile("Runway").getByText("120 mo")).toBeTruthy();
    expect(tile("Runway").getByText(/typical for seed/i)).toBeTruthy();
    cleanup();
    show({ runway: { kind: "months", months: 120.04 } });
    expect(tile("Runway").getByText("10+ years")).toBeTruthy();
  });
});

describe("Burn multiple, the rest of its table", () => {
  test("six months: the verdict comes before the run", () => {
    show();
    const multiple = tile("Burn multiple");
    expect(lines("Burn multiple")).toEqual(["2", "Net burn ÷ net new ARR, Apr–Sep 2026."]);
    const chip = multiple.getByRole("button", { name: /typical for seed/i });
    const note = multiple.getByText("Net burn ÷ net new ARR, Apr–Sep 2026.");
    expect(chip.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("fewer than six months: the run, then why there is no verdict", () => {
    show({
      burnMultiple: { kind: "value", value: 2.5, months: 5, from: "2026-05-01", to: "2026-09-01" },
    });
    expect(lines("Burn multiple")).toEqual([
      "2.5",
      "Net burn ÷ net new ARR, May–Sep 2026.",
      "The benchmark is for six months or more; this is 5.",
    ]);
    expect(tile("Burn multiple").queryByText(/typical for seed/i)).toBeNull();
  });

  test("the exact figure is the value's tooltip", () => {
    show({
      burnMultiple: { kind: "value", value: 2.4567, months: 6, from: "2026-04-01", to: "2026-09-01" },
    });
    expect(tile("Burn multiple").getByText("2.46").getAttribute("title")).toBe("2.46");
  });

  test("every withheld state shows no number and no verdict", () => {
    const withheld: [FinanceSummary["burnMultiple"], string[]][] = [
      [null, ["No value yet", "Needs net burn and company MRR."]],
      [
        { kind: "none", reason: "last_month_incomplete" },
        ["No value yet", "Appears once Sep 2026 has complete burn and MRR."],
      ],
      [
        { kind: "none", reason: "too_little_history" },
        [
          "No value yet",
          "Needs three complete months of burn in a row, and MRR for the month before them.",
        ],
      ],
      [
        { kind: "none", reason: "no_growth" },
        ["No growth", "MRR did not grow over the run, so there is nothing to divide the burn by."],
      ],
      [
        { kind: "none", reason: "not_burning" },
        ["Not burning", "Money in exceeded money out over the run."],
      ],
    ];
    for (const [burnMultiple, expected] of withheld) {
      show({ burnMultiple });
      expect(lines("Burn multiple")).toEqual(expected);
      expect(tile("Burn multiple").queryByText(/typical for seed/i)).toBeNull();
      cleanup();
    }
  });

  test("in January the month it waits for is last year's December", () => {
    render(
      <FourTiles
        summary={{ ...base, burnMultiple: { kind: "none", reason: "last_month_incomplete" } }}
        now={Date.UTC(2027, 0, 3)}
      />,
    );
    expect(
      tile("Burn multiple").getByText("Appears once Dec 2026 has complete burn and MRR."),
    ).toBeTruthy();
  });
});

describe("the four tiles", () => {
  test("say where figures come from in fixed words, which hold only while the registry agrees", () => {
    // If ownership of one of these changes, this fails before the copy goes stale.
    expect(supplyOf(getMetric("cash")!, "us")).toMatchObject({ how: "source", source: "Mercury" });
    expect(supplyOf(getMetric("cash")!, "kz")).toEqual({
      how: "enter",
      href: "/finance?metric=cash&scope=kz#record-a-figure",
    });
    expect(supplyOf(getMetric("financing_in")!, "us")).toEqual({
      how: "enter",
      href: "/finance?metric=financing_in&scope=us#record-a-figure",
    });
    expect(supplyOf(getMetric("fx_usd_kzt")!, "company")).toMatchObject({
      how: "source",
      source: "the CFO workbook",
    });
  });

  test("are drawn in reading order", () => {
    show();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Cash",
      BURN,
      "Runway",
      "Burn multiple",
    ]);
  });
});
