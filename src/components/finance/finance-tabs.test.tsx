// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { FinanceTabs } from "./finance-tabs";

afterEach(cleanup);

test("two tabs, the page in view marked as the current one", () => {
  render(<FinanceTabs current="/finance/plan" />);
  const nav = screen.getByRole("navigation", { name: "Finance" });
  const overview = screen.getByRole("link", { name: "Overview" });
  const plan = screen.getByRole("link", { name: "Budget and runway" });
  expect(nav.contains(plan)).toBe(true);
  expect(overview.getAttribute("href")).toBe("/finance");
  expect(plan.getAttribute("aria-current")).toBe("page");
  expect(overview.getAttribute("aria-current")).toBeNull();
});
