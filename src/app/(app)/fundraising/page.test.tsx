// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { INVESTOR_COLUMNS } from "@/lib/pipeline/stages";
import { mockConvex } from "@/test-support/convex";
import FundraisingPage from "./page";

// /fundraising: the board by default, the table a click away (the view in
// the address), every card that may move dragged, the sync chips on a card,
// and Retry. `investors.board`'s sync fields and `investors.retrySync`,
// `investors.archive` are the visible-sync branch's; mockConvex answers them
// by name until it lands.

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW, nav } = vi.hoisted(() => ({
  NOW: Date.UTC(2026, 9, 20, 12),
  nav: { search: "", replace: (() => {}) as (url: string, options?: unknown) => void },
}));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (url: string, options?: unknown) => nav.replace(url, options) }),
  usePathname: () => "/fundraising",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  stage: "meeting",
  amount: null,
  lastActivityAt: NOW,
  closedAt: null,
  nextStep: null,
  mirrored: true,
  source: "visible",
  contact: null,
  sourceStage: null,
  notes: null,
  createdBy: null,
  referralSource: null,
  sync: null,
  changedInVisible: false,
  editable: true,
  draggable: true,
  ...extra,
});
const BOARD = Object.fromEntries(
  [...INVESTOR_COLUMNS.map((c) => c.id), "unmapped"].map((stage) => [stage, [] as ReturnType<typeof card>[]]),
);
BOARD.meeting = [
  card("Example Ventures", { sync: { status: "pending", queuedAt: NOW } }),
  card("Sample Capital", { sync: { status: "failed", errorCode: "unmapped_stage", queuedAt: NOW } }),
  card("Held Partners", { draggable: false, editable: false }),
];
BOARD.contacted = [card("Made-up Angels", { stage: "contacted", changedInVisible: true })];

let convex: ReturnType<typeof mockConvex>;
let replace: ReturnType<typeof vi.fn>;
beforeAll(() => {
  window.CSS ??= { escape: (value: string) => value } as typeof CSS;
});
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.investors.board, BOARD);
  convex.setQuery(api.investors.archived, []);
  nav.search = "";
  replace = vi.fn();
  nav.replace = replace;
});
afterEach(cleanup);

const column = (title: string) =>
  within(screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section")!);

describe("/fundraising", () => {
  test("opens on the board; every card the server lets move has a grip", () => {
    render(<FundraisingPage />);
    expect(screen.getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Move Example Ventures" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move Held Partners" })).toBeNull();
  });

  test("a card says what it is waiting on from Visible", async () => {
    const user = userEvent.setup();
    render(<FundraisingPage />);
    const meeting = column("Meeting");
    expect(meeting.getByText("Syncing to Visible")).toBeTruthy();
    expect(meeting.getByText("Sync failed: Visible has no stage that matches")).toBeTruthy();
    expect(column("Contacted").getByText("Changed in Visible")).toBeTruthy();
    await user.click(meeting.getByRole("button", { name: "Retry sending Sample Capital to Visible" }));
    expect(convex.mutation(api.investors.retrySync)).toHaveBeenCalledWith({ id: "Sample Capital" });
  });

  test("each card links to the investor's page", () => {
    render(<FundraisingPage />);
    expect(
      screen.getByRole("link", { name: "Open the page of Example Ventures" }).getAttribute("href"),
    ).toBe("/fundraising/investors/Example%20Ventures");
  });

  test("a move goes through investors.move", async () => {
    const user = userEvent.setup();
    render(<FundraisingPage />);
    screen.getByRole("button", { name: "Move Example Ventures" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(convex.mutation(api.investors.move)).toHaveBeenCalledWith({
      id: "Example Ventures",
      stage: "diligence",
      index: 0,
    });
  });

  test("the editor edits a Visible investor's name and amount, and archives it", async () => {
    const user = userEvent.setup();
    render(<FundraisingPage />);
    await user.click(screen.getByRole("button", { name: "Example Ventures" }));
    expect(screen.getByLabelText("Investor or firm")).toBeTruthy();
    expect(screen.getByLabelText("Cheque (USD)")).toBeTruthy();
    expect(screen.queryByLabelText("Contact")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Archive it" }));
    expect(convex.mutation(api.investors.archive)).toHaveBeenCalledWith({ id: "Example Ventures" });
  });

  test("the Layout switch writes the table into the address; the table reads it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FundraisingPage />);
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(replace).toHaveBeenCalledWith("/fundraising?view=table", { scroll: false });
    unmount();
    nav.search = "view=table";
    render(<FundraisingPage />);
    expect(screen.getByRole("table", { name: "Investors" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archived investors" })).toBeTruthy();
  });
});
