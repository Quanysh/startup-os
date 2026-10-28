// @vitest-environment jsdom
// The four summary tiles in one company's view: every sentence is about the
// market in view, and none asks for the other company's figures. The
// both-markets wording is in summary-tiles.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CompanyId } from "@convex/lib/company";
import { AREAS } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { FinanceSummary } from "@/lib/metrics/finance";
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
const shared = {
  currentMonth: "2026-10-01",
  burn: [],
  mrr: null,
  runway: { kind: "months" as const, months: 20 },
  burnMultiple: { kind: "value" as const, value: 2, months: 6, from: "2026-04-01", to: "2026-09-01" },
  lateCloses: [],
  financingProblems: [],
  unfinishedUsMonths: [],
  kzClosedMonths: [],
};
// As financeSummary builds them: the market not in view is never covered.
const usBase: FinanceSummary = {
  ...shared,
  markets: ["us"],
  coverage: { us: true, kz: false },
  average: { value: 20_000, months: EXPECTED, expected: EXPECTED },
  cash: { usd: 400_000, rate: null, ratePeriodStart: null, missing: [], parts: [US] },
  usFlowsReadAt: Date.UTC(2026, 9, 12, 6),
  funding: { side: "parent", perMonth: 0 },
};
const kzBase: FinanceSummary = {
  ...shared,
  markets: ["kz"],
  coverage: { us: false, kz: true },
  average: { value: 1_000, months: EXPECTED, expected: EXPECTED },
  cash: { usd: 10_000, rate: 500, ratePeriodStart: "2026-09-01", missing: [], parts: [KZ] },
  runway: { kind: "months", months: 10 },
  kzClosedMonths: ["2026-06-01", ...EXPECTED],
  usFlowsReadAt: null,
  funding: { side: "subsidiary", perMonth: 0, hidden: false, gaps: [] },
};
const show = (summary: FinanceSummary) => render(<FourTiles summary={summary} now={NOW} />);
/** The tiles for a viewer on these companies alone (`show` is a viewer on both). */
const showFor = (companies: CompanyId[], summary: FinanceSummary) =>
  render(
    <ViewerProvider viewer={{ role: "cofounder", companies, areas: AREAS, email: null, name: null }}>
      <FourTiles summary={summary} now={NOW} />
    </ViewerProvider>,
  );
const tile = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);
const lines = (label: string) =>
  Array.from(
    screen.getByRole("heading", { name: label }).closest("article")!.querySelectorAll("p"),
    (p) => p.textContent,
  );
const everything = () => document.body.textContent ?? "";

// What a US view must never say, and a Kazakhstan view must never say; to a
// viewer on that company alone, nor the other company's name.
const KZ_WORDS = /Kazakhstan|KZT|₸|CFO workbook|every market|both markets/;
const US_WORDS = /\bUS\b|Mercury|every market|both markets/;
const NAMES = { us: /Startup/, kz: /Globex/ };

describe("the US alone", () => {
  test("cash is the US balance: no conversion line and nothing about Kazakhstan", () => {
    show(usBase);
    expect(lines("Cash")).toEqual(["$400K", "US $400K · Oct 12"]);
    expect(tile("Cash").queryByText("partial")).toBeNull();
  });

  test("with no US balance, it says only where the US balance comes from", () => {
    show({ ...usBase, cash: null, runway: null });
    expect(lines("Cash")).toEqual(["No value yet", "No US balance yet. It arrives with Mercury."]);
  });

  test("net burn is given from Mercury alone", () => {
    show(usBase);
    expect(lines("Net burn")).toEqual(["$20K / mo", "Average of Jul–Sep 2026."]);
  });

  test("it is the bank's figure, and says how much of it went to Globex", () => {
    show({ ...usBase, funding: { side: "parent", perMonth: 12_500 } });
    expect(lines("Net burn")).toEqual([
      "$20K / mo",
      "Average of Jul–Sep 2026.",
      "Includes $12.5K a month sent to Globex.",
    ]);
    cleanup();
    // A month of the average with no figure of it: that it is in, not how much.
    show({ ...usBase, funding: { side: "parent", perMonth: null } });
    expect(lines("Net burn")).toContain("Includes what Startup sent Globex.");
  });

  test("a viewer on Startup alone reads of the subsidiary, never its name", () => {
    showFor(["us"], { ...usBase, funding: { side: "parent", perMonth: 12_500 } });
    expect(lines("Net burn")).toContain("Includes $12.5K a month sent to the subsidiary.");
    expect(everything()).not.toMatch(NAMES.kz);
  });

  test.each([
    [null, "Arrives with Mercury's first sync."],
    [Date.UTC(2026, 9, 12, 6), "Needs a month Mercury has read to its end."],
  ])("before Mercury has a whole month (last read: %s) it says so", (usFlowsReadAt, reason) => {
    show({
      ...usBase,
      coverage: { us: false, kz: false },
      average: null,
      runway: null,
      burnMultiple: null,
      usFlowsReadAt,
    });
    expect(lines("Net burn")).toEqual(["No value yet", reason]);
    expect(lines("Runway")).toEqual(["No value yet", "Needs net burn first."]);
    expect(lines("Burn multiple")).toEqual(["No value yet", "Needs net burn and MRR."]);
    expect(everything()).not.toMatch(KZ_WORDS);
  });

  test("an uncovered Kazakhstan is not why anything is withheld", () => {
    // coverage.kz is false in every US view; the tile must not read it.
    show(usBase);
    expect(tile("Net burn").queryByText(/US only so far/)).toBeNull();
    expect(everything()).not.toMatch(KZ_WORDS);
  });

  test("runway withheld for cash asks for a balance, not for every market's", () => {
    show({ ...usBase, cash: null, runway: null });
    expect(lines("Runway")).toEqual(["No value yet", "Needs a cash balance first."]);
  });

  test("not burning: the financing to record is the US's", () => {
    show({ ...usBase, average: { ...usBase.average!, value: -500 }, runway: { kind: "not_burning" } });
    expect(tile("Net burn").getByRole("link", { name: "financing received" }).getAttribute("href")).toBe(
      "/finance?metric=financing_in&scope=us#record-a-figure",
    );
  });

  test("no state of the four tiles names Kazakhstan, the rate or the workbook", () => {
    const states: Partial<FinanceSummary>[] = [
      {},
      { cash: null, runway: null },
      { coverage: { us: false, kz: false }, average: null, runway: null, burnMultiple: null },
      { average: null, runway: null, burnMultiple: null },
      { average: { ...usBase.average!, months: ["2026-09-01"] } },
      { average: { ...usBase.average!, value: 0 }, runway: { kind: "not_burning" } },
      { unfinishedUsMonths: ["2026-09-01"], financingProblems: ["2026-08-01"] },
      { burnMultiple: { kind: "none", reason: "last_month_incomplete" } },
      { burnMultiple: { kind: "none", reason: "too_little_history" } },
      { burnMultiple: null },
    ];
    for (const patch of states) {
      show({ ...usBase, ...patch });
      expect(everything()).not.toMatch(KZ_WORDS);
      cleanup();
      // A viewer on Startup alone, with money sent to the subsidiary: never its name.
      showFor(["us"], { ...usBase, funding: { side: "parent", perMonth: 12_500 }, ...patch });
      expect(everything()).not.toMatch(KZ_WORDS);
      expect(everything()).not.toMatch(NAMES.kz);
      cleanup();
    }
  });
});

describe("Kazakhstan alone", () => {
  test("cash is Kazakhstan's balance in dollars, with the rate it was converted at", () => {
    show(kzBase);
    expect(lines("Cash")).toEqual([
      "$10K",
      "Kazakhstan ₸5M · Sep 30",
      "Converted at ₸500 per $1, the Sep 2026 rate.",
    ]);
    expect(tile("Cash").queryByText("partial")).toBeNull();
  });

  test("with no balance, it offers the form and says nothing of Mercury", () => {
    show({ ...kzBase, cash: null, runway: null });
    expect(lines("Cash")).toEqual([
      "No value yet",
      "No Kazakhstan balance yet. Enter Kazakhstan's balance",
    ]);
    expect(
      tile("Cash").getByRole("link", { name: "Enter Kazakhstan's balance" }).getAttribute("href"),
    ).toBe("/finance?metric=cash&scope=kz#record-a-figure");
  });

  test("a balance with no rate is not zero dollars, and is not 'left out' of anything", () => {
    show({
      ...kzBase,
      cash: { usd: 0, rate: null, ratePeriodStart: null, missing: ["fx"], parts: [] },
      runway: null,
    });
    expect(lines("Cash")).toEqual([
      "No value yet",
      "There is no dollar figure until a USD/KZT rate arrives with the CFO workbook.",
    ]);
  });

  test("net burn is from the month-end balances, Startup's funding taken out, and says it is not the actual spend", () => {
    show(kzBase);
    expect(screen.queryByRole("heading", { name: "Net burn" })).toBeNull();
    expect(lines("Net burn (from cash)")).toEqual([
      "$1,000 / mo",
      "Average of Jul–Sep 2026.",
      "What Startup sends is taken out as financing, not counted as income.",
      "Money out less money in, from month-end balances: not Globex's actual spend, which is typed in on the Budget tab.",
    ]);
    expect(tile("Net burn (from cash)").getByRole("link", { name: "Budget tab" }).getAttribute("href")).toBe(
      "/finance/plan",
    );
  });

  test("how much Startup sent over those months is said: financing, never income", () => {
    show({ ...kzBase, funding: { side: "subsidiary", perMonth: 2_000, hidden: false, gaps: [] } });
    expect(lines("Net burn (from cash)")).toContain(
      "What Startup sent, $2,000 a month, is taken out as financing, not counted as income.",
    );
  });

  test("runway is how long Globex's cash lasts without new money from Startup", () => {
    show(kzBase);
    expect(lines("Runway")).toContain("Without new money from Startup.");
  });

  test("a month waiting for what Startup sent says so, and is left out", () => {
    show({
      ...kzBase,
      average: { ...kzBase.average!, months: ["2026-07-01", "2026-09-01"] },
      funding: { side: "subsidiary", perMonth: 0, hidden: false, gaps: [{ month: "2026-08-01", lacks: "sent" }] },
    });
    expect(lines("Net burn (from cash)")).toContain("Aug 2026 is missing Mercury's figure for what Startup sent Globex.");
  });

  test("a viewer on Globex alone, never sent what Startup sent: no burn, no runway, and Startup never named", () => {
    showFor(["kz"], {
      ...kzBase,
      average: null,
      runway: null,
      burnMultiple: null,
      funding: { side: "subsidiary", perMonth: null, hidden: true, gaps: [] },
    });
    expect(lines("Net burn (from cash)")).toEqual([
      "No value yet",
      "Worked out with what Globex receives from the parent company, which is not yours to see.",
    ]);
    expect(lines("Runway")).toEqual(["No value yet", "Needs net burn first."]);
    expect(everything()).not.toMatch(US_WORDS);
  });

  test("an uncovered US is not why anything is withheld", () => {
    // coverage.us is false in every Kazakhstan view; the tile must not read it.
    show(kzBase);
    expect(tile("Net burn (from cash)").queryByText(/US only so far/)).toBeNull();
    expect(tile("Net burn (from cash)").queryByText(/Mercury/)).toBeNull();
  });

  test("before two month-ends are in, it asks for them and does not mention the US", () => {
    show({
      ...kzBase,
      coverage: { us: false, kz: false },
      average: null,
      runway: null,
      burnMultiple: null,
    });
    expect(lines("Net burn (from cash)")).toEqual([
      "No value yet",
      "Needs Kazakhstan's bank balance at two month-ends in a row. Enter Kazakhstan's balance",
    ]);
    expect(
      tile("Net burn (from cash)").getByRole("link", { name: "Enter Kazakhstan's balance" }).getAttribute("href"),
    ).toBe("/finance?metric=cash&scope=kz#record-a-figure");
    expect(lines("Runway")).toEqual(["No value yet", "Needs net burn first."]);
    expect(lines("Burn multiple")).toEqual(["No value yet", "Needs net burn and MRR."]);
    expect(everything()).not.toMatch(US_WORDS);
  });

  test("runway withheld for cash asks for a balance, not for every market's", () => {
    show({ ...kzBase, cash: null, runway: null });
    expect(lines("Runway")).toEqual(["No value yet", "Needs a cash balance first."]);
  });

  test("not burning: the financing to record is Kazakhstan's, and outside money only", () => {
    show({ ...kzBase, average: { ...kzBase.average!, value: -500 }, runway: { kind: "not_burning" } });
    const note = tile("Net burn (from cash)").getByRole("link", { name: "financing received" });
    expect(note.getAttribute("href")).toBe("/finance?metric=financing_in&scope=kz#record-a-figure");
    expect(note.closest("p")!.textContent).toBe(
      "If outside investor money arrived, record it as financing received, so it is not counted as income.",
    );
    // Startup's funding is never to be typed there: it is taken out already.
    expect(lines("Net burn (from cash)")).toContain(
      "What Startup sends is taken out as financing, not counted as income.",
    );
  });

  test("for a viewer on Globex alone, no state of the four tiles names the US, Mercury or Startup", () => {
    const states: Partial<FinanceSummary>[] = [
      {},
      { cash: null, runway: null },
      { cash: { usd: 0, rate: null, ratePeriodStart: null, missing: ["fx"], parts: [] }, runway: null },
      { coverage: { us: false, kz: false }, average: null, runway: null, burnMultiple: null },
      { average: null, runway: null, burnMultiple: null, kzClosedMonths: ["2026-08-01"] },
      { average: { ...kzBase.average!, months: ["2026-09-01"] }, kzClosedMonths: ["2026-08-01", "2026-09-01"] },
      { average: { ...kzBase.average!, value: 0 }, runway: { kind: "not_burning" } },
      { lateCloses: [{ month: "2026-09-01", date: "2026-10-02" }] },
      { burnMultiple: { kind: "none", reason: "last_month_incomplete" } },
      { burnMultiple: null },
      // What it always is for this viewer: never sent what Startup sent.
      { average: null, runway: null, funding: { side: "subsidiary", perMonth: null, hidden: true, gaps: [] } },
    ];
    for (const patch of states) {
      showFor(["kz"], { ...kzBase, ...patch });
      expect(everything()).not.toMatch(US_WORDS);
      expect(everything()).not.toMatch(NAMES.us);
      cleanup();
    }
  });
});
