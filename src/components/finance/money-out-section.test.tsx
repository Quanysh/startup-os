// @vitest-environment jsdom
// Where the money goes, for each kind of viewer. Payroll and Costs are
// sensitive pages: their figures appear only to a viewer who holds them, and
// a viewer who does not sends no query for them and is told where they are.
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { CostLine } from "@convex/lib/costs";
import type { CurrencyTotals } from "@convex/lib/payroll";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";
import { GroupMoneyOutSection, MoneyOutSection } from "./money-out-section";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const NOW = Date.UTC(2026, 9, 12, 12);
const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const tile = (key: string, scope: string, points: [string, number][]): Tile => ({
  key,
  scope,
  firstPeriodStart: points[0]?.[0] ?? null,
  latest: points.length
    ? { value: points.at(-1)![1], periodStart: points.at(-1)![0], currency: null, source: "mercury", syncedAt: NOW }
    : null,
  series: points.map(([periodStart, value]) => ({ periodStart, value })),
});
const monthly = (value: number): [string, number][] => MONTHS.map((m) => [`${m}-01`, value]);
/** What Startup sent Globex each month, as Mercury's run counted it. */
const sentTile = (points: [string, number][]) => tile("cash_to_subsidiary", "us", points);
// $40,000 out a month; $30,000 in; nothing sent to Globex.
const US_TILES = [tile("cash_out", "us", monthly(40_000)), tile("cash_in", "us", monthly(30_000)), sentTile(monthly(0))];
const MERCURY_OK: SourceStates = { mercury: { state: "ok", lastRunAt: NOW, lastOkAt: NOW, message: null } };

// Made-up registers: $24,000 of pay a month, paid; $2,300 of cloud and $900 of software.
const totals = (currency: "USD" | "KZT", cost: number): CurrencyTotals => {
  const t = { people: 3, gross: cost, adjustment: 0, withheld: 0, net: 0, companyPaid: 0, cost, notComputed: 0 };
  return { currency, byKind: { employee: t, contractor: { ...t, people: 0 } }, overall: t };
};
const RUNS = MONTHS.map((m) => ({ month: `${m}-01`, status: "paid", paidOn: null, preparedAt: NOW, people: 3, totals: [totals("USD", 24_000_00)] }));
const line = (extra: Partial<CostLine> & { name: string }) => ({
  id: extra.name,
  category: "cloud",
  amount: 2_300_00,
  currency: "USD",
  cadence: "monthly",
  startsOn: "2025-01",
  endsOn: null,
  variable: false,
  paidBy: null,
  note: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...extra,
});
const LINES = [line({ name: "Example Cloud" }), line({ name: "Sample Tool", category: "software", amount: 900_00 })];

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.payroll.listRuns, RUNS);
  convex.setQuery(api.payroll.listPeople, []);
  convex.setQuery(api.payroll.listLines, []);
  convex.setQuery(api.costs.list, LINES);
});
afterEach(cleanup);

const show = (
  areas: Area[],
  company: "us" | "kz" = "us",
  tiles: Tile[] = US_TILES,
  sources: SourceStates = MERCURY_OK,
  companies: ("us" | "kz")[] = ["us", "kz"],
) =>
  render(
    <ViewerProvider viewer={{ role: "cofounder", companies, areas, email: null, name: null }}>
      <MoneyOutSection company={company} currentMonth="2026-10" card={{ tiles, sources }} />
    </ViewerProvider>,
  );
const panel = () => within(screen.getByRole("region", { name: "Sep 2026" }));
/** Each figure of the month panel: its label, its value, and what it says. */
const figure = (label: string) => {
  const term = panel().getByText(label, { selector: "dt" });
  return term.parentElement!.parentElement!.textContent;
};
const asked = () =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([, args]) => args !== "skip")
    .map(([ref]) => getFunctionName(ref as never));

describe("for a viewer with Payroll and Costs", () => {
  test("money out, pay, the register, and what neither register holds", () => {
    show(["finance", "payroll", "costs"]);
    expect(figure("Money out")).toContain("$40K");
    expect(figure("Payroll")).toContain("$24K");
    expect(figure("Payroll")).toContain("Paid: the month's total cost");
    expect(figure("Costs in the register")).toContain("$3,200");
    // By category is All costs': linked to, not repeated.
    expect(panel().queryByRole("list", { name: /Costs by category/ })).toBeNull();
    expect(panel().getByRole("link", { name: "Costs by category" }).getAttribute("href")).toBe("#all-costs");
    // 40,000 - 24,000 - 3,200 = 12,800: 32% of money out.
    expect(figure("Not in the registers")).toContain("$12.8K");
    expect(figure("Not in the registers")).toContain("32% of money out");
  });

  test("each month is one pile: pay, the register, the rest; money in is a line over them", () => {
    show(["finance", "payroll", "costs"]);
    const chart = within(screen.getByRole("group", { name: "Money out by month" }));
    expect(
      chart.getByRole("img", {
        name: "Sep 2026: money in $30K, money out $40K, payroll $24K, costs in the register $3,200, not in the registers $12.8K",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Legend" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Payroll", "Costs in the register", "Not in the registers", "Money in, before financing"]);
  });

  test("the registers holding more than went out is said, and nothing negative is drawn", () => {
    show(["finance", "payroll", "costs"], "us", [
      tile("cash_out", "us", monthly(25_000)),
      tile("cash_in", "us", monthly(30_000)),
      sentTile(monthly(0)),
    ]);
    expect(figure("Not in the registers")).toContain("The registers hold $2,200 more than went out");
    expect(screen.queryByText(/−/)).toBeNull();
    expect(document.querySelector('[data-series="rest"]')).toBeNull();
  });

  test("a month Mercury has not read to its end has no money out, and no remainder", () => {
    // Last read on September 20: September holds twenty days.
    const lastOkAt = Date.UTC(2026, 8, 20, 6);
    show(["finance", "payroll", "costs"], "us", US_TILES, { mercury: { state: "ok", lastRunAt: lastOkAt, lastOkAt, message: null } });
    // The chart draws the months that are whole; the panel is the latest of them.
    expect(screen.getByRole("region", { name: "Aug 2026" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Sep 2026/ })).toBeNull();
  });
});

describe("for a viewer with Finance alone (access must not widen)", () => {
  test("no Payroll or Costs figure, the pages named instead, and nothing worked out around them", () => {
    show(["finance"]);
    expect(figure("Payroll")).toContain("On the Payroll page.");
    expect(figure("Costs in the register")).toContain("On the Costs page.");
    expect(figure("Not in the registers")).toContain("Not worked out: pay is on the Payroll page");
    const all = document.body.textContent ?? "";
    for (const amount of ["$24K", "$3,200", "$2,300", "$12.8K"]) expect(all).not.toContain(amount);
    expect(screen.queryByRole("link", { name: "Costs by category" })).toBeNull();
    expect(document.querySelector('[data-series="payroll"], [data-series="costs"], [data-series="rest"]')).toBeNull();
  });

  test("sends no Payroll or Costs query at all", () => {
    show(["finance"]);
    expect(asked().filter((name) => name.startsWith("payroll:") || name.startsWith("costs:"))).toEqual([]);
  });

  test("the chart is money out whole, beside money in", () => {
    show(["finance"]);
    expect(
      within(screen.getByRole("list", { name: "Legend" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Money out", "Money in, before financing"]);
    expect(screen.getByRole("img", { name: "Sep 2026: money in $30K, money out $40K" })).toBeTruthy();
  });
});

describe("for a viewer with one of the two", () => {
  test("Costs without Payroll: the register's figures, pay named, no remainder", () => {
    show(["finance", "costs"]);
    expect(figure("Costs in the register")).toContain("$3,200");
    expect(figure("Payroll")).toContain("On the Payroll page.");
    expect(figure("Not in the registers")).toContain("Not worked out");
    expect(document.body.textContent).not.toContain("$24K");
    expect(asked().filter((name) => name.startsWith("payroll:"))).toEqual([]);
  });

  test("Payroll without Costs: pay's figure, the register named, no remainder", () => {
    show(["finance", "payroll"]);
    expect(figure("Payroll")).toContain("$24K");
    expect(figure("Costs in the register")).toContain("On the Costs page.");
    expect(figure("Not in the registers")).toContain("Not worked out: the cost register is on the Costs page");
    expect(document.body.textContent).not.toContain("$3,200");
    expect(asked().filter((name) => name.startsWith("costs:"))).toEqual([]);
  });
});

describe("Globex", () => {
  const view = (actuals: { month: string; amount: number }[]) => ({
    company: "kz",
    currency: "KZT",
    months: MONTHS,
    payroll: "shown",
    cells: [],
    actuals,
  });
  const KZ_TILES = [tile("fx_usd_kzt", "company", [["2026-09-01", 450]])];

  test("money out is the spend typed on the Budget tab, in tenge, with dollars beside it", () => {
    convex.setQuery(api.budget.view, view(MONTHS.map((month) => ({ month, amount: 9_000_000_00 }))));
    convex.setQuery(api.payroll.listRuns, MONTHS.map((m) => ({ ...RUNS[0]!, month: `${m}-01`, totals: [totals("KZT", 4_500_000_00)] })));
    convex.setQuery(api.costs.list, [line({ name: "Example Office", category: "office", amount: 1_350_000_00, currency: "KZT" })]);
    show(["finance", "payroll", "costs"], "kz", KZ_TILES);
    expect(figure("Money out")).toContain("₸9M");
    expect(figure("Money out")).toContain("≈ $20K");
    expect(figure("Money out")).toContain("Typed in on the Budget tab");
    // 9M - 4.5M - 1.35M = 3.15M tenge: 35%.
    expect(figure("Not in the registers")).toContain("₸3.2M");
    expect(figure("Not in the registers")).toContain("35% of money out");
    // No Mercury here: no money-in line, no financing note.
    expect(screen.queryByText("Money in, before financing")).toBeNull();
    expect(screen.queryByText(/Financing is left out/)).toBeNull();
  });

  test("a month with no spend typed says so, with the way to the Budget tab", () => {
    convex.setQuery(api.budget.view, view([]));
    show(["finance", "payroll", "costs"], "kz", KZ_TILES);
    const notice = screen.getByRole("status", { name: "No chart yet" });
    expect(notice.textContent).toContain("Type Globex's actual spend on the Budget tab: the chart needs 3 months, there are none yet.");
    // No empty chart column beside the month: the month sits under the notice.
    expect(notice.closest("[data-layout]")!.getAttribute("data-layout")).toBe("no-chart");
    expect(figure("Money out")).toContain("Not known yet: no actual spend is typed for Sep 2026.");
    expect(panel().getByRole("link", { name: "Open the Budget tab" }).getAttribute("href")).toBe("/finance/plan");
  });
});

describe("what Startup sent Globex, its subsidiary", () => {
  // $10,000 of each month's $40,000 went to Globex.
  const FUNDED = [...US_TILES.filter((t) => t.key !== "cash_to_subsidiary"), sentTile(monthly(10_000))];
  const chart = () => within(screen.getByRole("group", { name: "Money out by month" }));

  test("is a part of Startup's money out of its own, never in what the registers leave", () => {
    show(["finance", "payroll", "costs"], "us", FUNDED);
    expect(figure("Money out")).toContain("$40K");
    expect(figure("Sent to Globex")).toContain("$10K");
    expect(figure("Sent to Globex")).toContain("From Mercury: Startup's payments to its subsidiary.");
    // 40,000 - 24,000 - 3,200 - 10,000 = 2,800: 7% of money out.
    expect(figure("Not in the registers")).toContain("$2,800");
    expect(figure("Not in the registers")).toContain("7% of money out");
    expect(figure("Not in the registers")).toContain("what went to the subsidiary");
  });

  test("each pile has it on top, in its own colour, and the legend and words name it", () => {
    show(["finance", "payroll", "costs"], "us", FUNDED);
    expect(
      chart().getByRole("img", {
        name: "Sep 2026: money in $30K, money out $40K, payroll $24K, costs in the register $3,200, not in the registers $2,800, sent to Globex $10K",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Legend" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Payroll", "Costs in the register", "Not in the registers", "Sent to Globex", "Money in, before financing"]);
    const pile = document.querySelector('[aria-current="true"] [data-pile]')!;
    expect(Array.from(pile.querySelectorAll("[data-series]"), (s) => s.getAttribute("data-series"))).toEqual([
      "payroll",
      "costs",
      "rest",
      "sent",
    ]);
    expect((pile.querySelector('[data-series="sent"]') as HTMLElement).style.backgroundColor).toBe("var(--chart-3)");
  });

  test("a month read before it was counted: that part, and so the rest, are not known, never zero", () => {
    // Counted from April to August; September's figures were read before.
    show(["finance", "payroll", "costs"], "us", [
      ...US_TILES.filter((t) => t.key !== "cash_to_subsidiary"),
      sentTile(MONTHS.slice(0, 5).map((m) => [`${m}-01`, 10_000])),
    ]);
    expect(figure("Money out")).toContain("$40K");
    expect(figure("Sent to Globex")).toContain(
      "Not known yet: Mercury read Sep 2026 before payments to the subsidiary were counted on their own. A Mercury backfill fills it in.",
    );
    expect(figure("Not in the registers")).toContain(
      "Not worked out while what Startup sent its subsidiary that month is not known.",
    );
    for (const amount of ["$12.8K", "$2,800"]) expect(figure("Not in the registers")).not.toContain(amount);
    // September cannot be broken down: one pile of money out, nothing more said of it.
    expect(chart().getByRole("img", { name: "Sep 2026: money in $30K, money out $40K" })).toBeTruthy();
    expect(document.querySelector('[aria-current="true"] [data-series="unbroken"]')).not.toBeNull();
  });

  test("with no month counted at all, none is a zero", () => {
    show(["finance", "payroll", "costs"], "us", US_TILES.filter((t) => t.key !== "cash_to_subsidiary"));
    expect(figure("Sent to Globex")).toContain("Not known yet");
    expect(figure("Not in the registers")).toContain("Not worked out");
    expect(document.querySelector('[data-series="rest"], [data-series="sent"]')).toBeNull();
  });

  test("a viewer with Finance alone sees it: it is Mercury's figure, not a register's", () => {
    show(["finance"], "us", FUNDED);
    expect(figure("Sent to Globex")).toContain("$10K");
    expect(figure("Not in the registers")).toContain("Not worked out: pay is on the Payroll page");
    // Without the registers the chart is money out whole, as before.
    expect(screen.getByRole("img", { name: "Sep 2026: money in $30K, money out $40K" })).toBeTruthy();
  });

  test("a viewer on Startup alone is never told the other company's name", () => {
    show(["finance", "payroll", "costs"], "us", FUNDED, MERCURY_OK, ["us"]);
    expect(figure("Sent to the subsidiary")).toContain("$10K");
    expect(screen.getByRole("list", { name: "Legend" }).textContent).toContain("Sent to the subsidiary");
    expect(screen.getByRole("region", { name: "Where the money goes" }).textContent).not.toMatch(/Globex|Globex/);
  });

  test("Globex's own lens has no such part", () => {
    convex.setQuery(api.budget.view, {
      company: "kz",
      currency: "KZT",
      months: MONTHS,
      payroll: "shown",
      cells: [],
      actuals: MONTHS.map((month) => ({ month, amount: 9_000_000_00 })),
    });
    show(["finance", "payroll", "costs"], "kz", [tile("fx_usd_kzt", "company", [["2026-09-01", 450]]), ...FUNDED]);
    expect(panel().queryByText(/^Sent to/)).toBeNull();
  });
});

describe("the group", () => {
  const FX = tile("fx_usd_kzt", "company", [["2026-09-01", 500]]);
  // Startup sent Globex $30,000 of each month's $40,000; Globex typed ₸9M ($18,000) of spend.
  const FUNDED = [...US_TILES.filter((t) => t.key !== "cash_to_subsidiary"), sentTile(monthly(30_000)), FX];
  const showGroup = (tiles: Tile[]) => {
    convex.setQueryBy(api.budget.view, () => ({
      company: "kz",
      currency: "KZT",
      months: MONTHS,
      payroll: "shown",
      cells: [],
      actuals: MONTHS.map((month) => ({ month, amount: 9_000_000_00 })),
    }));
    return render(
      <ViewerProvider viewer={{ role: "cofounder", companies: ["us", "kz"], areas: ["finance"], email: null, name: null }}>
        <GroupMoneyOutSection currentMonth="2026-10" card={{ tiles, sources: MERCURY_OK }} />
      </ViewerProvider>,
    );
  };

  test("Startup's part leaves out what it sent Globex, and one line says why", () => {
    showGroup(FUNDED);
    // $10,000 of Startup's own and $18,000 of Globex's: $28K, not $58K.
    expect(figure("Money out")).toContain("$28K");
    expect(figure("Money out")).toContain("Startup $10K ($30K sent to Globex left out), Globex ₸9M. Tenge at ₸500 per $1.");
    expect(
      screen.getByText(
        "Startup's money out here leaves out what it sent Globex (Globex LLP, its subsidiary): that is Globex's money, and what Globex spent of it is in Globex's money out already.",
      ),
    ).toBeTruthy();
    expect(panel().queryByText(/^Sent to/, { selector: "dt" })).toBeNull();
  });

  test("a month with Startup's money out but not what it sent: Startup's part is not known, and the row says why", () => {
    // Every month read before what Startup sent was counted: no group month is known.
    showGroup([...US_TILES.filter((t) => t.key !== "cash_to_subsidiary"), FX]);
    expect(screen.getByRole("status", { name: "No chart yet" }).textContent).toContain(
      "A group month needs both companies' money out, what Startup sent Globex and a USD/KZT rate: the chart needs 3 such months, there are none yet.",
    );
    expect(figure("Money out")).toContain(
      "Not known yet: Mercury read Startup's Sep 2026 before what it sent Globex was counted on its own. Startup not known, Globex ₸9M.",
    );
    // Never Startup's whole money out in its place: not $58K, not $40K.
    expect(figure("Money out")).not.toMatch(/\$58K|\$40K/);
  });

  test("the months it was counted for are drawn; one it was not is left off the chart", () => {
    showGroup([
      ...US_TILES.filter((t) => t.key !== "cash_to_subsidiary"),
      sentTile(MONTHS.slice(0, 5).map((m) => [`${m}-01`, 30_000])),
      FX,
    ]);
    expect(screen.getByRole("img", { name: "Aug 2026: money out $28K" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Sep 2026/ })).toBeNull();
  });
});

describe("financing", () => {
  test("is left out of money in, said with what and when, and the way to record it", () => {
    show(["finance", "settings"], "us", [
      ...US_TILES,
      tile("financing_in", "us", [["2026-03-01", 900_000], ["2026-08-01", 500_000]]),
    ]);
    expect(screen.getByText(/Financing is left out/).textContent).toBe(
      'Financing is left out of "Money in": $500K in Aug 2026. Record financing received when investor money arrives, so it is not counted as income. Outside money only: a transfer between Startup\'s own entities is not financing.',
    );
  });
});
