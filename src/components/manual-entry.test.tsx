// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { formatPeriod, formatValue } from "@/lib/format";
import { CLOSE_WINDOW_DAYS } from "@/lib/metrics/finance";
import { readTable } from "@/lib/table-export";
import { mockConvex } from "@/test-support/convex";
import { ManualEntry } from "./manual-entry";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const open = (query: string) => {
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as never);
  render(<ManualEntry />);
};
const HINT =
  "For a month-end balance, set the date to the last day of the month it closes (the last three days of the month, or the first three of the next, are accepted).";

// A teammate who was given "Sources and Telegram" types numbers in for their
// own companies. The server refuses any other; the form does not offer them.
describe("ManualEntry for a teammate on one company", () => {
  const openAs = (query: string, companies: CompanyId[], areas: Area[] = ["settings"]) => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as never);
    render(
      <ViewerProvider viewer={{ role: "engineer", companies, areas, email: null, name: null }}>
        <ManualEntry />
      </ViewerProvider>,
    );
  };
  const offered = () =>
    [...(screen.getByLabelText("Metric") as HTMLSelectElement).options].map((o) => o.value);

  test("on Globex: only Globex's numbers are offered", () => {
    openAs("metric=cash&scope=kz", ["kz"]);
    expect(offered()).toContain("cash:kz");
    expect(offered().some((id) => /:(us|startup_insights|vertical_startup)$/.test(id))).toBe(false);
  });

  test("on Startup: only Startup's, and a link to the other company's number opens on one of theirs", () => {
    openAs("metric=cash&scope=kz", ["us"]);
    expect(offered()).not.toContain("cash:kz");
    expect(offered()).toContain("mrr:us");
    expect(offered().some((id) => /:(kz|kz_product)$/.test(id))).toBe(false);
    expect(offered()).toContain((screen.getByLabelText("Metric") as HTMLSelectElement).value);
  });

  test("without the figure's own page, they are told why no earlier value shows", () => {
    convex.setQuery(api.metrics.series, []);
    openAs("metric=cash&scope=kz", ["kz"]);
    expect(
      screen.getByText(
        "Earlier values show only to people with the Finance page. What you save here is stored all the same.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing entered yet.")).toBeNull();
  });

  test("with the figure's page, an empty history just says so", () => {
    convex.setQuery(api.metrics.series, []);
    openAs("metric=cash&scope=kz", ["kz"], ["settings", "finance"]);
    expect(screen.getByText("Nothing entered yet.")).toBeTruthy();
  });
});

describe("ManualEntry", () => {
  test("a Kazakhstan bank balance is asked to be dated at the month end it closes", () => {
    open("metric=cash&scope=kz");
    expect((screen.getByLabelText("Metric") as HTMLSelectElement).value).toBe("cash:kz");
    expect(screen.getByText(HINT)).toBeTruthy();
    // The hint's "three" is true only while the finance page closes months on this window.
    expect(CLOSE_WINDOW_DAYS).toBe(3);
    expect(screen.queryByText(/any day inside it works/)).toBeNull();
  });

  test("any other number keeps the ordinary hint about its bucket", () => {
    open("metric=mrr&scope=us");
    expect((screen.getByLabelText("Metric") as HTMLSelectElement).value).toBe("mrr:us");
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.getByText("Stored per month: any day inside it works.")).toBeTruthy();
  });

  test("the recent values download as periods and figures, newest first, without the buttons that remove them", () => {
    // Made-up figures.
    convex.setQuery(api.metrics.series, [
      { periodStart: "2026-08-01", value: 1_000, currency: "USD", source: "manual" },
      { periodStart: "2026-09-01", value: 2_500, currency: "USD", source: "manual" },
    ]);
    open("metric=mrr&scope=us");
    const label = (screen.getByLabelText("Metric") as HTMLSelectElement).selectedOptions[0]!.text;
    expect(screen.getByRole("button", { name: `Download Recent values: ${label} as CSV` })).toBeTruthy();
    expect(readTable(screen.getByRole("table"))).toEqual([
      [formatPeriod("month", "2026-09-01"), formatValue(2_500, "currency", "USD")],
      [formatPeriod("month", "2026-08-01"), formatValue(1_000, "currency", "USD")],
    ]);
  });

  test("with no recent value there is no table and nothing to download", () => {
    convex.setQuery(api.metrics.series, []);
    open("metric=mrr&scope=us");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /as CSV$/ })).toBeNull();
  });
});
