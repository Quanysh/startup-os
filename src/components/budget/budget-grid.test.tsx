// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { effectiveBudget, type BudgetCategory, type Live } from "@convex/lib/budget";
import { BudgetGrid } from "./budget-grid";

afterEach(cleanup);

// Made-up amounts. The registers say: pay 1,000 in October and 1,100 in
// November, cloud 100 a month, nothing else. Cloud is typed over in November.
const months = ["2026-10", "2026-11"];
const registers = (category: BudgetCategory, month: string): Live =>
  category === "payroll"
    ? { kind: "known", amount: month === "2026-10" ? 1_000_00 : 1_100_00 }
    : { kind: "known", amount: category === "cloud" ? 100_00 : 0 };
const typed = [{ month: "2026-11", category: "cloud" as const, amount: 150_00 }];
const grid = (live = registers, onSave = vi.fn(async () => {})) => {
  render(<BudgetGrid months={months} currency="USD" cells={effectiveBudget(months, typed, live)} onSave={onSave} />);
  return onSave;
};

test("each cell is the register's figure, marked where it comes from, with row and column totals", () => {
  grid();
  const cloud = screen.getByRole("row", { name: /Cloud/ });
  expect(within(cloud).getByText("from Costs")).toBeTruthy();
  const october = within(cloud).getByLabelText("Cloud, Oct 2026");
  expect(october).toHaveProperty("value", "100");
  expect(october.getAttribute("data-source")).toBe("live");
  expect(october.getAttribute("aria-description")).toBe("From Costs");
  expect(within(screen.getByRole("row", { name: /Payroll/ })).getByText("from Payroll")).toBeTruthy();
  expect(within(cloud).getByText("$250.00")).toBeTruthy();
  const totals = screen.getByRole("row", { name: /Total/ });
  expect(within(totals).getByText("$1,100.00")).toBeTruthy();
  expect(within(totals).getByText("$1,250.00")).toBeTruthy();
  expect(within(totals).getByText("$2,350.00")).toBeTruthy();
});

test("a typed cell is an override, shown apart, with a reset to the register's figure", () => {
  const onSave = grid();
  const november = screen.getByLabelText("Cloud, Nov 2026");
  expect(november).toHaveProperty("value", "150");
  expect(november.getAttribute("data-source")).toBe("override");
  expect(november.getAttribute("aria-description")).toBe("Typed in");
  // No reset where nothing was typed.
  expect(screen.queryByRole("button", { name: "Reset Cloud, Oct 2026 to Costs" })).toBeNull();
  const reset = screen.getByRole("button", { name: "Reset Cloud, Nov 2026 to Costs" });
  expect(reset.getAttribute("title")).toBe("Reset to Costs ($100.00)");
  fireEvent.click(reset);
  expect(onSave).toHaveBeenLastCalledWith([{ month: "2026-11", category: "cloud", amount: null }]);
});

test("typing over a register's figure saves an override; the same figure, or nothing, saves nothing", () => {
  const onSave = grid();
  const field = screen.getByLabelText("Office, Nov 2026");
  fireEvent.change(field, { target: { value: "1,234.5" } });
  fireEvent.blur(field);
  expect(onSave).toHaveBeenLastCalledWith([{ month: "2026-11", category: "office", amount: 1_234_50 }]);
  onSave.mockClear();

  const cloud = screen.getByLabelText("Cloud, Oct 2026");
  fireEvent.change(cloud, { target: { value: "100.00" } });
  fireEvent.blur(cloud);
  fireEvent.change(cloud, { target: { value: "" } });
  fireEvent.blur(cloud);
  expect(onSave).not.toHaveBeenCalled();
});

test("emptying an override puts the register's figure back", () => {
  const onSave = grid();
  const field = screen.getByLabelText("Cloud, Nov 2026");
  fireEvent.change(field, { target: { value: "" } });
  fireEvent.blur(field);
  expect(onSave).toHaveBeenLastCalledWith([{ month: "2026-11", category: "cloud", amount: null }]);
});

test("what is not an amount is not saved, and says so", () => {
  const onSave = grid();
  const field = screen.getByLabelText("Office, Nov 2026");
  fireEvent.change(field, { target: { value: "lots" } });
  fireEvent.blur(field);
  expect(onSave).not.toHaveBeenCalled();
  expect(field.getAttribute("aria-invalid")).toBe("true");
});

test("a register figure that is not known is not a zero: the cell and its totals say so", () => {
  grid((category, month) =>
    category === "payroll" && month === "2026-10" ? { kind: "unknown", reason: "rates" } : registers(category, month),
  );
  const field = screen.getByLabelText("Payroll, Oct 2026");
  expect(field).toHaveProperty("value", "");
  expect(field.getAttribute("placeholder")).toBe("Not known");
  expect(field.getAttribute("title")).toMatch(/a payroll rate is not set/);
  const totals = screen.getByRole("row", { name: /Total/ });
  expect(within(totals).getAllByText("Not known yet")).toHaveLength(2);
  expect(within(totals).getByText("$1,250.00")).toBeTruthy();
});

test("without Payroll, its row says where it is, with no figure, and the totals say they leave it out", () => {
  grid((category, month) => (category === "payroll" ? { kind: "hidden" } : registers(category, month)));
  expect(screen.queryByLabelText("Payroll, Oct 2026")).toBeNull();
  expect(within(screen.getByRole("row", { name: /Payroll/ })).getByText("On the Payroll page")).toBeTruthy();
  const totals = screen.getByRole("row", { name: /Total/ });
  expect(within(totals).getByText("$100.00")).toBeTruthy();
  expect(screen.getByText(/^Total excludes Payroll:/)).toBeTruthy();
});

test("without Costs, one row says where the Costs rows are, and the totals leave them out", () => {
  grid((category, month) => (category === "payroll" ? registers(category, month) : { kind: "hidden" }));
  expect(screen.queryByLabelText("Cloud, Oct 2026")).toBeNull();
  expect(within(screen.getByRole("row", { name: /^Costs/ })).getByText("On the Costs page")).toBeTruthy();
  expect(screen.getByText(/^Total excludes Costs:/)).toBeTruthy();
});

test("with neither, there is no grid, and it says why", () => {
  grid(() => ({ kind: "hidden" }));
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText(/you do not hold them/)).toBeTruthy();
});
