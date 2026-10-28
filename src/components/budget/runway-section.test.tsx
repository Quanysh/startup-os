// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { projectBudget } from "@convex/lib/runway";
import { mockConvex } from "@/test-support/convex";
import { RunwaySection } from "./runway-section";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

beforeEach(() => {
  mockConvex();
});
afterEach(cleanup);

// Made-up: $100K of cash, $30K a month of burn, a budget of $20K a month.
const projection = projectBudget({
  startMonth: "2026-10",
  currency: "USD",
  cash: 100_000_00,
  netBurn: 30_000_00,
  spend: 30_000_00,
  budget: Array.from({ length: 12 }, () => 20_000_00),
});
const section = (leftOut: ("payroll" | "costs")[]) =>
  render(
    <RunwaySection
      company="us"
      currency="USD"
      currentMonth="2026-10"
      start={{ cash: 100_000_00, netBurn: 30_000_00 }}
      fx={null}
      scenarios={[]}
      payrollLines={null}
      onBudget={{ projection, leftOut }}
    />,
  );

test("a whole budget is drawn as On budget, beside the line as things are", () => {
  section([]);
  // In the legend, and as a column of the table.
  expect(screen.getAllByText("On budget").length).toBeGreaterThan(0);
  expect(screen.getAllByText("As things are").length).toBeGreaterThan(0);
});

test("a budget that leaves a register out is never drawn, even with a projection to hand", () => {
  section(["payroll"]);
  expect(screen.queryAllByText("On budget")).toEqual([]);
  expect(
    screen.getByText("On budget is not drawn: the budget leaves out Payroll, so it would flatter the runway."),
  ).toBeTruthy();
});
