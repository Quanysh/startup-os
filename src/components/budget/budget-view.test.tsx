// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { addMonths } from "@convex/lib/costs";
import { AREAS, type Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { BudgetView } from "./budget-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

afterEach(cleanup);

// Made-up figures. Mercury last read on Oct 2, so September is whole.
const READ_AT = Date.parse("2026-10-02T06:00:00Z");
const tile = (key: string, scope: string, series: { periodStart: string; value: number }[]) => ({
  key,
  scope,
  firstPeriodStart: series[0]?.periodStart ?? null,
  latest: series.length === 0 ? null : { ...series.at(-1)!, currency: "USD", source: "mercury", syncedAt: READ_AT },
  series,
});
// What `budget.view` sends for April 2026 on: eighteen months, the typed cells the caller may see.
const months = Array.from({ length: 18 }, (_, i) => addMonths("2026-04", i));
const typedCloud = { month: "2026-09", category: "cloud" as const, amount: 30_000_00 };
const sent = (areas: readonly Area[]) => ({
  company: "us",
  currency: "USD",
  months,
  payroll: areas.includes("payroll") ? "shown" : "hidden",
  costs: areas.includes("costs") ? "shown" : "hidden",
  cells: areas.includes("costs") ? [typedCloud] : [],
  actuals: [],
});

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  // The calls are read below, and a mock keeps those of the tests before.
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.scenarios.list, []);
  convex.setQuery(api.metrics.scorecard, {
    tiles: [
      tile("cash", "us", [{ periodStart: "2026-10-01", value: 300_000 }]),
      tile("cash_out", "us", [{ periodStart: "2026-09-01", value: 33_000 }]),
      // Of the money out, what Startup sent Globex: Globex's money.
      tile("cash_to_subsidiary", "us", [{ periodStart: "2026-09-01", value: 3_000 }]),
      tile("cash_in", "us", [{ periodStart: "2026-09-01", value: 3_000 }]),
    ],
    sources: { mercury: { state: "ok", lastRunAt: READ_AT, lastOkAt: READ_AT, message: null } },
  });
});

const view = (areas: readonly Area[]) => {
  convex.setQuery(api.budget.view, sent(areas));
  return render(
    <ViewerProvider viewer={{ role: "cofounder", companies: ["us", "kz"], areas, email: null, name: null }}>
      <BudgetView company="us" currentMonth="2026-10" />
    </ViewerProvider>,
  );
};

const asked = (name: string) =>
  vi.mocked(useQuery).mock.calls.filter(([ref, args]) => getFunctionName(ref) === name && args !== "skip");

/** The registers as the owner reads them: a cloud line and one person, made up. */
const registers = () => {
  convex.setQuery(api.costs.summary, { company: "us", month: "2026-10", months: [], lines: 1, estimates: 0, currencies: [], combined: { kind: "unknown" } });
  convex.setQuery(api.costs.list, [
    { id: "c1", name: "Example Cloud", category: "cloud", amount: 3_000_00, currency: "USD", cadence: "monthly", startsOn: "2026-01", endsOn: null, variable: false, archivedAt: null },
  ]);
  convex.setQuery(api.payroll.listPeople, [
    { id: "p1", name: "Example Person", kind: "employee", currency: "USD", monthlyGross: 27_000_00, order: 0 },
  ]);
  convex.setQuery(api.payroll.listLines, []);
  convex.setQuery(api.payroll.listRuns, []);
};

test("with Finance alone, Startup's actual is its own spending and a budget that leaves both registers out is not compared", () => {
  view(["finance"]);
  const september = screen.getByRole("row", { name: /Sep 2026/ });
  // $33,000 out, $3,000 of it sent to Globex.
  expect(within(september).getByText("$30,000.00")).toBeTruthy();
  expect(within(september).getByText("Not compared: the budget leaves out Payroll and Costs")).toBeTruthy();
  expect(
    screen.getByText(
      "Actual is Startup's own spending: Mercury's money out less what it sent Globex, which is Globex's money and in Globex's actual, for each month Mercury read whole. A month read before what was sent was counted is not known yet, and the month in progress is not an actual yet.",
    ),
  ).toBeTruthy();
});

test("a month with money out and no figure of what was sent is not known, never Mercury's whole money out", () => {
  convex.setQuery(api.metrics.scorecard, {
    tiles: [
      tile("cash", "us", [{ periodStart: "2026-10-01", value: 300_000 }]),
      tile("cash_out", "us", [{ periodStart: "2026-09-01", value: 33_000 }]),
      tile("cash_to_subsidiary", "us", []),
      tile("cash_in", "us", [{ periodStart: "2026-09-01", value: 3_000 }]),
    ],
    sources: { mercury: { state: "ok", lastRunAt: READ_AT, lastOkAt: READ_AT, message: null } },
  });
  view(["finance"]);
  const september = screen.getByRole("row", { name: /Sep 2026/ });
  expect(within(september).queryByText("$33,000.00")).toBeNull();
  expect(within(september).getAllByText("Not known yet").length).toBeGreaterThan(0);
});

test("a viewer on Startup alone reads of the subsidiary, never its name", () => {
  convex.setQuery(api.budget.view, sent(["finance"]));
  render(
    <ViewerProvider viewer={{ role: "cofounder", companies: ["us"], areas: ["finance"], email: null, name: null }}>
      <BudgetView company="us" currentMonth="2026-10" />
    </ViewerProvider>,
  );
  expect(screen.getByText(/^Actual is Startup's own spending: Mercury's money out less what it sent the subsidiary/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Globex/);
});

test("a viewer with Finance alone sends no Costs or Payroll query, and is told where they are", () => {
  view(["finance"]);
  expect(asked("costs:summary")).toEqual([]);
  expect(asked("costs:list")).toEqual([]);
  expect(asked("payroll:listPeople")).toEqual([]);
  expect(asked("payroll:listLines")).toEqual([]);
  expect(asked("payroll:listRuns")).toEqual([]);
  expect(screen.getByText(/on the Costs page, which you do not hold/)).toBeTruthy();
  expect(screen.getByText(/Payroll's and Costs' figures, which are on those pages: you do not hold them/)).toBeTruthy();
});

test("the owner's budget fills itself from Payroll and Costs; a typed cell stays typed", () => {
  registers();
  view(AREAS);
  expect(asked("costs:list").length).toBeGreaterThan(0);
  expect(asked("payroll:listRuns").length).toBeGreaterThan(0);
  const cloud = screen.getByLabelText("Cloud, Oct 2026");
  expect(cloud).toHaveProperty("value", "3000");
  expect(cloud.getAttribute("data-source")).toBe("live");
  const pay = screen.getByLabelText("Payroll, Oct 2026");
  expect(pay).toHaveProperty("value", "27000");
  expect(pay.getAttribute("data-source")).toBe("live");
  // September's cloud was typed over (30,000), so its month adds to 57,000
  // against Startup's own 30,000 (33,000 out, 3,000 of it sent to Globex).
  const september = screen.getByRole("row", { name: /Sep 2026/ });
  expect(within(september).getByText("$57,000.00")).toBeTruthy();
  expect(within(september).getByText(/Under by \$27,000\.00/)).toBeTruthy();
  // No "Fill from current": it is always current.
  expect(screen.queryByRole("button", { name: "Fill from current" })).toBeNull();
});

test("a viewer with Costs but not Payroll: the Costs rows filled, Payroll on its page, nothing compared", () => {
  registers();
  view(["finance", "costs"]);
  expect(asked("payroll:listPeople")).toEqual([]);
  expect(screen.getByLabelText("Cloud, Oct 2026")).toHaveProperty("value", "3000");
  expect(screen.queryByLabelText("Payroll, Oct 2026")).toBeNull();
  expect(screen.getByText(/^Total excludes Payroll:/)).toBeTruthy();
  const september = screen.getByRole("row", { name: /Sep 2026/ });
  expect(within(september).getByText("Not compared: the budget leaves out Payroll")).toBeTruthy();
});

test("the runway from the Finance page's figures", () => {
  view(["finance"]);
  // September is whole (burn 30,000) but August and July are not on record: the average is of September.
  expect(screen.getByText(/Runs out in/)).toBeTruthy();
});

test("the runway says which figure drives which line, and draws the budget spent month by month", () => {
  registers();
  view(AREAS);
  expect(screen.getByText(/start from today's cash and the average net burn/)).toBeTruthy();
  const lines = within(screen.getByRole("list", { name: "Lines" }));
  // $300K of cash. As things are: 30,000 a month out, gone during Aug 2027.
  expect(lines.getByText("As things are").nextElementSibling!.textContent).toBe("Runs out in Aug 2027");
  // On budget: 30,000 a month (cloud 3,000, pay 27,000), and the 3,000 a
  // month Startup has sent Globex, which the budget does not hold, less the
  // 3,000 that came in: Aug 2027. Leaving the funding out would flatter it.
  expect(lines.getByText("On budget").nextElementSibling!.textContent).toBe("Runs out in Aug 2027");
  expect(
    screen.getByText(
      "Startup's On budget keeps sending Globex what it has averaged: Startup's money pays it, and the budget does not hold it.",
    ),
  ).toBeTruthy();
});

test("a budget that leaves a register out is not drawn: it would flatter the runway", () => {
  view(["finance"]);
  expect(screen.queryByText("On budget")).toBeNull();
  expect(
    screen.getByText("On budget is not drawn: the budget leaves out Payroll and Costs, so it would flatter the runway."),
  ).toBeTruthy();
});
