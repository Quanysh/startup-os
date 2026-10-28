// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { areasOf, type Area, type Role } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { DEAL_COLUMNS, INVESTOR_COLUMNS } from "@/lib/pipeline/stages";
import { mockConvex } from "@/test-support/convex";
import FundraisingPage from "../fundraising/page";
import SalesPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// The US deals' view is kept in the address (sales-table.page.test.tsx).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/sales",
  useSearchParams: () => new URLSearchParams(),
}));
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;
/** A line under a board saying when its source was read: the header's job now. */
const READ_AGO = /read \d|read just now/;
const CRM_READ = {
  id: "kz_crm",
  label: "Kazakhstan CRM",
  cadence: { kind: "pushed", everyDays: 1 },
  lastOkAt: NOW - HOUR,
  lastRunAt: NOW - HOUR,
  state: "ok",
  failureKey: null,
};
const US_DEAL = {
  id: "deal-1",
  mirrored: false,
  source: "manual",
  name: "Example Clinic",
  contact: null,
  stage: "lead",
  sourceStage: null,
  amount: null,
  lastActivityAt: null as number | null,
  closedAt: null,
  nextStep: null,
  notes: null,
  priority: null,
  region: null,
  physicians: null,
  locations: null,
  sources: [],
};
const emptyBoard = (columns: readonly { id: string }[]) =>
  Object.fromEntries([...columns.map((c) => c.id), "unmapped"].map((id) => [id, []]));
const READ = { state: "ok", message: null, lastRunAt: NOW - HOUR, lastOkAt: NOW - HOUR };
const SOURCES = ["kz_crm", "visible"].map((id) => ({
  id,
  configured: true,
  missingEnv: [],
  status: READ,
}));

let convex: ReturnType<typeof mockConvex>;
beforeAll(() => {
  // jsdom has no CSS.escape, which the board uses to find a moved card's grip.
  window.CSS ??= { escape: (value: string) => value } as typeof CSS;
});
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.deals.board, emptyBoard(DEAL_COLUMNS));
  convex.setQuery(api.investors.board, emptyBoard(INVESTOR_COLUMNS));
  // What the server would give the owner, or a teammate with the `settings`
  // area. Anyone else it refuses, which breaks the page: so nobody else may ask.
  convex.setQuery(api.sources.list, SOURCES);
});
afterEach(cleanup);

/** Every argument a query was asked with, "skip" included. */
const asked = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called]) => getFunctionName(called as never) === getFunctionName(ref))
    .map(([, args]) => args);
const sent = (ref: Parameters<typeof getFunctionName>[0]) =>
  asked(ref).filter((args) => args !== "skip");

const as = (role: Role, companies: CompanyId[], page: React.ReactNode) =>
  render(
    <ViewerProvider viewer={{ role, companies, areas: areasOf(role), email: null, name: null }}>
      {page}
    </ViewerProvider>,
  );
const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("the sales page for a teammate", () => {
  test("someone on Globex alone reads Kazakhstan's board only, and never the sources", () => {
    const { container } = as("sales", ["kz"], <SalesPage />);
    expect(asked(api.sources.list).length).toBeGreaterThan(0);
    expect(sent(api.sources.list)).toEqual([]);
    expect(new Set(sent(api.deals.board).map((args) => JSON.stringify(args)))).toEqual(
      new Set(['{"market":"kz"}']),
    );
    expect(headings()).toContain("Kazakhstan");
    expect(headings()).not.toContain("US");
    // The board is there and says where it is from; when it was read is the
    // page header's (freshness.forPage), never a line here.
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(screen.getByText(/^Mirrored from the Kazakhstan CRM\. Cards here cannot be dragged or edited\./)).toBeTruthy();
    expect(screen.queryByText(READ_AGO)).toBeNull();
  });

  test("someone on Startup alone never asks for Kazakhstan's deals", () => {
    as("cofounder", ["us"], <SalesPage />);
    expect(new Set(sent(api.deals.board).map((args) => JSON.stringify(args)))).toEqual(
      new Set(['{"market":"us"}']),
    );
    expect(headings()).not.toContain("Kazakhstan");
    expect(sent(api.sources.list)).toEqual([]);
  });

  test("someone on both reads both boards, still without the sources", () => {
    const { container } = as("sales", ["us", "kz"], <SalesPage />);
    expect(sent(api.sources.list)).toEqual([]);
    expect(headings()).toEqual(expect.arrayContaining(["US", "Kazakhstan"]));
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(screen.queryByText(READ_AGO)).toBeNull();
  });

  // Until 2026-10-15 the owner and a holder of Sources had "Mirrored from …,
  // read 1h ago" here: the time moved to the header, for everyone with the page.
  test("the owner is asked for the sources, and is not told the read time twice", () => {
    render(<SalesPage />);
    expect(sent(api.sources.list).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Mirrored from the Kazakhstan CRM\./)).toBeTruthy();
    expect(screen.queryByText(READ_AGO)).toBeNull();
  });

  test("the header says when, for the company in view: the CRM for Globex", () => {
    convex.setQuery(api.freshness.forPage, [CRM_READ]);
    as("sales", ["kz"], <CompanyProvider allowed={["kz"]}><SalesPage /></CompanyProvider>);
    expect(sent(api.freshness.forPage)).toContainEqual({ page: "sales", company: "kz" });
    // A source pushed once a day is said by the day (src/lib/source-freshness.ts, `dayWords`).
    expect(
      screen.getByRole("button", { name: /^Updated (this morning|this afternoon|this evening|yesterday), on time\./ }),
    ).toBeTruthy();
  });

  test("and for Startup, whose deals are typed in here, when one last changed", () => {
    convex.setQuery(api.freshness.forPage, []);
    convex.setQueryBy(api.deals.board, () => ({
      ...emptyBoard(DEAL_COLUMNS),
      lead: [{ ...US_DEAL, lastActivityAt: NOW - 3 * HOUR }],
    }));
    as("sales", ["us"], <CompanyProvider allowed={["us"]}><SalesPage /></CompanyProvider>);
    expect(screen.getByRole("button", { name: /^Typed in · last change 3 hours ago\./ })).toBeTruthy();
  });

  test("so is a teammate who was given Sources and Telegram, and nobody with another sensitive page", () => {
    const withAreas = (areas: Area[]) =>
      render(
        <ViewerProvider
          viewer={{ role: "sales", companies: ["kz"], areas, email: null, name: null }}
        >
          <SalesPage />
        </ViewerProvider>,
      );
    withAreas(["sales", "settings"]);
    expect(sent(api.sources.list).length).toBeGreaterThan(0);
    cleanup();
    vi.mocked(useQuery).mockClear();
    withAreas(["sales", "payroll", "team"]);
    expect(sent(api.sources.list)).toEqual([]);
    expect(screen.queryByText(READ_AGO)).toBeNull();
  });
});

describe("the fundraising page for a teammate", () => {
  test("a co-founder gets the board and never asks for the sources", () => {
    const { container } = as("cofounder", ["us", "kz"], <FundraisingPage />);
    expect(asked(api.sources.list).length).toBeGreaterThan(0);
    expect(sent(api.sources.list)).toEqual([]);
    expect(sent(api.investors.board).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Fundraising");
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(screen.queryByText(/Mirrored from/)).toBeNull();
  });

  // Until 2026-10-15 the owner had "Mirrored from Visible, read 1h ago" here.
  test("the header says how recently Visible was read, to anyone with the page", () => {
    convex.setQuery(api.freshness.forPage, [{ ...CRM_READ, id: "visible", label: "Visible" }]);
    as("cofounder", ["us"], <CompanyProvider allowed={["us"]}><FundraisingPage /></CompanyProvider>);
    expect(sent(api.freshness.forPage)).toContainEqual({ page: "fundraising", company: "us" });
    // A source pushed once a day is said by the day (src/lib/source-freshness.ts, `dayWords`).
    expect(
      screen.getByRole("button", { name: /^Updated (this morning|this afternoon|this evening|yesterday), on time\./ }),
    ).toBeTruthy();
    expect(screen.queryByText(READ_AGO)).toBeNull();
  });
});
