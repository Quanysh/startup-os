// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { FOCUSES, type Focus } from "@convex/lib/focus";
import { AREAS as EVERY_AREA, areasOf, type Area } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { EngineeringSection } from "@/components/dashboard/engineering-section";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { arrange, type BlockId } from "@/lib/dashboard/arrange";
import { mockConvex } from "@/test-support/convex";
import TodayPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));
// The owner's block holds a field that leads to the Assistant page.
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// The dashboard arranged for a role's focus: the order of its blocks, the
// line that says so, and the two blocks that came with it (my open tasks,
// engineering). What a block shows is its own tests' business; here it is
// which blocks are on the page, and in what order.

const NOW = new Date(2026, 9, 12, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;
const ME = "me@example.test";

/** Each block by the heading it wears. */
// Every area a teammate can hold. `personal` is the owner's alone, and with it the Brief block (below).
const AREAS = EVERY_AREA.filter((area) => area !== "personal");

const HEADINGS: Record<Exclude<BlockId, "money">, string> = {

  customers: "Customers",
  sales: "Sales pipeline",
  fundraising: "Fundraising",
  product: "Product",
  engineering: "Engineering",
  gtm: "Go to market",
  work: "Work",
  compliance: "Compliance",
};
type Shown = keyof typeof HEADINGS;
/** What arrange gives, as Today draws it: Money's figures are the strip's, not a block. */
const drawn = (ids: readonly BlockId[]) => ids.filter((id): id is Shown => id !== "money");
/** The company's blocks on the page, top to bottom, by id: each region under "The company". */
const blocks = (root: ParentNode = document) =>
  [...root.querySelectorAll("section[aria-labelledby] > h3")]
    .map((h) => (Object.keys(HEADINGS) as Shown[]).find((id) => HEADINGS[id] === h.textContent))
    .filter((id): id is Shown => id !== undefined);

let convex: ReturnType<typeof mockConvex>;
const show = (
  focus: Focus,
  areas: readonly Area[] = AREAS,
  more: { companies?: ("us" | "kz")[]; company?: "us" | "kz"; isOwner?: boolean; roleName?: string } = {},
) => {
  if (more.company) window.localStorage.setItem("startup-os:company", more.company);
  return render(
    <CompanyProvider>
      <ViewerProvider
        viewer={{
          role: more.isOwner ? "owner" : "custom",
          roleName: more.roleName ?? "Made-up role",
          focus,
          companies: more.companies ?? ["us", "kz"],
          areas,
          email: ME,
          name: null,
        }}
      >
        <TodayPage />
      </ViewerProvider>
    </CompanyProvider>,
  );
};
type Ref = Parameters<typeof getFunctionName>[0];
const sent = (ref: Ref) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called]) => getFunctionName(called as never) === getFunctionName(ref))
    .filter(([, args]) => args !== "skip");

const board = (backlog: unknown[] = [], done: unknown[] = []) => ({
  backlog,
  this_week: [],
  doing: [],
  done,
});

beforeEach(() => {
  convex = mockConvex();
  push.mockClear();
  vi.mocked(useQuery).mockClear();
  vi.mocked(useNow).mockReturnValue(NOW);
  convex.setQuery(api.metrics.scorecard, { tiles: [], sources: {} });
  convex.setQuery(api.targets.list, []);
  convex.setQuery(api.customers.list, { customers: [], lastPushAt: null });
  convex.setQuery(api.obligations.list, []);
  convex.setQuery(api.evidence.agreements, []);
  convex.setQuery(api.deals.board, {});
  convex.setQuery(api.investors.board, {});
  convex.setQuery(api.metrics.series, []);
  convex.setQuery(api.goals.list, []);
  convex.setQuery(api.tasks.board, board());
  convex.setQuery(api.workTools.pullRequests, { readAt: NOW, rows: [] });
  convex.setQuery(api.team.myGithub, { login: null });
  // The rest of Today: what needs the viewer and their own day.
  convex.setQuery(api.notifications.mine, { rows: [], more: false });
  convex.setQuery(api.notifications.unreadCount, 0);
  convex.setQuery(api.decisions.mineToRevisit, []);
  convex.setQuery(api.assistant.inbox, []);
  convex.setQuery(api.assistant.brief, null);
  convex.setQuery(api.tasks.openIssues, []);
  convex.setQuery(api.freshness.forPage, []);
  const ok = { state: "ok", message: null, lastOkAt: NOW };
  convex.setQuery(api.workTools.events, { source: ok, events: [] });
  convex.setQuery(api.workTools.needsReply, { source: ok, threads: [] });
  convex.setQuery(api.workTools.myIssues, { source: ok, issues: [] });
  convex.setQuery(api.workTools.meetings, { source: ok, meetings: [] });
  convex.setQuery(api.connect.status, { owner: false, token: null, tools: [] });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the dashboard, arranged for a focus", () => {
  test.each(FOCUSES)("%s, with every area: its blocks in its order, the lead first", (focus) => {
    show(focus, AREAS, { company: "us" });
    const { lead, rest } = arrange(focus, AREAS);
    expect(blocks()).toEqual(drawn([...lead, ...rest]));
    // What needs the viewer stays first for everyone; the company is last.
    const sections = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(sections[0]).toBe("Needs you");
    expect(sections.at(-1)).toBe("The company");
    // The lead blocks are apart from the rest, in a region of their own.
    const leadRegion = document.querySelector('[data-part="lead"]');
    expect(leadRegion === null ? [] : blocks(leadRegion)).toEqual(drawn(lead));
  });

  test("sales and engineering do not see the same page", () => {
    show("sales", AREAS, { company: "us" });
    const sales = blocks();
    cleanup();
    show("engineering", AREAS, { company: "us" });
    expect(sales.slice(0, 2)).toEqual(["sales", "gtm"]);
    expect(blocks().slice(0, 2)).toEqual(["engineering", "product"]);
  });

  test("a block whose area the person lacks is absent, with no shell and no 'no access' in its place", () => {
    // Arranged for sales, without Sales itself or the board.
    const areas = AREAS.filter((area) => area !== "sales" && area !== "board");
    show("sales", areas, { company: "us" });
    expect(blocks()).toEqual(drawn(arrange("sales", areas).rest));
    expect(blocks()).not.toContain("sales");
    expect(document.body.textContent).not.toMatch(/access/i);
    // And what it would have read was never asked for.
    expect(sent(api.deals.board)).toEqual([]);
    expect(sent(api.tasks.board)).toEqual([]);
  });

  test("an engineer arranged for finance is sent nothing of finance or payroll", () => {
    show("finance", areasOf("engineer"), { company: "us" });
    expect(blocks()).toEqual(["product", "engineering", "work"]);
    expect(screen.queryByText("Payroll")).toBeNull();
  });

  test("payroll has no block, for any focus, whatever is held: it is on /payroll", () => {
    for (const focus of ["finance", "founder"] as const) {
      cleanup();
      show(focus, [...AREAS, "payroll"], { company: "us", isOwner: focus === "founder" });
      expect(screen.queryByRole("region", { name: "Payroll" })).toBeNull();
    }
    const asked = vi.mocked(useQuery).mock.calls.map(([ref]) => getFunctionName(ref as never));
    expect(asked.filter((name) => name.startsWith("payroll:"))).toEqual([]);
  });

  test("a company rule still holds: Globex alone has no go to market, whatever the focus", () => {
    show("marketing", AREAS, { companies: ["kz"], company: "kz" });
    expect(blocks()).not.toContain("gtm");
    expect(blocks()).not.toContain("fundraising");
    expect(blocks()[0]).toBe("product");
  });
});

// The page mounts a block only for someone with its area. Each block also
// refuses for itself, so it is safe wherever it is put.
describe("a block mounted for someone without its area", () => {
  const alone = (block: React.ReactNode, areas: readonly Area[]) =>
    render(
      <ViewerProvider
        viewer={{ role: "custom", focus: "general", companies: ["us", "kz"], areas, email: ME, name: null }}
      >
        {block}
      </ViewerProvider>,
    );

  test("engineering: nothing drawn, and neither read is sent", () => {
    alone(<EngineeringSection />, AREAS.filter((area) => area !== "engineering"));
    expect(document.body.textContent).toBe("");
    expect(sent(api.workTools.pullRequests)).toEqual([]);
    expect(sent(api.team.myGithub)).toEqual([]);
  });

});

describe("the line under the title", () => {
  test("says what the page is arranged for, and who sets it", () => {
    show("sales", areasOf("sales"), { roleName: "Sales" });
    expect(
      screen.getByText("Arranged for Sales. The owner sets this on the Team page."),
    ).toBeTruthy();
    cleanup();
    show("founder", AREAS, { isOwner: true, roleName: "Owner" });
    expect(
      screen.getByText(
        "Arranged for Founder. You set what each role's pages are arranged for on the Team page.",
      ),
    ).toBeTruthy();
  });

  test("a role's name is shown as text", () => {
    show("customers", AREAS, { roleName: "<b>Clinic care</b>" });
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText(/your role: <b>Clinic care<\/b>/)).toBeTruthy();
  });
});

describe("engineering among the company's blocks", () => {
  const pr = (title: string, patch: Record<string, unknown> = {}) => ({
    repoId: "Made-Up-Org/app",
    number: 1,
    company: "us",
    title,
    url: "https://github.com/Made-Up-Org/app/pull/1",
    authorLogin: "made-up-me",
    draft: false,
    state: "open",
    createdAt: NOW - 9 * DAY,
    updatedAt: NOW - 9 * DAY,
    reviewDecision: "none",
    reviewersRequested: 0,
    reviewers: [],
    checks: "passing",
    ...patch,
  });
  const counts = () =>
    within(screen.getByRole("region", { name: "Engineering" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);

  test("the company's open and stuck pull requests, never the viewer's own, whatever their username", () => {
    convex.setQuery(api.team.myGithub, { login: "made-up-me" });
    convex.setQuery(api.workTools.pullRequests, {
      readAt: NOW,
      rows: [
        pr("mine"),
        pr("theirs", { authorLogin: "made-up-other", createdAt: NOW - DAY, updatedAt: NOW - DAY }),
        pr("asks me", { authorLogin: "made-up-other", reviewers: ["made-up-me"] }),
        pr("SECRET kz", { company: "kz" }),
      ],
    });
    show("engineering", AREAS, { company: "us" });
    expect(counts()).toEqual(["3 Open", "2 Stuck"]);
    const region = within(screen.getByRole("region", { name: "Engineering" }));
    expect(region.getByRole("link", { name: "2 pull requests stuck" }).getAttribute("href")).toBe(
      "/engineering?stuck=1",
    );
    expect(region.queryByText(/Yours|your review/)).toBeNull();
  });

  test("a list never read is said so, not counted as none", () => {
    convex.setQuery(api.workTools.pullRequests, { readAt: null, rows: [] });
    show("engineering", AREAS, { company: "us" });
    const region = screen.getByRole("region", { name: "Engineering" });
    expect(region.textContent).toContain("GitHub's pull requests have not been read yet.");
    expect(within(region).queryAllByRole("listitem")).toEqual([]);
  });

  test("without the engineering area: no block, and neither read is sent", () => {
    show("engineering", AREAS.filter((area) => area !== "engineering"), { company: "us" });
    expect(screen.queryByRole("region", { name: "Engineering" })).toBeNull();
    expect(sent(api.workTools.pullRequests)).toEqual([]);
    expect(sent(api.team.myGithub)).toEqual([]);
  });
});

