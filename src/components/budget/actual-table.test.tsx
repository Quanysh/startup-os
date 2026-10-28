// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { effectiveBudget, planVsActual, type BudgetCategory, type Live } from "@convex/lib/budget";
import { ActualTable } from "./actual-table";

afterEach(cleanup);

// Made-up amounts. Cloud's register says 1,000 a month; the rest nothing.
const months = ["2026-07", "2026-08", "2026-09"];
const actuals = new Map([
  ["2026-07", 1_200_00],
  ["2026-08", 900_00],
]);
const live =
  (pay: Live) =>
  (category: BudgetCategory): Live =>
    category === "payroll" ? pay : { kind: "known", amount: category === "cloud" ? 1_000_00 : 0 };
const rows = planVsActual(months, effectiveBudget(months, [], live({ kind: "known", amount: 0 })), actuals);

test("over budget in the danger tint, under in the success tint, each with its word; a missing actual is not known yet", () => {
  render(<ActualTable rows={rows} currency="USD" source="mercury" />);
  const july = screen.getByRole("row", { name: /Jul 2026/ });
  expect(within(july).getByText("Over by $200.00 (+20%)").closest("[data-tone]")?.getAttribute("data-tone")).toBe("danger");
  const august = screen.getByRole("row", { name: /Aug 2026/ });
  expect(within(august).getByText("Under by $100.00 (−10%)").closest("[data-tone]")?.getAttribute("data-tone")).toBe("success");
  const september = screen.getByRole("row", { name: /Sep 2026/ });
  expect(within(september).getAllByText("Not known yet").length).toBeGreaterThan(0);
  expect(screen.getByText(/Actual is Startup's own spending: Mercury's money out less what it sent Globex/)).toBeTruthy();
});

test("without Payroll, a budget that leaves pay out is not compared, and says so", () => {
  const short = planVsActual(months, effectiveBudget(months, [], live({ kind: "hidden" })), actuals);
  render(<ActualTable rows={short} currency="USD" source="mercury" />);
  expect(screen.queryByText(/Over by/)).toBeNull();
  expect(screen.getAllByText("Not compared: the budget leaves out Payroll").length).toBe(3);
});

test("a budget that is not known (a payroll rate not set) shows no figure and no variance", () => {
  const unset = planVsActual(months, effectiveBudget(months, [], live({ kind: "unknown", reason: "rates" })), actuals);
  render(<ActualTable rows={unset} currency="USD" source="mercury" />);
  const july = screen.getByRole("row", { name: /Jul 2026/ });
  expect(within(july).getAllByText("Not known yet")).toHaveLength(2);
  expect(within(july).getByText("$1,200.00")).toBeTruthy();
});

test("Globex's actual is typed in, a month at a time", () => {
  const onSetActual = vi.fn(async () => {});
  render(<ActualTable rows={rows} currency="KZT" source="typed" onSetActual={onSetActual} />);
  const field = screen.getByLabelText("Actual spent, Sep 2026");
  fireEvent.change(field, { target: { value: "950000" } });
  fireEvent.blur(field);
  expect(onSetActual).toHaveBeenCalledWith("2026-09", 950_000_00);
  expect(screen.getByText(/Actual is typed in/)).toBeTruthy();
});

test("the typed actual says it is the one actual spend, and that Finance's burn from cash is not it", () => {
  render(<ActualTable rows={rows} currency="KZT" source="typed" />);
  expect(
    screen.getByText(
      "Actual is typed in for each month: Globex's bank has no feed in the OS. It is Globex's one actual spend: the Finance page's net burn (from cash) is money out less money in, from month-end balances, and is never set against the budget.",
    ),
  ).toBeTruthy();
});
