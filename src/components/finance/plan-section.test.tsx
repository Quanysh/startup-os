// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { PLAN_KEYS, type PlanRow } from "@convex/lib/planShape";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { mockConvex } from "@/test-support/convex";
import { PlanSection } from "./plan-section";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const NOW = Date.UTC(2026, 9, 12, 12);
// A made-up plan in whole dollars: base ARR 120K at the end of 2025, 600K at the end of 2026.
const VALUE: Record<string, number> = { arr: 0, revenue: 0, net_burn: 1_296_000, cash_end: 2_500_000, headcount: 5, paying_customers: 10, capital_raised: 0 };
const ARR: Record<string, Record<number, number>> = {
  bear: { 2025: 96_000, 2026: 360_000 },
  base: { 2025: 120_000, 2026: 600_000 },
  bull: { 2025: 144_000, 2026: 840_000 },
};
const rows: PlanRow[] = [2025, 2026].flatMap((year) =>
  (["bear", "base", "bull"] as const).flatMap((scenario) =>
    PLAN_KEYS.map((key) => ({ scenario, year, key, value: key === "arr" ? ARR[scenario]![year]! : VALUE[key]! })),
  ),
);
const SUMMARY: FinanceSummary = {
  currentMonth: "2026-10-01",
  markets: ["us"],
  burn: [],
  coverage: { us: true, kz: false },
  average: { value: 99_360, months: [], expected: [] },
  cash: { usd: 1_000_000, parts: [{ scope: "us", native: 1_000_000, usd: 1_000_000, periodStart: "2026-10-12" }], missing: [], rate: null, ratePeriodStart: null },
  mrr: null,
  runway: { kind: "months", months: 10 },
  burnMultiple: null,
  lateCloses: [],
  financingProblems: [],
  kzClosedMonths: [],
  unfinishedUsMonths: [],
  usFlowsReadAt: NOW,
  funding: null,
};
const MRR = [
  ["2026-07-01", 30_000],
  ["2026-08-01", 32_000],
  ["2026-09-01", 35_200],
].map(([periodStart, value]) => ({ periodStart: periodStart as string, value: value as number }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
});
afterEach(cleanup);

const show = (company: "us" | "kz") =>
  render(<PlanSection company={company} summary={SUMMARY} now={NOW} mrr={MRR} />);
const region = () => within(screen.getByRole("region", { name: "Plan against reality" }));

describe("plan against reality", () => {
  test("MRR against the base plan's line, net burn against its month, and year-end cash at today's burn", () => {
    convex.setQuery(api.plan.get, { modelVersion: "5eed5eed", syncedAt: NOW - 86_400_000, rows });
    show("us");
    expect(region().getByText("MRR for Sep is 12% under the base plan's $40K.")).toBeTruthy();
    expect(region().getByText("Net burn is 8% below the base plan's $108K a month for 2026.")).toBeTruthy();
    // 1,000,000 less 99,360 a month for October to December.
    expect(
      region().getByText(
        "At today's net burn, cash at the end of 2026 would be $701.9K, against $2.5M in the base plan.",
      ),
    ).toBeTruthy();
    expect(region().getByText("Financial model · 2026, base scenario · pushed Oct 11")).toBeTruthy();
  });

  test("a chart of the year: MRR, the base plan dashed, bear to bull as a band, with a crosshair", () => {
    convex.setQuery(api.plan.get, { modelVersion: "5eed5eed", syncedAt: NOW, rows });
    const { container } = show("us");
    const chart = region().getByRole("group", { name: /^MRR in 2026 against the plan/ });
    expect(container.querySelector('[data-line="plan"]')!.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(container.querySelector('[data-line="mrr"]')).not.toBeNull();
    expect(container.querySelector("polygon")).not.toBeNull();
    // The keyboard moves the crosshair; the tooltip lists every series at that month.
    fireEvent.keyDown(chart, { key: "End" });
    const tooltip = container.querySelector("[data-tooltip]")!;
    expect(tooltip.textContent).toContain("Dec 2026");
    expect(tooltip.textContent).toContain("$50K");
    expect(tooltip.textContent).toContain("$30K–$70K");
    expect(container.querySelector("[data-crosshair]")).not.toBeNull();
  });

  test("with no plan stored, one quiet line says where it comes from", () => {
    convex.setQuery(api.plan.get, null);
    show("us");
    expect(region().getByText(/No plan from the financial model yet/)).toBeTruthy();
    expect(region().queryByRole("group")).toBeNull();
  });

  test("Globex's view does not ask for the plan, and says whose it is", () => {
    convex.setQuery(api.plan.get, { modelVersion: "5eed5eed", syncedAt: NOW, rows });
    show("kz");
    const asked = vi
      .mocked(useQuery)
      .mock.calls.filter(([ref]) => getFunctionName(ref) === getFunctionName(api.plan.get))
      .map(([, args]) => args);
    expect(asked.every((args) => args === "skip")).toBe(true);
    expect(region().getByText(/The financial model's plan is Startup's/)).toBeTruthy();
    expect(region().queryByText(/under the base plan/)).toBeNull();
  });
});
