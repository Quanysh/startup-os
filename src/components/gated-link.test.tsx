// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { MetricDef } from "@convex/lib/metricRegistry";
import { areasOf, type Role } from "@convex/lib/roles";
import { AttentionList } from "@/components/attention-list";
import { CashTile } from "@/components/finance/cash-tile";
import { NoteLink } from "@/components/finance/notes";
import { HeroMrr } from "@/components/metrics/hero-mrr";
import { MetricTile } from "@/components/metrics/metric-tile";
import { ViewerProvider } from "@/components/viewer-provider";
import { LinearBoard } from "@/components/work/linear-board";
import type { Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";
import { GatedLink } from "./gated-link";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

/** Render as a teammate with this role. Without it, a component is shown everything. */
const as = (role: Role, ui: ReactNode) =>
  render(
    <ViewerProvider
      viewer={{ role, companies: ["us", "kz"], areas: areasOf(role), email: null, name: null }}
    >
      {ui}
    </ViewerProvider>,
  );
const links = () => screen.queryAllByRole("link").map((a) => a.getAttribute("href"));

describe("GatedLink", () => {
  const ui = (
    <p>
      See the <GatedLink href="/finance?metric=cash&scope=kz#record-a-figure">entry form</GatedLink>.
    </p>
  );

  test("a viewer who can open the page gets the link", () => {
    render(ui);
    expect(links()).toEqual(["/finance?metric=cash&scope=kz#record-a-figure"]);
    cleanup();
    as("owner", ui);
    expect(links()).toEqual(["/finance?metric=cash&scope=kz#record-a-figure"]);
  });

  test("a viewer who cannot reads the same words with no link", () => {
    const { container } = as("cofounder", ui);
    expect(links()).toEqual([]);
    expect(container.textContent).toBe("See the entry form.");
  });

  test("or other words, where the link's own would tell them to do what they cannot", () => {
    const { container } = as(
      "sales",
      <p>
        No balance yet.{" "}
        <GatedLink href="/settings/sources" otherwise="The owner enters it.">
          Enter it
        </GatedLink>
      </p>,
    );
    expect(links()).toEqual([]);
    expect(container.textContent).toBe("No balance yet. The owner enters it.");
  });

  test("a link to a page of the viewer's own areas stays a link", () => {
    as("sales", <GatedLink href="/customers?health=at_risk">Clinics</GatedLink>);
    expect(links()).toEqual(["/customers?health=at_risk"]);
  });

  test("a finance note's link follows the same rule", () => {
    as("cofounder", <NoteLink href="/finance?metric=financing_in&scope=us#record-a-figure">financing received</NoteLink>);
    expect(links()).toEqual([]);
    expect(screen.getByText("financing received")).toBeTruthy();
  });
});

const empty = (key: string, scope: string): Tile => ({
  key,
  scope,
  latest: null,
  firstPeriodStart: null,
  series: [],
});
const typedIn: MetricDef = {
  key: "mrr",
  label: "MRR",
  section: "finance",
  unit: "currency",
  grain: "month",
  better: "up",
  sources: { us: "manual" },
  staleAfterDays: 45,
  home: 1,
};

describe("a metric tile with no value, for a viewer who cannot enter one", () => {
  test("a typed-in figure names the owner instead of offering the entry form", () => {
    as("sales", <MetricTile metric={typedIn} tile={empty("mrr", "us")} now={NOW} />);
    expect(links()).toEqual([]);
    expect(screen.queryByText("Add a value")).toBeNull();
    expect(screen.getByText("The owner enters this figure.")).toBeTruthy();
  });

  test("a figure a source brings still names the source, with no link to the sources page", () => {
    const delivered: MetricDef = { ...typedIn, key: "receivables", sources: { kz: "cfo_workbook" } };
    as("cofounder", <MetricTile metric={delivered} tile={empty("receivables", "kz")} now={NOW} />);
    expect(links()).toEqual([]);
    expect(screen.getByText("Arrives with the CFO workbook.")).toBeTruthy();
  });

  test("the owner's tile is unchanged", () => {
    as("owner", <MetricTile metric={typedIn} tile={empty("mrr", "us")} now={NOW} />);
    expect(screen.getByRole("link", { name: "Add a value" }).getAttribute("href")).toBe(
      "/finance?metric=mrr&scope=us#record-a-figure",
    );
    expect(screen.queryByText("The owner enters this figure.")).toBeNull();
  });
});

describe("the headline MRR, for a viewer who cannot enter one", () => {
  test("with no figure at all there is no Add MRR button", () => {
    as("sales", <HeroMrr tiles={[]} />);
    expect(screen.getByText("No value yet")).toBeTruthy();
    expect(links()).toEqual([]);
    expect(screen.queryByText("Add MRR")).toBeNull();
  });

  test("a missing figure is still named, without the link to its form", () => {
    const series = (key: string, scope: string, points: [string, number][]): Tile => ({
      ...empty(key, scope),
      firstPeriodStart: points[0]![0],
      series: points.map(([periodStart, value]) => ({ periodStart, value })),
    });
    const tiles = [
      series("mrr", "us", [["2026-09-01", 5_000]]),
      series("mrr", "kz", [["2026-09-01", 4_400_000], ["2026-10-01", 4_400_000]]),
      series("fx_usd_kzt", "company", [["2026-09-01", 440]]),
    ];
    as("cofounder", <HeroMrr tiles={tiles} />);
    expect(screen.getByText("The US has no MRR figure for Oct 2026 yet.")).toBeTruthy();
    expect(links()).toEqual([]);
  });
});

describe("the attention list, for a viewer who cannot open where an item leads", () => {
  const items = [
    {
      id: "source:mercury",
      severity: "error" as const,
      title: "Mercury: last run failed",
      detail: "No detail was recorded.",
      href: "/settings/sources",
    },
    {
      id: "customers:at_risk",
      severity: "risk" as const,
      title: "2 clinics are at risk",
      detail: "The list gives each reason.",
      href: "/customers?health=at_risk",
    },
  ];

  test("the item is still said, as words and not a link", () => {
    as("sales", <AttentionList items={items} />);
    expect(links()).toEqual(["/customers?health=at_risk"]);
    const row = screen.getByText("Mercury: last run failed").closest("li")!;
    expect(row.textContent).toBe("Failed: Mercury: last run failedNo detail was recorded.");
  });

  test("the owner's list links every item", () => {
    render(<AttentionList items={items} />);
    expect(links()).toEqual(["/settings/sources", "/customers?health=at_risk"]);
  });
});

describe("the cash tile's missing balance", () => {
  const cash = { usd: 0, rate: null, ratePeriodStart: null, missing: ["kz" as const], parts: [] };

  test("someone who cannot type it in is told who does", () => {
    as("cofounder", <CashTile cash={cash} now={NOW} markets={["kz"]} />);
    expect(links()).toEqual([]);
    expect(
      screen.getByText("No Kazakhstan balance yet. The owner enters Kazakhstan's balance."),
    ).toBeTruthy();
  });

  test("the owner is offered the form, in the words used before", () => {
    const { container } = render(<CashTile cash={cash} now={NOW} markets={["kz"]} />);
    expect(links()).toEqual(["/finance?metric=cash&scope=kz#record-a-figure"]);
    expect(container.textContent).toContain("No Kazakhstan balance yet. Enter Kazakhstan's balance");
  });
});

describe("the Linear board before its first read", () => {
  const NEVER = { source: { state: null, message: null, lastOkAt: null }, issues: [] };

  test("a teammate is not sent to the owner's settings", () => {
    convex.setQuery(api.workTools.issues, NEVER);
    as("engineer", <LinearBoard />);
    expect(links()).toEqual([]);
    expect(screen.getByText("Linear has not been read yet. The owner sets it up.")).toBeTruthy();
  });

  test("the owner is", () => {
    convex.setQuery(api.workTools.issues, NEVER);
    render(<LinearBoard />);
    expect(screen.getByRole("link", { name: "Set it up" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
  });
});
