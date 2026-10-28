// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PayrollLineRow } from "@convex/lib/payroll";
import { ScenarioEditor } from "./scenario-editor";

afterEach(cleanup);

// Made-up lines and rates: 10% withheld, 5% on top.
const lines: PayrollLineRow[] = [
  { id: "w", name: "Made-up withheld", paidBy: "employee", rateBp: 1_000, lessLineIds: [], allowance: 0, baseCap: null, appliesTo: "employee", order: 0, active: true },
  { id: "c", name: "Made-up on top", paidBy: "company", rateBp: 500, lessLineIds: [], allowance: 0, baseCap: null, appliesTo: "employee", order: 1, active: true },
];

const editor = (payrollLines: PayrollLineRow[] | null, onSave = vi.fn(async () => {})) =>
  render(
    <ScenarioEditor
      name="Example"
      changes={[]}
      companyCurrency="USD"
      defaultMonth="2026-11"
      payrollLines={payrollLines}
      onSave={onSave}
      onCancel={vi.fn()}
    />,
  );

test("a hire at the payroll rates: a net salary becomes its monthly total cost, and that figure is saved", async () => {
  const onSave = vi.fn(async () => {});
  editor(lines, onSave);
  fireEvent.click(screen.getByRole("button", { name: "Add a change" }));
  fireEvent.click(screen.getByLabelText("Work the cost out at the payroll rates"));
  fireEvent.change(screen.getByLabelText("Monthly salary"), { target: { value: "900" } });
  expect(screen.getByText("Monthly total cost $1,050.00 (gross $1,000.00).")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save scenario" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave).toHaveBeenCalledWith("Example", [
    {
      kind: "hire",
      label: "Hire",
      startMonth: "2026-11",
      amount: 1_050_00,
      currency: "USD",
      fromPayroll: { salary: 900_00, basis: "net" },
    },
  ]);
});

test("without Payroll, a hire takes a typed figure and says why", () => {
  editor(null);
  fireEvent.click(screen.getByRole("button", { name: "Add a change" }));
  expect(screen.queryByLabelText("Work the cost out at the payroll rates")).toBeNull();
  expect(screen.getByText(/for whoever holds the Payroll page/)).toBeTruthy();
  expect(screen.getByLabelText("Monthly total cost")).toBeTruthy();
});

test("a change without an amount is not saved", async () => {
  const onSave = vi.fn(async () => {});
  editor(null, onSave);
  fireEvent.click(screen.getByRole("button", { name: "Add a change" }));
  fireEvent.click(screen.getByRole("button", { name: "Save scenario" }));
  expect(screen.getByRole("alert").textContent).toBe("Each change needs a start month and an amount.");
  expect(onSave).not.toHaveBeenCalled();
});
