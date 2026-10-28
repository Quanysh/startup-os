// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import type { PostRow } from "@/lib/linkedin/view";
import { mockConvex } from "@/test-support/convex";
import { LinkedinView } from "./linkedin-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// Local noon on Wednesday 2026-10-14.
const NOW = new Date(2026, 9, 14, 12).getTime();
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const nav = vi.hoisted(() => ({ query: "", replaced: [] as string[] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => "/linkedin",
  useRouter: () => ({ replace: (href: string) => nav.replaced.push(href) }),
}));

const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).getTime();
const NONE = { impressions: null, reactions: null, comments: null, reposts: null, clicks: null, followersGained: null };

// Every name, hook and figure is made up.
const post = (id: string, over: Partial<PostRow> = {}): PostRow => ({
  id: id as PostRow["id"],
  company: "us",
  account: "page",
  person: null,
  status: "idea",
  title: `Hook ${id}`,
  body: null,
  pillar: null,
  owner: null,
  plannedAt: null,
  publishedAt: null,
  link: null,
  byClient: null,
  updatedAt: 1,
  snapshots: [],
  ...over,
});

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  nav.query = "";
  nav.replaced = [];
  convex = mockConvex();
  convex.setQuery(api.linkedin.people, []);
  convex.setQuery(api.linkedin.list, {
    targets: [{ company: "us", postsPerWeek: 2, updatedAt: 1 }],
    posts: [
      post("out", {
        status: "published",
        title: "<b>Out</b> already",
        plannedAt: at(8),
        publishedAt: at(9),
        link: "https://www.linkedin.com/posts/made-up",
        pillar: "denials",
        snapshots: [
          { id: "s1" as never, day: "2026-10-12", ...NONE, impressions: 1000, reactions: 40, comments: 5, reposts: 5, byClient: null },
        ],
      }),
      // Scheduled for tomorrow with no draft: it needs you.
      post("bare", { status: "scheduled", plannedAt: at(15), title: "Bare tomorrow" }),
      post("ada", { company: "us", account: "person", person: "Ada Example", status: "draft", plannedAt: at(20), body: "Words.", title: "Ada draft" }),
    ],
  });
});
afterEach(cleanup);

const show = (companies: ("us" | "kz")[] = ["us"], areas = AREAS) =>
  render(
    <ViewerProvider viewer={{ role: "owner", companies, areas, email: "o@example.test", name: "Olga" }}>
      {/* Outside the provider no company is chosen and both are in view. */}
      {companies.length > 1 ? (
        <LinkedinView />
      ) : (
        <CompanyProvider allowed={companies}>
          <LinkedinView />
        </CompanyProvider>
      )}
    </ViewerProvider>,
  );

describe("the LinkedIn page", () => {
  test("says what needs a person: a scheduled post with no draft, and a week with nothing planned", () => {
    show(["us", "kz"]);
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByText(/No draft for "Bare tomorrow"/)).toBeTruthy();
    // Startup has a post in this week and the next; Globex has none in either.
    const items = within(needs).getAllByRole("listitem").map((item) => item.textContent);
    expect(items.filter((text) => text?.includes("No post planned"))).toHaveLength(2);
    expect(items.some((text) => text?.includes("Globex · this week"))).toBe(true);
    expect(items.some((text) => text?.includes("Startup · this week"))).toBe(false);
  });

  test("stats: last 30 days totals from the latest figures, the rate, and the cadence against the target", () => {
    show();
    const stats = screen.getByRole("region", { name: "Stats" });
    expect(within(stats).getAllByText("1,000").length).toBeGreaterThan(0);
    const rate = within(stats).getByText("Engagement rate").closest("div");
    expect(rate?.textContent).toContain("5.0%");
    // A figure nobody gave reads as unknown, never 0.
    expect(within(stats).getAllByText("Not read yet").length).toBeGreaterThan(0);
    expect(within(stats).getByRole("heading", { name: "Top posts by engagement rate" })).toBeTruthy();
    expect(within(stats).getByLabelText("Target: posts a week")).toHaveProperty("value", "2");
    expect(within(stats).getByText(/against 2/)).toBeTruthy();
  });

  test("the calendar puts a post on its day, and what was typed stays text", () => {
    show();
    const october = screen.getByRole("tabpanel", { name: "Month" });
    const day = within(october).getAllByRole("region", { name: "Oct 9" })[0]!;
    expect(within(day).getByText("<b>Out</b> already")).toBeTruthy();
    expect(day.querySelector("b")).toBeNull();
    expect(within(day).getByText("Published:")).toBeTruthy();
  });

  test("the week view lists the seven days, and a step goes into the address", async () => {
    nav.query = "view=week";
    show();
    const week = screen.getByRole("tabpanel", { name: "Week" });
    expect(within(week).getAllByRole("region")).toHaveLength(7);
    await userEvent.setup().click(screen.getByRole("button", { name: "Next week" }));
    expect(nav.replaced.at(-1)).toBe("/linkedin?view=week&day=2026-10-21");
  });

  test("the table has a row a post, links only to LinkedIn, and a CSV download", () => {
    show();
    const table = screen.getByRole("table", { name: "LinkedIn posts, newest first" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    const link = within(table).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://www.linkedin.com/posts/made-up");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getAllByRole("button", { name: /CSV/ }).length).toBeGreaterThan(0);
    expect(within(table).getByText("Ada Example")).toBeTruthy();
  });

  test("a filter goes into the address and narrows the table", async () => {
    show();
    await userEvent.setup().selectOptions(screen.getByLabelText("Status"), "draft");
    expect(nav.replaced.at(-1)).toBe("/linkedin?status=draft");
    cleanup();
    nav.query = "status=draft";
    show();
    expect(within(screen.getByRole("table", { name: "LinkedIn posts, newest first" })).getAllByRole("row")).toHaveLength(2);
  });

  test("adding a post sends the form's fields to the page's own function", async () => {
    show();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Add a post" })[0]!);
    const form = screen.getByRole("form", { name: "Add a post" });
    await user.type(within(form).getByLabelText("Hook: the first line"), "Why denials start");
    await user.click(within(form).getByRole("button", { name: "Add the post" }));
    expect(convex.mutation(api.linkedin.save)).toHaveBeenCalledWith(
      expect.objectContaining({ company: "us", account: "page", status: "idea", title: "Why denials start", body: null, plannedAt: null, link: null }),
    );
  });

  test("a published post opens with its figures and a form for the next", async () => {
    show();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open <b>Out</b> already" }));
    const figures = screen.getByRole("region", { name: "Figures" });
    expect(within(figures).getByRole("table")).toBeTruthy();
    expect(within(figures).getByRole("form", { name: "Add figures" })).toBeTruthy();
  });

  test("waits for the list before showing anything", () => {
    convex.setQuery(api.linkedin.list, undefined);
    show();
    expect(screen.getByTestId("linkedin-loading")).toBeTruthy();
    expect(vi.mocked(useQuery).mock.calls.some(([ref]) => getFunctionName(ref as never) === getFunctionName(api.linkedin.list))).toBe(true);
  });
});
