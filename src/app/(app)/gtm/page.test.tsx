// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { METRICS, metricScopes } from "@convex/lib/metricRegistry";
import { useNow } from "@/hooks/use-now";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";
import GtmPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

const NOW = Date.UTC(2026, 9, 14, 9);
const SERIES: Record<string, [string, number][]> = {
  "outbound_delivered:us": [
    ["2026-09-28", 200],
    ["2026-10-05", 240],
    ["2026-10-12", 246],
  ],
  "outbound_opened:us": [["2026-10-12", 90]],
  "outbound_replied:us": [["2026-10-12", 8]],
};
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
        ? { value: last[1], periodStart: last[0], currency: null, source: "apollo", syncedAt: NOW }
        : null,
      series: points.map(([periodStart, value]) => ({ periodStart, value })),
    };
  }),
);

let convex: ReturnType<typeof mockConvex>;
// Deals created since a moment, as `deals.createdSince` answers. NOW is
// Wednesday 14 October: the week in progress began on the 12th, and the four
// weeks before it on 14 September.
const WINDOW_FROM = Date.UTC(2026, 8, 14);
const WINDOW_TO = Date.UTC(2026, 9, 12);
const created = (us: number, kzMirrored: number) => ({
  us: { native: us, mirrored: 0 },
  kz: { native: 0, mirrored: kzMirrored },
});
const SINCE: Record<number, ReturnType<typeof created>> = {
  [WINDOW_FROM]: created(5, 7),
  // Two US deals and three Kazakhstan ones belong to the week in progress.
  [WINDOW_TO]: created(2, 3),
};
// Apollo's two lists as `workTools.outbound` answers before its first push.
const NO_LISTS = {
  sequences: { readAt: null, rows: [] },
  stages: { readAt: null, rows: [] },
  lastOkAt: null,
};
const ready = (sources: SourceStates = {}) => {
  convex.setQuery(api.workTools.outbound, NO_LISTS);
  convex.setQuery(api.metrics.scorecard, { tiles, sources });
  convex.setQueryBy(api.deals.createdSince, (args) => SINCE[(args as { since: number }).since]);
  vi.mocked(useNow).mockReturnValue(NOW);
};

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("the GTM page", () => {
  test.each([
    ["the scorecard", () => convex.setQuery(api.metrics.scorecard, undefined)],
    ["the clock", () => vi.mocked(useNow).mockReturnValue(null)],
  ])("shows placeholders, and no number, until %s is in", (_name, withhold) => {
    ready();
    withhold();
    const { container } = render(<GtmPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Go to market" })).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  test("leads with the three computed figures, then what was read and typed", () => {
    ready();
    render(<GtmPage />);
    for (const name of [
      "Outbound reply rate",
      "Delivered last week",
      "Deals created, last four weeks",
      "Meetings booked",
      "Outbound emails delivered, to date",
      "Outbound emails opened, to date",
      "Outbound replies, to date",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
  });

  test("deals created in the four weeks that have ended, without the week in progress", () => {
    ready();
    render(<GtmPage />);
    expect(
      screen.getByText("7 deals created in the last four weeks: 3 US, 4 Kazakhstan."),
    ).toBeTruthy();
    expect(
      screen.getByText("Kazakhstan deals count from when the CRM first listed them here."),
    ).toBeTruthy();
  });

  test("the deals tile waits for both counts; the rest of the page does not wait for it", () => {
    ready();
    convex.setQueryBy(api.deals.createdSince, (args) =>
      (args as { since: number }).since === WINDOW_TO ? undefined : SINCE[WINDOW_FROM],
    );
    render(<GtmPage />);
    expect(screen.getByRole("heading", { name: "Outbound reply rate" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Deals created, last four weeks" })).toBeNull();
    expect(screen.queryByText(/created in the last four weeks/)).toBeNull();
  });

  test("no deals query is asked before the clock is in", () => {
    ready();
    vi.mocked(useNow).mockReturnValue(null);
    const asked: unknown[] = [];
    convex.setQueryBy(api.deals.createdSince, (args) => {
      asked.push(args);
      return created(0, 0);
    });
    render(<GtmPage />);
    expect(asked).toEqual([]);
  });

  test("meetings booked are typed in, and the tile links to the form", () => {
    ready();
    render(<GtmPage />);
    // The inbound half of the page has typed-in figures of its own.
    const hrefs = screen
      .getAllByRole("link", { name: "Add a value" })
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/finance?metric=meetings_booked&scope=company#record-a-figure");
  });

  test("says what Apollo's totals are", () => {
    ready();
    render(<GtmPage />);
    expect(
      screen.getByText(
        "Apollo counts to date, across every sequence. Each week's tile holds the totals as last read in that week; the week in progress moves until it ends.",
      ),
    ).toBeTruthy();
  });

  test("a failed Apollo run is shown here; a failed Mercury run is not", () => {
    const failed = (message: string) => ({
      state: "error",
      lastRunAt: NOW,
      lastOkAt: null,
      message,
    });
    ready({
      apollo: failed("Apollo answered 403 for sequences."),
      mercury: failed("Mercury answered 500 for accounts."),
    });
    render(<GtmPage />);
    expect(screen.getByText("Apollo answered 403 for sequences.")).toBeTruthy();
    expect(screen.queryByText("Mercury answered 500 for accounts.")).toBeNull();
  });

  test("only the reply rate carries a benchmark verdict", () => {
    ready();
    render(<GtmPage />);
    expect(screen.getAllByRole("button", { name: /typical for seed/i })).toHaveLength(1);
  });
});

describe("the GTM page: Apollo's sequences, prospects, tasks and calls", () => {
  const SECTIONS = ["Sequences", "Prospects", "Tasks and calls"];
  const sequence = {
    sequenceId: "s1",
    name: "Made-up outreach",
    active: true,
    archived: false,
    steps: 7,
    createdAt: "2026-03-13",
    lastUsedAt: "2026-10-12",
    delivered: 24,
    opened: 1,
    replied: 0,
    bounced: 1,
    unsubscribed: 1,
  };

  test("the three sections follow the reported figures, under Outbound", () => {
    ready();
    render(<GtmPage />);
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    const at = (name: string) => headings.indexOf(name);
    expect(at("Outbound")).toBeGreaterThan(-1);
    expect(at("Reported figures")).toBeGreaterThan(at("Outbound"));
    expect(SECTIONS.map(at)).toEqual([...SECTIONS.map(at)].sort((a, b) => a - b));
    expect(at("Sequences")).toBeGreaterThan(at("Reported figures"));
  });

  test("before Apollo's first read each says it arrives with the daily read", () => {
    ready();
    render(<GtmPage />);
    expect(screen.getAllByText(/arrives? with the daily Apollo read\.$/)).toHaveLength(3);
  });

  test("the lists are asked for once, and what they hold is shown", () => {
    ready();
    vi.mocked(useQuery).mockClear();
    convex.setQuery(api.workTools.outbound, {
      sequences: { readAt: NOW - 1000, rows: [sequence] },
      stages: { readAt: NOW - 1000, rows: [{ entity: "contact", stage: "Cold", count: 735 }] },
      lastOkAt: NOW - 1000,
    });
    render(<GtmPage />);
    expect(asked(api.workTools.outbound).every((args) => args !== "skip")).toBe(true);
    expect(screen.getByRole("table", { name: "Apollo sequences" })).toBeTruthy();
    expect(screen.getByText("Made-up outreach")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Contacts by stage" })).toBeTruthy();
  });

  test("while the lists load, the rest of the page does not wait for them", () => {
    ready();
    convex.setQuery(api.workTools.outbound, undefined);
    render(<GtmPage />);
    expect(screen.getByRole("heading", { name: "Outbound reply rate" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Reported figures" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sequences" })).toBeNull();
  });

  test("a viewer who is not on Startup is not asked for Apollo's lists, which Convex would refuse", () => {
    ready();
    vi.mocked(useQuery).mockClear();
    render(
      <ViewerProvider
        viewer={{ role: "sales", companies: ["kz"], areas: ["gtm"], email: null, name: null }}
      >
        <GtmPage />
      </ViewerProvider>,
    );
    expect(asked(api.workTools.outbound).length).toBeGreaterThan(0);
    expect(asked(api.workTools.outbound).every((args) => args === "skip")).toBe(true);
    for (const name of SECTIONS) expect(screen.queryByRole("heading", { name })).toBeNull();
  });
});

// No role in today's table has this page without the areas below, so these
// viewers are made up: the page must still not send what Convex would refuse.
const asked = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called]) => getFunctionName(called as never) === getFunctionName(ref))
    .map(([, args]) => args);
const viewerWith = (areas: Area[], page: React.ReactNode) =>
  render(
    <ViewerProvider
      viewer={{ role: "cofounder", companies: ["us", "kz"], areas, email: null, name: null }}
    >
      {page}
    </ViewerProvider>,
  );

describe("the GTM page for a viewer without the sales area", () => {
  test("deals created are neither asked for nor waited for", () => {
    ready();
    vi.mocked(useQuery).mockClear();
    convex.setQuery(api.deals.createdSince, undefined);
    convex.setQueryBy(api.deals.createdSince, () => undefined);
    const { container } = viewerWith(["gtm"], <GtmPage />);
    expect(asked(api.deals.createdSince).length).toBeGreaterThan(0);
    expect(asked(api.deals.createdSince).every((args) => args === "skip")).toBe(true);
    expect(screen.getByRole("heading", { name: "Outbound reply rate" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Deals created, last four weeks" })).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});

describe("Inbound's visitor-to-signup figure", () => {
  // Its two figures are declared with the product's: without Product they are
  // never sent, and a tile would say the figure had not arrived. The rule Today's
  // Go to market block keeps too (`readsVisitorSignup`).
  test("is shown with Product as well as Marketing, and left out without it", () => {
    ready();
    viewerWith(["gtm", "marketing"], <GtmPage />);
    expect(screen.getByRole("heading", { name: "Search click-through rate" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Visitor to signup" })).toBeNull();
    cleanup();
    viewerWith(["gtm", "marketing", "product"], <GtmPage />);
    expect(screen.getByRole("heading", { name: "Visitor to signup" })).toBeTruthy();
  });
});
