// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { project, projectBudget } from "@convex/lib/runway";
import { RunwayChart, type RunwaySeries } from "./runway-chart";

afterEach(cleanup);

// Made-up figures.
const of = (id: string, label: string, burn: number): RunwaySeries => {
  const p = project({ startMonth: "2026-10", currency: "USD", cash: 100_000_00, netBurn: burn, changes: [], fxUsdKzt: null });
  if (p.kind !== "projected") throw new Error(p.kind);
  return { id, label, months: p.months, runOut: p.runOut };
};

test("a legend that names each line and when it runs out, and the same figures as a table", () => {
  render(<RunwayChart currency="USD" series={[of("base", "Today", 30_000_00), of("s1", "Example hire", 1_000_00)]} />);
  expect(screen.getByText("Runs out in Jan 2027")).toBeTruthy();
  expect(screen.getByText("Lasts beyond 24 months")).toBeTruthy();
  // The table is there for a screen reader while the chart shows, and shown on request.
  expect(screen.getByRole("table", { name: "Month-end cash in USD" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByText("$70,000.00").length).toBeGreaterThan(0);
});

test("the table downloads once it is shown, never while it is there for a screen reader alone", () => {
  render(<RunwayChart currency="USD" series={[of("base", "Today", 30_000_00)]} />);
  expect(screen.queryByRole("button", { name: /as CSV$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Table" }));
  expect(screen.getByRole("button", { name: "Download Month-end cash in USD as CSV" })).toBeTruthy();
});

test("the budget line reaches as far as the budget: it lasts past its last month, and its table stops there", () => {
  const p = projectBudget({
    startMonth: "2026-10",
    currency: "USD",
    cash: 100_000_00,
    netBurn: 30_000_00,
    spend: 30_000_00,
    budget: Array.from({ length: 12 }, () => 1_000_00),
  });
  if (p.kind !== "projected") throw new Error(p.kind);
  render(
    <RunwayChart
      currency="USD"
      series={[of("base", "Today", 30_000_00)]}
      reference={{ id: "on-budget", label: "On budget", months: p.months, runOut: p.runOut }}
    />,
  );
  expect(screen.getByText("Lasts past Sep 2027")).toBeTruthy();
  const table = screen.getByRole("table", { name: "Month-end cash in USD" });
  const past = within(table).getByRole("row", { name: /Oct 2027/ });
  expect(within(past).getByText("—")).toBeTruthy();
});
