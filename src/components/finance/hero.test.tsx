// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CombinedPoint } from "@/lib/metrics/derive";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { companyMrr, type Tile } from "@/lib/metrics/scorecard";
import { FinanceHero } from "./hero";
import { forgetCountUps } from "./motion";

afterEach(() => {
  cleanup();
  forgetCountUps();
});

const NOW = Date.UTC(2026, 9, 12, 12);
const day = (periodStart: string, value: number) => ({ periodStart, value });
const tile = (key: string, scope: string, points: [string, number][], source = "manual"): Tile => ({
  key,
  scope,
  firstPeriodStart: points[0]?.[0] ?? null,
  latest: points.length
    ? { value: points.at(-1)![1], periodStart: points.at(-1)![0], currency: null, source, syncedAt: NOW }
    : null,
  series: points.map(([periodStart, value]) => ({ periodStart, value })),
});
const burn = (periodStart: string, value: number, market: "us" | "kz" = "us"): CombinedPoint => ({
  periodStart,
  value,
  complete: true,
  missing: [],
  rate: null,
  ratePeriodStart: null,
  parts: { us: market === "us" ? value : null, kz: market === "kz" ? value : null },
});

const US_TILES = [tile("mrr", "us", [["2026-08-01", 4_000], ["2026-09-01", 5_000], ["2026-10-01", 5_500]])];
const US: FinanceSummary = {
  currentMonth: "2026-10-01",
  markets: ["us"],
  burn: [burn("2026-06-01", 25_000), burn("2026-07-01", 20_000), burn("2026-08-01", 20_000), burn("2026-09-01", 20_000)],
  coverage: { us: true, kz: false },
  average: { value: 20_000, months: ["2026-07-01", "2026-08-01", "2026-09-01"], expected: ["2026-07-01", "2026-08-01", "2026-09-01"] },
  cash: {
    usd: 400_000,
    parts: [{ scope: "us", native: 400_000, usd: 400_000, periodStart: "2026-10-12" }],
    missing: [],
    rate: null,
    ratePeriodStart: null,
  },
  mrr: companyMrr(US_TILES),
  runway: { kind: "months", months: 20 },
  burnMultiple: null,
  lateCloses: [],
  financingProblems: [],
  kzClosedMonths: [],
  unfinishedUsMonths: [],
  usFlowsReadAt: NOW,
  funding: { side: "parent", perMonth: 0 },
};
const US_DAILY = { us: [day("2026-09-30", 420_000), day("2026-10-12", 400_000)], kz: [] };

const show = (
  summary: FinanceSummary = US,
  tiles: Tile[] = US_TILES,
  daily: { us: { periodStart: string; value: number }[]; kz: { periodStart: string; value: number }[] } = US_DAILY,
) =>
  render(
    <FinanceHero
      summary={summary}
      now={NOW}
      tiles={tiles}
      daily={daily}
      company={summary.markets.length === 1 ? summary.markets[0]! : null}
    />,
  );
const figure = (label: string) =>
  within(
    within(screen.getByRole("region", { name: "Summary" }))
      .getByRole("heading", { name: label })
      .closest("article")!,
  );
/** A figure's words in full: the number and its quieter unit ("$20K / mo"). */
const valueOf = (label: string) =>
  within(screen.getByRole("region", { name: "Summary" }))
    .getByRole("heading", { name: label })
    .closest("article")!
    .querySelector("p")!.textContent;

describe("the hero: cash ÷ net burn = runway, and MRR", () => {
  test("the four figures, in the order of the sum, under a heading that is not shown", () => {
    show();
    const heading = screen.getByRole("heading", { level: 2, name: "Summary" });
    expect(heading.classList.contains("sr-only")).toBe(true);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Cash",
      "Net burn",
      "Runway",
      "MRR",
    ]);
  });

  test("each figure in its final words (with no motion to run, nothing counts)", () => {
    show();
    expect(figure("Cash").getByText("$400K")).toBeTruthy();
    expect(valueOf("Net burn")).toBe("$20K / mo");
    expect(valueOf("Runway")).toBe("20 mo");
    expect(figure("MRR").getByText("$5,500")).toBeTruthy();
    // The exact figure is the tooltip of the words that count.
    expect(figure("Cash").getByText("$400K").getAttribute("title")).toBe("$400,000");
  });

  test("each with its change against last month, good or bad in words as well as colour", () => {
    show();
    // 420,000 at the end of September; 400,000 now.
    expect(figure("Cash").getByText("−4.8%")).toBeTruthy();
    expect(figure("Cash").getByText("vs the end of Sep")).toBeTruthy();
    expect(figure("Cash").getByText("(a decline)")).toBeTruthy();
    // Jun–Aug averaged 21,667; Jul–Sep 20,000: less burned is better.
    expect(figure("Net burn").getByText("−7.7%")).toBeTruthy();
    expect(figure("Net burn").getByText("(an improvement)")).toBeTruthy();
    // 420,000 ÷ 21,667 = 19.4 months then; 20 now.
    expect(figure("Runway").getByText("+0.6 mo")).toBeTruthy();
    expect(figure("MRR").getByText("+10%")).toBeTruthy();
    expect(figure("MRR").getByText("vs Sep")).toBeTruthy();
  });

  test("and where it comes from, said once: one market's balance is not repeated in a note", () => {
    show();
    expect(figure("Cash").getByText("Mercury · Oct 12")).toBeTruthy();
    expect(figure("Cash").queryByText(/^US \$400K/)).toBeNull();
    expect(figure("Net burn").getByText("Mercury")).toBeTruthy();
    expect(figure("MRR").getByText("Typed in · Oct 2026")).toBeTruthy();
  });

  test("runway says when cash runs out, from the runway projection at today's burn", () => {
    show();
    // 400,000 less 20,000 a month first ends below zero at the end of the 21st month.
    expect(figure("Runway").getByText("Runs out in Jun 2028")).toBeTruthy();
  });

  test("with nothing to compare against, it says so, never a change from zero", () => {
    show(US, US_TILES, { us: [day("2026-10-12", 400_000)], kz: [] });
    expect(figure("Cash").getByText("No figure for the end of Sep to compare with yet.")).toBeTruthy();
    expect(figure("Cash").queryByText(/%/)).toBeNull();
  });

  test("a missing figure is 'Not known yet' in its place, never 0", () => {
    show({ ...US, cash: null, runway: null, average: null, mrr: null }, [], { us: [], kz: [] });
    const region = within(screen.getByRole("region", { name: "Summary" }));
    expect(region.getAllByText("Not known yet")).toHaveLength(4);
    expect(screen.getByRole("region", { name: "Summary" }).textContent).not.toMatch(/\$0\b/);
  });
});

describe("Globex: tenge first, dollars alongside", () => {
  const KZ_TILES = [tile("mrr", "kz", [["2026-08-01", 4_000_000], ["2026-09-01", 5_000_000]], "cfo_workbook"), tile("fx_usd_kzt", "company", [["2026-09-01", 500]], "cfo_workbook")];
  const KZ: FinanceSummary = {
    ...US,
    markets: ["kz"],
    burn: [burn("2026-07-01", 1_000, "kz"), burn("2026-08-01", 1_000, "kz"), burn("2026-09-01", 1_000, "kz")],
    coverage: { us: false, kz: true },
    average: { value: 1_000, months: ["2026-07-01", "2026-08-01", "2026-09-01"], expected: ["2026-07-01", "2026-08-01", "2026-09-01"] },
    cash: {
      usd: 10_000,
      parts: [{ scope: "kz", native: 5_000_000, usd: 10_000, periodStart: "2026-09-30" }],
      missing: [],
      rate: 500,
      ratePeriodStart: "2026-09-01",
    },
    mrr: companyMrr(KZ_TILES),
    runway: { kind: "months", months: 10 },
    usFlowsReadAt: null,
    funding: { side: "subsidiary", perMonth: 500, hidden: false, gaps: [] },
  };

  test("cash, burn and MRR in tenge, each with its dollar figure under it, and the balance's source", () => {
    show(KZ, KZ_TILES, { us: [], kz: [day("2026-08-31", 5_400_000), day("2026-09-30", 5_000_000)] });
    expect(figure("Cash").getByText("₸5M")).toBeTruthy();
    expect(figure("Cash").getByText("≈ $10K")).toBeTruthy();
    expect(figure("Cash").getByText("Typed in · Sep 30")).toBeTruthy();
    // A typed month-end is set against the one before it, never against itself.
    expect(figure("Cash").getByText("−7.4%")).toBeTruthy();
    expect(figure("Cash").getByText("vs the end of Aug")).toBeTruthy();
    expect(valueOf("Net burn (from cash)")).toBe("₸500K / mo");
    expect(figure("Net burn (from cash)").getByText("≈ $1,000 / mo")).toBeTruthy();
    // Startup's funding is Mercury's figure: what it sent is taken out, in tenge.
    expect(figure("Net burn (from cash)").getByText("Typed-in month-end balances and Mercury")).toBeTruthy();
    expect(
      figure("Net burn (from cash)").getByText(
        "What Startup sent, ₸250K a month, is taken out as financing, not counted as income.",
      ),
    ).toBeTruthy();
    expect(figure("Runway").getByText("Without new money from Startup.")).toBeTruthy();
    expect(figure("MRR").getByText("₸5M")).toBeTruthy();
    expect(figure("MRR").getByText("CFO workbook · Sep 2026")).toBeTruthy();
  });

  test("no seed-stage band on Kazakhstan's own MRR", () => {
    show(KZ, KZ_TILES, { us: [], kz: [] });
    expect(figure("MRR").queryByText(/typical for seed/i)).toBeNull();
  });
});
