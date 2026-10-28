// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { areasOf, type Role } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { DEAL_COLUMNS } from "@/lib/pipeline/stages";
import { mockConvex } from "@/test-support/convex";
import SalesPage from "./page";

// The US deals as a table on /sales: the default for Startup, the board one
// click away, the view in the address. Kazakhstan's section is the board it
// always was, with nothing of the table's.

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW, nav } = vi.hoisted(() => ({
  NOW: Date.UTC(2026, 9, 15, 12),
  nav: { search: "", replace: (() => {}) as (url: string, options?: unknown) => void },
}));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (url: string, options?: unknown) => nav.replace(url, options) }),
  usePathname: () => "/sales",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const card = (id: string, market: "us" | "kz", extra: Record<string, unknown> = {}) => ({
  id,
  market,
  mirrored: market === "kz",
  source: market === "kz" ? "kz_crm" : "manual",
  name: id,
  contact: null,
  stage: "lead",
  sourceStage: null,
  amount: null,
  lastActivityAt: NOW,
  closedAt: null,
  nextStep: null,
  notes: null,
  ...(market === "us"
    ? { priority: "high", region: "TX", physicians: 59, locations: 29, sources: [] }
    : {}),
  ...extra,
});
const boardOf = (cards: ReturnType<typeof card>[]) =>
  Object.fromEntries(
    [...DEAL_COLUMNS.map((c) => c.id), "unmapped"].map((stage) => [
      stage,
      cards.filter((c) => c.stage === stage),
    ]),
  );
const US = boardOf([card("Austin Vertical", "us"), card("Boise Vertical", "us", { stage: "won" })]);
const KZ = boardOf([card("Almaty Dental", "kz")]);

let replace: ReturnType<typeof vi.fn>;
beforeAll(() => {
  window.CSS ??= { escape: (value: string) => value } as typeof CSS;
});
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  const convex = mockConvex();
  convex.setQueryBy(api.deals.board, (args) => ((args as { market: string }).market === "us" ? US : KZ));
  convex.setQuery(api.deals.archived, []);
  convex.setQuery(api.sources.list, []);
  nav.search = "";
  replace = vi.fn();
  nav.replace = replace;
});
afterEach(cleanup);

const as = (role: Role, companies: CompanyId[]) =>
  render(
    <ViewerProvider viewer={{ role, companies, areas: areasOf(role), email: null, name: null }}>
      <SalesPage />
    </ViewerProvider>,
  );
const sectionOf = (title: string) => screen.getByRole("region", { name: title });
const sent = (name: string) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([ref, args]) => getFunctionName(ref as never) === name && args !== "skip")
    .map(([, args]) => args);

describe("the US deals on /sales", () => {
  test("open as a table of the deals in play, with the board one click away", async () => {
    const user = userEvent.setup();
    as("sales", ["us"]);
    const us = sectionOf("US");
    const table = within(us).getByRole("table", { name: "US deals" });
    expect(within(table).getAllByRole("rowheader").map((th) => th.textContent)).toEqual([
      "Austin Vertical",
    ]);
    expect(within(us).getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(within(us).getByRole("button", { name: "Board" }));
    expect(replace).toHaveBeenCalledWith("/sales?view=board", { scroll: false });
  });

  test("?view=board draws the board, and Table goes back to the plain address", async () => {
    const user = userEvent.setup();
    nav.search = "view=board";
    as("sales", ["us"]);
    const us = sectionOf("US");
    expect(within(us).queryByRole("table", { name: "US deals" })).toBeNull();
    expect(within(us).getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(us).getByText("Austin Vertical")).toBeTruthy();
    await user.click(within(us).getByRole("button", { name: "Table" }));
    expect(replace).toHaveBeenCalledWith("/sales", { scroll: false });
  });

  test("the filters and the sort are read from the address and written back to it", async () => {
    const user = userEvent.setup();
    nav.search = "stage=closed&sort=name&dir=desc";
    as("sales", ["us"]);
    const table = screen.getByRole("table", { name: "US deals" });
    expect(within(table).getAllByRole("rowheader").map((th) => th.textContent)).toEqual([
      "Boise Vertical",
    ]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority" }), "high");
    expect(replace).toHaveBeenLastCalledWith(
      "/sales?stage=closed&priority=high&sort=name&dir=desc",
      { scroll: false },
    );
  });
});

describe("Kazakhstan's section", () => {
  test("someone on Globex alone gets the board as it was: no table, no switch, nothing archived asked for", () => {
    as("sales", ["kz"]);
    const kz = sectionOf("Kazakhstan");
    expect(within(kz).queryByRole("table")).toBeNull();
    expect(within(kz).queryByRole("group", { name: "Layout" })).toBeNull();
    expect(within(kz).getByText("Almaty Dental")).toBeTruthy();
    expect(sent("deals:archived")).toEqual([]);
    // Nor the US deals' intelligence (convex/dealIntel.ts), which would be refused.
    expect(sent("dealIntel:list")).toEqual([]);
    expect(sent("deals:board")).toEqual(expect.not.arrayContaining([{ market: "us" }]));
  });

  test("beside the US table, it keeps its board whatever the address says", () => {
    nav.search = "view=table&stage=all";
    as("sales", ["us", "kz"]);
    const kz = sectionOf("Kazakhstan");
    expect(within(kz).queryByRole("table")).toBeNull();
    expect(within(kz).getByText("Almaty Dental")).toBeTruthy();
    expect(within(sectionOf("US")).getByRole("table", { name: "US deals" })).toBeTruthy();
  });
});
