// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { PARTNER_STAGES } from "@convex/lib/partnerStages";
import { areasOf, type Role } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { mockConvex } from "@/test-support/convex";
import PartnershipsPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// The layout is kept in the address.
const { search, replace } = vi.hoisted(() => ({ search: { value: "" }, replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/partnerships",
  useSearchParams: () => new URLSearchParams(search.value),
}));
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 18, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const card = (name: string, company: CompanyId, over: Record<string, unknown> = {}) => ({
  id: `${company}-${name}`,
  company,
  name,
  type: "channel",
  stage: "in_talks",
  owner: null,
  contact: null,
  contactRole: null,
  value: null,
  valueKind: null,
  notes: null,
  nextStep: null,
  nextStepOn: null,
  lastActivityAt: NOW,
  links: [],
  editedBy: null,
  ...over,
});
const boardOf = (...cards: ReturnType<typeof card>[]) => {
  const board: Record<string, unknown[]> = Object.fromEntries(PARTNER_STAGES.map((stage) => [stage, []]));
  for (const one of cards) board[one.stage as string]!.push(one);
  return board;
};

let convex: ReturnType<typeof mockConvex>;
beforeAll(() => {
  window.CSS ??= { escape: (value: string) => value } as typeof CSS;
});
beforeEach(() => {
  search.value = "";
  replace.mockClear();
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQueryBy(api.partnerships.board, (args) =>
    (args as { company: CompanyId }).company === "us"
      ? boardOf(card("Startup Reseller", "us", { nextStep: "Send pricing", nextStepOn: "2026-10-01", lastActivityAt: NOW - 20 * 86_400_000 }))
      : boardOf(card("Globex Referrer", "kz", { type: "referral", stage: "live" })),
  );
});
afterEach(cleanup);

const sent = () =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(
      ([ref, args]) => getFunctionName(ref as never) === getFunctionName(api.partnerships.board) && args !== "skip",
    )
    .map(([, args]) => JSON.stringify(args));
const as = (role: Role, companies: CompanyId[]) =>
  render(
    <ViewerProvider viewer={{ role, companies, areas: areasOf(role), email: null, name: null }}>
      <PartnershipsPage />
    </ViewerProvider>,
  );

describe("the partnerships page", () => {
  test("someone on Startup alone reads Startup's board and never asks for Globex's", () => {
    as("cofounder", ["us"]);
    expect(new Set(sent())).toEqual(new Set(['{"company":"us"}']));
    expect(screen.getByRole("heading", { level: 1, name: "Partnerships" })).toBeTruthy();
    expect(screen.getByText("Startup Reseller")).toBeTruthy();
    expect(screen.queryByText("Globex Referrer")).toBeNull();
  });

  test("someone on Globex alone reads its board only", () => {
    as("cofounder", ["kz"]);
    expect(new Set(sent())).toEqual(new Set(['{"company":"kz"}']));
    expect(screen.getByText("Globex Referrer")).toBeTruthy();
  });

  test("someone on both gets a section for each, named", () => {
    as("cofounder", ["us", "kz"]);
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(expect.arrayContaining(["Startup", "Globex"]));
  });

  test("the board is the default layout, with counts for each stage", () => {
    as("cofounder", ["us"]);
    expect(screen.getByRole("region", { name: /^In talks/ })).toBeTruthy();
    const counts = within(screen.getByRole("list", { name: "Partners by stage" }));
    expect(counts.getByText("In talks").textContent).toBe("In talks1");
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("the Layout switch writes the table to the address", async () => {
    as("cofounder", ["us"]);
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(replace).toHaveBeenCalledWith("/partnerships?view=table", { scroll: false });
  });

  test("the table view, with its CSV, marks the overdue step and opens the editor from a name", async () => {
    search.value = "view=table";
    as("cofounder", ["us"]);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Was due Oct 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download Startup partners as CSV" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Startup Reseller" }));
    expect(within(screen.getByRole("dialog")).getByLabelText("Next step")).toHaveProperty("value", "Send pricing");
  });

  test("a save goes to partnerships.update with the partner's id", async () => {
    search.value = "view=table";
    as("cofounder", ["us"]);
    await userEvent.click(screen.getByRole("button", { name: "Startup Reseller" }));
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText("Notes"), "Met");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.partnerships.update)).toHaveBeenCalledWith({ id: "us-Startup Reseller", notes: "Met" });
  });

  test("adding a partner creates it on the company in view, in the stage's column", async () => {
    as("cofounder", ["us"]);
    const contacted = screen.getByRole("region", { name: /^Contacted/ });
    await userEvent.click(within(contacted).getByRole("button", { name: "Add a partner" }));
    await userEvent.type(screen.getByLabelText("New partner in Contacted"), "New Co");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(convex.mutation(api.partnerships.create)).toHaveBeenCalledWith({
      company: "us",
      name: "New Co",
      stage: "contacted",
      type: "channel",
    });
  });
});
