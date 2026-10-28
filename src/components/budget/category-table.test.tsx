// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { categoryVsRunRate, effectiveBudget } from "@convex/lib/budget";
import { CategoryTable } from "./category-table";

afterEach(cleanup);

test("a category's budget against its run-rate, labelled as run-rate, not spending", () => {
  const cells = effectiveBudget(["2026-10"], [{ month: "2026-10", category: "cloud", amount: 100_00 }], () => ({
    kind: "known",
    amount: 0,
  }));
  const rows = categoryVsRunRate("2026-10", cells, { cloud: 120_00, office: null });
  render(<CategoryTable rows={rows} currency="USD" monthName="Oct 2026" />);
  expect(screen.getByText("Over by $20.00 (+20%)")).toBeTruthy();
  expect(screen.getAllByText("Not known yet").length).toBeGreaterThan(0);
  expect(screen.getByText(/not what was spent/)).toBeTruthy();
});

test("without Costs, where it is", () => {
  render(<CategoryTable rows={null} currency="USD" monthName="Oct 2026" />);
  expect(screen.getByText(/on the Costs page, which you do not hold/)).toBeTruthy();
});
