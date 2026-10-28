// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AREAS } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import FinancePlanPage from "./page";

// The views have their own tests; here, which one the page shows, and for whom.
vi.mock("@/components/budget/budget-view", () => ({
  BudgetView: ({ company }: { company: string }) => <p data-testid="budget-of">{company}</p>,
}));
// So has the header's "Updated …" line, which would ask Convex.
vi.mock("@/components/freshness/freshness-indicator", () => ({ PageFreshness: () => null }));
vi.mock("@/components/budget/budget-group", () => ({
  BudgetGroup: () => <p data-testid="budget-of">group</p>,
}));
vi.mock("@/hooks/use-now", () => ({ useNow: () => Date.UTC(2026, 9, 14, 12) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/finance/plan" }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const shown = () => screen.getByTestId("budget-of").textContent;

test("a viewer on both companies opens on the group, whatever the sidebar's switch says", () => {
  window.localStorage.setItem("startup-os:company", "kz");
  render(
    <CompanyProvider allowed={["us", "kz"]}>
      <FinancePlanPage />
    </CompanyProvider>,
  );
  expect(shown()).toBe("group");
  expect(screen.getByText(/the company switch in the sidebar sets the other pages/)).toBeTruthy();
});

test("a lens picked on the page shows that company's budget, and stays picked for the Overview", () => {
  render(<FinancePlanPage />);
  const lenses = within(screen.getByRole("group", { name: "Show" }));
  fireEvent.click(lenses.getByRole("button", { name: "Globex" }));
  expect(shown()).toBe("kz");
  expect(window.sessionStorage.getItem("startup-os:finance-lens")).toBe("kz");
  fireEvent.click(lenses.getByRole("button", { name: "Startup" }));
  expect(shown()).toBe("us");
});

test("a viewer on one company has that company's budget, with no group and no lens", () => {
  window.sessionStorage.setItem("startup-os:finance-lens", "group");
  const { container } = render(
    <ViewerProvider viewer={{ role: "cofounder", companies: ["kz"], areas: AREAS, email: null, name: null }}>
      <FinancePlanPage />
    </ViewerProvider>,
  );
  expect(shown()).toBe("kz");
  expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
  expect(container.textContent).not.toMatch(/Startup|both companies/);
});
