// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { ARR_WORDS, arrPerPerson } from "@/lib/assistant/arr";
import { ARR_PER_EMPLOYEE_LINES } from "@/lib/metrics/benchmarks";
import { mockConvex } from "@/test-support/convex";
import { ArrPerPersonTile } from "./arr-per-person";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const NOW = Date.UTC(2026, 9, 14, 12);
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

// Moved from the Assistant's "This week" to Finance (2026-10 dedupe).
describe("ARR per person in the OS, on Finance", () => {
  const MEASURE = { briefs: 6, proposed: 9, approved: 4, dismissed: 2, tasks: 3, people: { us: 4, kz: 2 } };
  const mrr = (value: number | null) => ({
    tiles: [
      {
        key: "mrr",
        scope: "us",
        latest: value === null ? null : { value, periodStart: "2026-09-01", currency: "USD", source: "manual", syncedAt: 0 },
        series: [],
      },
    ],
    sources: {},
  });

  test("ARR per person is the latest MRR × 12 over the people in the OS on Startup, said as that", () => {
    convex.setQuery(api.assistant.measure, MEASURE);
    convex.setQuery(api.metrics.scorecard, mrr(5_000));
    render(<ArrPerPersonTile />);
    expect(screen.getByTestId("arr-value").textContent).toBe("$15K");
    const tile = screen.getByTestId("arr-tile");
    expect(tile.textContent).toContain("Startup's MRR for Sep 2026 × 12 ($60K), divided by 4 people in the OS on Startup");
    expect(tile.textContent).toContain("It is not a payroll head count.");
    // No verdict and no status colour: only the figure and the published lines.
    expect(tile.querySelector("[data-slot=status-chip]")).toBeNull();
    expect(tile.textContent).not.toMatch(/weaker|stronger|typical|on track|behind/i);
    expect(within(tile).getAllByRole("listitem")).toHaveLength(ARR_PER_EMPLOYEE_LINES.length);
    expect(tile.textContent).toContain(ARR_WORDS.marks);
    expect(within(tile).getByRole("link").getAttribute("href")).toBe(ARR_PER_EMPLOYEE_LINES[0]!.source.url);
  });

  test("with no MRR on record it is not known, never a zero", () => {
    convex.setQuery(api.assistant.measure, MEASURE);
    convex.setQuery(api.metrics.scorecard, mrr(null));
    render(<ArrPerPersonTile />);
    expect(screen.getByTestId("arr-unknown").textContent).toBe(ARR_WORDS.no_mrr);
    expect(screen.queryByTestId("arr-value")).toBeNull();
    expect(screen.getByTestId("arr-tile").textContent).not.toContain("$0");
  });

  test("the state table of the ratio", () => {
    const tiles = mrr(5_000).tiles;
    expect(arrPerPerson({ company: "kz", tiles, people: 4 })).toEqual({ state: "other_company" });
    expect(arrPerPerson({ company: "us", tiles: [], people: 4 })).toEqual({ state: "no_mrr" });
    expect(arrPerPerson({ company: "us", tiles: mrr(null).tiles, people: 4 })).toEqual({ state: "no_mrr" });
    // Kazakhstan's MRR is not Startup's.
    expect(arrPerPerson({ company: "us", tiles: [{ ...tiles[0]!, scope: "kz" }], people: 4 })).toEqual({ state: "no_mrr" });
    expect(arrPerPerson({ company: "us", tiles, people: 0 })).toEqual({ state: "no_people" });
    expect(arrPerPerson({ company: "us", tiles, people: 4 })).toEqual({
      state: "known",
      value: 15_000,
      arr: 60_000,
      people: 4,
      periodStart: "2026-09-01",
    });
    // A real zero is a figure, not a missing one.
    expect(arrPerPerson({ company: "us", tiles: mrr(0).tiles, people: 4 })).toMatchObject({ state: "known", value: 0 });
  });

  test("every published line names its page and year, says who it is attributed to, and is marked unverified", () => {
    for (const line of ARR_PER_EMPLOYEE_LINES) {
      expect(line.source.url).toMatch(/^https:\/\//);
      expect(line.source.year).toMatch(/^20\d\d$/);
      expect(line.attributed.length).toBeGreaterThan(5);
      expect(line.verified).toBe(false);
      expect(line.value).toBeGreaterThan(0);
    }
    expect(ARR_PER_EMPLOYEE_LINES.map((line) => line.value)).toEqual([164_000, 200_000, 283_000, 500_000, 1_130_000]);
  });
});
