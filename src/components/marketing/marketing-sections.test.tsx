// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { METRICS, metricScopes } from "@convex/lib/metricRegistry";
import { useNow } from "@/hooks/use-now";
import { weekSpan } from "@/lib/metrics/product";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";
import { MarketingSections as MarketingPage } from "./marketing-sections";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

const NOW = Date.UTC(2026, 9, 14, 9);
const SERIES: Record<string, [string, number][]> = {
  "search_clicks:company": [["2026-09-28", 105]],
  "search_impressions:company": [["2026-09-28", 2100]],
  "search_position:company": [["2026-09-28", 10]],
  // PostHog's weeks for Startup Insights: the four before the week in progress.
  "web_visitors:startup_insights": [
    ["2026-09-14", 100],
    ["2026-09-21", 100],
    ["2026-09-28", 100],
    ["2026-10-05", 100],
  ],
  "signups:startup_insights": [
    ["2026-09-14", 3],
    ["2026-09-21", 3],
    ["2026-09-28", 3],
    ["2026-10-05", 3],
  ],
};
const POSTHOG_OK = { state: "ok", lastRunAt: NOW, lastOkAt: NOW, message: null };
const visitorTile = () =>
  within(screen.getByRole("heading", { name: "Visitor to signup" }).closest("article")!);
// A tile for every metric and scope, as the scorecard query returns; empty unless given above.
const tiles: Tile[] = METRICS.flatMap((metric) =>
  metricScopes(metric).map((scope) => {
    const points = SERIES[`${metric.key}:${scope}`] ?? [];
    const last = points.at(-1);
    return {
      key: metric.key,
      scope,
      firstPeriodStart: points[0]?.[0] ?? null,
      latest: last
        ? { value: last[1], periodStart: last[0], currency: null, source: "manual", syncedAt: NOW }
        : null,
      series: points.map(([periodStart, value]) => ({ periodStart, value })),
    };
  }),
);

let convex: ReturnType<typeof mockConvex>;
const ready = (sources: SourceStates = {}) => {
  convex.setQuery(api.metrics.scorecard, { tiles, sources });
  vi.mocked(useNow).mockReturnValue(NOW);
};

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("the marketing page", () => {
  test.each([
    ["the scorecard", () => convex.setQuery(api.metrics.scorecard, undefined)],
    ["the clock", () => vi.mocked(useNow).mockReturnValue(null)],
  ])("shows placeholders, and no number, until %s is in", (_name, withhold) => {
    ready();
    withhold();
    const { container } = render(<MarketingPage />);
    expect(screen.getByRole("heading", { level: 2, name: "Inbound" })).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  test("leads with the computed rate, then the stored figures", () => {
    ready();
    render(<MarketingPage />);
    for (const name of [
      "Search click-through rate",
      "Visitor to signup",
      "Search clicks",
      "Search impressions",
      "Average search position",
      "LinkedIn followers",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.getByRole("heading", { level: 3, name: "Search Console" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Audience" })).toBeTruthy();
  });

  test("states Search Console's lag beside its figures", () => {
    ready();
    render(<MarketingPage />);
    expect(
      screen.getByText(
        "Weeks run Monday to Sunday in Google's dates (Pacific time). Google's figures arrive 2–3 days late, so the newest week here is the last one Google has finished: last week from about Wednesday, the week before until then.",
      ),
    ).toBeTruthy();
  });

  test("LinkedIn followers are typed in, and the tile links to the form", () => {
    ready();
    render(<MarketingPage />);
    expect(screen.getByRole("link", { name: "Add a value" }).getAttribute("href")).toBe(
      "/finance?metric=linkedin_followers&scope=company#record-a-figure",
    );
  });

  test("a failed Search Console run is shown here; a failed Mercury run is not", () => {
    const failed = (message: string) => ({
      state: "error",
      lastRunAt: NOW,
      lastOkAt: null,
      message,
    });
    ready({
      search_console: failed("Search Console answered 403 for daily totals."),
      mercury: failed("Mercury answered 500 for accounts."),
    });
    render(<MarketingPage />);
    expect(screen.getByText("Search Console answered 403 for daily totals.")).toBeTruthy();
    expect(screen.queryByText("Mercury answered 500 for accounts.")).toBeNull();
  });

  test("visitor to signup is the product page's tile: PostHog's weeks, the same words", () => {
    ready({ posthog: POSTHOG_OK });
    render(<MarketingPage />);
    const t = visitorTile();
    expect(t.getByText("3%")).toBeTruthy();
    expect(
      t.getByText(
        `12 signups against 400 weekly visitors (a returning visitor is counted each week). Weeks of ${weekSpan("2026-09-14", "2026-10-05")}.`,
      ),
    ).toBeTruthy();
  });

  test("before PostHog has been read, visitor to signup says where it comes from", () => {
    ready();
    render(<MarketingPage />);
    const t = visitorTile();
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(t.getByText("Appears once a full week has been read.")).toBeTruthy();
  });

  test("a failed PostHog run is shown here too: it feeds visitor to signup", () => {
    ready({
      posthog: { state: "error", lastRunAt: NOW, lastOkAt: null, message: "PostHog answered 401 for signups." },
    });
    render(<MarketingPage />);
    expect(screen.getByText("PostHog answered 401 for signups.")).toBeTruthy();
  });

  test("only visitor to signup can carry a benchmark verdict", () => {
    // Without PostHog's weeks there is none anywhere on the page.
    ready();
    const first = render(<MarketingPage />);
    expect(screen.queryByRole("button", { name: /typical for seed/i })).toBeNull();
    first.unmount();
    // With them, and enough visitors, exactly one: on that tile.
    ready({ posthog: POSTHOG_OK });
    render(<MarketingPage />);
    expect(screen.getAllByRole("button", { name: /typical for seed/i })).toHaveLength(1);
    expect(visitorTile().getByRole("button", { name: /typical for seed/i })).toBeTruthy();
  });
});
