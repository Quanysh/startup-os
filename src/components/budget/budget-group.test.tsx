// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { addMonths } from "@convex/lib/costs";
import { AREAS, type Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { BudgetGroup } from "./budget-group";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

afterEach(cleanup);

// Made-up figures: Startup's cloud line is $3,000 a month, Globex's office
// ₸1,000,000 a month; nobody is on either payroll.
const months = Array.from({ length: 18 }, (_, i) => addMonths("2026-04", i));
const line = (category: string, amount: number, currency: "USD" | "KZT") => ({
  id: category,
  name: "Example line",
  category,
  amount,
  currency,
  cadence: "monthly",
  startsOn: "2026-01",
  endsOn: null,
  variable: false,
  archivedAt: null,
});
const scorecard = (rate: number | null) => ({
  tiles:
    rate === null
      ? []
      : [
          {
            key: "fx_usd_kzt",
            scope: "company",
            firstPeriodStart: "2026-09-01",
            latest: { periodStart: "2026-09-01", value: rate, currency: null, source: "cfo_workbook", syncedAt: 0 },
            series: [{ periodStart: "2026-09-01", value: rate }],
          },
        ],
  sources: {},
});

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQueryBy(api.budget.view, (args) => {
    const company = (args as { company: "us" | "kz" }).company;
    return { company, currency: company === "us" ? "USD" : "KZT", months, payroll: "shown", costs: "shown", cells: [], actuals: [] };
  });
  convex.setQuery(api.scenarios.list, []);
  convex.setQuery(api.metrics.series, []);
  convex.setQuery(api.costs.summary, { currencies: [] });
  convex.setQueryBy(api.costs.list, (args) =>
    (args as { company: string }).company === "us" ? [line("cloud", 3_000_00, "USD")] : [line("office", 1_000_000_00, "KZT")],
  );
  convex.setQuery(api.payroll.listPeople, []);
  convex.setQuery(api.payroll.listLines, []);
  convex.setQuery(api.payroll.listRuns, []);
});

const show = (areas: readonly Area[] = AREAS) =>
  render(
    <ViewerProvider viewer={{ role: "cofounder", companies: ["us", "kz"], areas, email: null, name: null }}>
      <BudgetGroup currentMonth="2026-10" />
    </ViewerProvider>,
  );

test("each company's month in its own currency, and the group's in dollars at the stored rate", () => {
  convex.setQuery(api.metrics.scorecard, scorecard(500));
  show();
  const october = within(screen.getByRole("row", { name: /Oct 2026/ }));
  expect(october.getByText("$3,000.00")).toBeTruthy();
  expect(october.getByText("₸1,000,000")).toBeTruthy();
  // 3,000 + 1,000,000 / 500
  expect(october.getByText("$5,000.00")).toBeTruthy();
  expect(within(screen.getByRole("row", { name: /12 months/ })).getByText("$60,000.00")).toBeTruthy();
});

test("with no rate on record the group's is 'Not known yet', and each company's own stands", () => {
  convex.setQuery(api.metrics.scorecard, scorecard(null));
  show();
  const october = within(screen.getByRole("row", { name: /Oct 2026/ }));
  expect(october.getByText("$3,000.00")).toBeTruthy();
  expect(october.getByText("₸1,000,000")).toBeTruthy();
  expect(october.getByText("Not known yet")).toBeTruthy();
  expect(screen.getByText(/wait for a USD\/KZT rate/)).toBeTruthy();
});

test("without Payroll the totals say they leave it out", () => {
  convex.setQuery(api.metrics.scorecard, scorecard(500));
  show(["finance", "costs"]);
  expect(screen.getByText(/^Totals exclude Payroll/)).toBeTruthy();
});

test("with neither register there is nothing to show, and it says why", () => {
  convex.setQuery(api.metrics.scorecard, scorecard(500));
  show(["finance"]);
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText(/you do not hold them/)).toBeTruthy();
});
