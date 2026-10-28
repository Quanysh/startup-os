// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { mockConvex } from "@/test-support/convex";
import type { GroupFigures } from "@/lib/finance/group";
import { GroupRunwayGlance, RunwayGlance } from "./runway-glance";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const SUMMARY: FinanceSummary = {
  currentMonth: "2026-10-01",
  markets: ["us"],
  burn: [],
  coverage: { us: true, kz: false },
  average: { value: 20_000, months: [], expected: [] },
  cash: { usd: 400_000, parts: [{ scope: "us", native: 400_000, usd: 400_000, periodStart: "2026-10-12" }], missing: [], rate: null, ratePeriodStart: null },
  mrr: null,
  runway: { kind: "months", months: 20 },
  burnMultiple: null,
  lateCloses: [],
  financingProblems: [],
  kzClosedMonths: [],
  unfinishedUsMonths: [],
  usFlowsReadAt: null,
  funding: null,
};
const scenario = (name: string, amount: number) => ({
  id: name,
  name,
  updatedAt: 0,
  changes: [{ kind: "hire" as const, label: "Made-up hire", startMonth: "2026-11", endMonth: null, amount, currency: "USD" as const, fromPayroll: null }],
});

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);
const TODAY = "2026-10-15";
const region = (name = "Runway and what changes it") => within(screen.getByRole("region", { name }));
/** A made-up company close to running out: 20,000 at 25,500 a month. */
const SHORT: FinanceSummary = {
  ...SUMMARY,
  average: { value: 25_500, months: [], expected: [] },
  cash: { ...SUMMARY.cash!, usd: 20_000, parts: [{ scope: "us", native: 20_000, usd: 20_000, periodStart: "2026-10-14" }] },
  runway: { kind: "months", months: 20_000 / 25_500 },
};
/** Nothing on the chart reads below zero: no axis label, tooltip or callout with a minus. */
const noNegative = (root: HTMLElement) => expect(root.textContent ?? "").not.toMatch(/[−-]\$|[−-]₸/);

describe("runway and what changes it", () => {
  test("the baseline is drawn, and each saved scenario's run-out month is a chip that leads to the tab", () => {
    convex.setQuery(api.scenarios.list, [scenario("Two hires", 10_000_00)]);
    render(<RunwayGlance company="us" summary={SUMMARY} today={TODAY} />);
    expect(region().getByRole("group", { name: /^Cash at today's net burn/ })).toBeTruthy();
    const chip = within(region().getByRole("list", { name: "Scenarios" })).getByRole("link");
    // 387,000 left after October, then 30,000 a month from November: it crosses zero late in Nov 2027.
    expect(chip.textContent).toBe("Two hiresRuns out in Nov 2027");
    expect(chip.getAttribute("href")).toBe("/finance/plan");
    // 20 months: the line stops at its run-out, marked, over 24 months, with no sentence leading.
    expect(region().getByText("Runs out ~Jun 2028")).toBeTruthy();
    expect(region().getByText("Cash at today's net burn over the next 24 months, to where it runs out")).toBeTruthy();
    expect(region().queryByText(/at today's burn\.$/)).toBeNull();
  });

  test("runs out within weeks: the sentence leads with its figures, the chart in weeks stops at zero", () => {
    convex.setQuery(api.scenarios.list, []);
    const { container } = render(<RunwayGlance company="us" summary={SHORT} today={TODAY} />);
    expect(region().getByText("Cash runs out around 8 Nov at today's burn.")).toBeTruthy();
    expect(region().getByText("$20K in the bank today, net burn $25.5K a month.")).toBeTruthy();
    expect(region().getByText("Runs out ~8 Nov")).toBeTruthy();
    expect(region().getByText("Cash at today's net burn over the next 5 weeks, to where it runs out")).toBeTruthy();
    noNegative(container);
    // The screen reader's table ends at the run-out, at zero.
    const rows = within(container.querySelector("table")!).getAllByRole("row");
    expect(rows.at(-1)!.textContent).toBe("Runs out around 8 Nov 2026$0");
  });

  test("a scenario that adds cash moves its own run-out date", () => {
    convex.setQuery(api.scenarios.list, [
      {
        id: "raise",
        name: "Bridge",
        updatedAt: 0,
        changes: [{ kind: "cash_in" as const, label: "Made-up bridge", startMonth: "2026-11", endMonth: null, amount: 30_000_00, currency: "USD" as const, fromPayroll: null }],
      },
    ]);
    render(<RunwayGlance company="us" summary={SHORT} today={TODAY} />);
    const chip = within(region().getByRole("list", { name: "Scenarios" })).getByRole("link");
    expect(chip.textContent).toBe("BridgeRuns out around 13 Dec");
  });

  test("beside the other company's: each says what its burn counts, and that the two do not add up", () => {
    convex.setQuery(api.scenarios.list, []);
    render(
      <>
        <RunwayGlance company="us" summary={SHORT} today={TODAY} named />
        <RunwayGlance company="kz" summary={{ ...SHORT, markets: ["kz"] }} today={TODAY} named />
      </>,
    );
    expect(region("Runway and what changes it · Startup").getByText(/Startup's burn here includes what it sends Globex/)).toBeTruthy();
    expect(region("Runway and what changes it · Globex").getByText(/Globex's burn here is without new money from Startup/)).toBeTruthy();
    expect(region("Runway and what changes it · Startup").getByText(/do not add up/)).toBeTruthy();
  });

  test("no scenarios: what to add, and where", () => {
    convex.setQuery(api.scenarios.list, []);
    render(<RunwayGlance company="us" summary={SUMMARY} today={TODAY} />);
    expect(region().getByText(/None yet\. Add hires, costs or revenue on Budget and runway/)).toBeTruthy();
    expect(region().getByRole("link", { name: /Edit on Budget and runway/ }).getAttribute("href")).toBe("/finance/plan");
  });

  test("no burn figure: no projection, said in words", () => {
    convex.setQuery(api.scenarios.list, []);
    render(<RunwayGlance company="us" summary={{ ...SUMMARY, average: null, runway: null }} today={TODAY} />);
    expect(region().getByText("Not known yet: the Finance page has no average net burn from complete months.")).toBeTruthy();
    expect(region().queryByRole("group")).toBeNull();
  });
});

const GROUP: GroupFigures = {
  cash: { kind: "known", usd: 20_000 },
  netBurn: { kind: "known", usd: 25_500 },
  mrr: { kind: "unknown", missing: ["us"] },
  runway: { kind: "months", months: 20_000 / 25_500 },
};

describe("the group's runway", () => {
  test("group cash at the group's net burn: the sentence, its figures, and the run-out marked", () => {
    const { container } = render(<GroupRunwayGlance group={GROUP} today={TODAY} />);
    const group = region("Group runway");
    expect(group.getByText("Group cash runs out around 8 Nov at today's burn.")).toBeTruthy();
    expect(group.getByText("$20K in the bank today, net burn $25.5K a month.")).toBeTruthy();
    expect(group.getByText("Runs out ~8 Nov")).toBeTruthy();
    expect(group.getByText(/what Startup sends Globex counted once/)).toBeTruthy();
    noNegative(container);
  });

  test("a group figure not known: no chart, said in words, never zero", () => {
    render(<GroupRunwayGlance group={{ ...GROUP, cash: { kind: "unknown", missing: ["kz"] }, runway: { kind: "unknown", missing: ["kz"] } }} today={TODAY} />);
    const group = region("Group runway");
    expect(group.getByText(/^Not known yet/)).toBeTruthy();
    expect(group.queryByRole("group")).toBeNull();
  });
});
