// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { areasOf, type Role } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { mockConvex } from "@/test-support/convex";
import { InvestorPage } from "./investor-page";

// One investor's page (/fundraising/investors/[id]): its fields with the
// board's edit rules, stage, next step and notes, its sync history (times,
// statuses and codes, nothing of Visible's), and its Outcomes. Startup's only.
// `investors.get`, `investors.syncHistory`, `archive`, `restore` and
// `retrySync` are the visible-sync branch's; mockConvex answers them by name.

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW, replace } = vi.hoisted(() => ({
  NOW: Date.UTC(2026, 9, 20, 12),
  replace: { fn: (_url: string) => {} },
}));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: (url: string) => replace.fn(url) }) }));

const DAY = 86_400_000;
const investor = (extra: Record<string, unknown> = {}) => ({
  id: "inv1",
  name: "Example Ventures",
  stage: "diligence",
  amount: 250_000,
  lastActivityAt: NOW - 3 * DAY,
  closedAt: null,
  nextStep: "Send the data room",
  mirrored: true,
  source: "visible",
  contact: "Sam Example",
  sourceStage: "Due diligence",
  notes: "Made-up note",
  referralSource: null,
  sync: { status: "failed", errorCode: "unmapped_stage", queuedAt: NOW - DAY },
  changedInVisible: false,
  editable: true,
  draggable: true,
  archived: false,
  ...extra,
});
const HISTORY = [
  { at: NOW - 2 * DAY, status: "pending" },
  { at: NOW - DAY, status: "failed", errorCode: "unmapped_stage" },
];

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.investors.get, investor());
  convex.setQuery(api.investors.syncHistory, HISTORY);
  convex.setQuery(api.outcomes.forSubject, []);
  replace.fn = vi.fn();
});
afterEach(cleanup);

const as = (role: Role, companies: CompanyId[], id = "inv1") =>
  render(
    <ViewerProvider viewer={{ role, companies, areas: areasOf(role), email: null, name: null }}>
      <InvestorPage investorId={id} />
    </ViewerProvider>,
  );
const asked = (name: string) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([ref, args]) => getFunctionName(ref as never) === name && args !== "skip")
    .map(([, args]) => args);

describe("InvestorPage", () => {
  test("the investor: name, stage, sync state, and the fields as the board holds them", () => {
    as("owner", ["us", "kz"]);
    expect(screen.getByRole("heading", { level: 1, name: "Example Ventures" })).toBeTruthy();
    expect(screen.getByText("Diligence")).toBeTruthy();
    expect(screen.getByText("Sync failed: Visible has no stage that matches")).toBeTruthy();
    const facts = screen.getByRole("region", { name: "On the board" });
    expect(within(facts).getByText("Sam Example")).toBeTruthy();
    expect(within(facts).getByText("$250K")).toBeTruthy();
    expect(within(facts).getByText("Send the data room")).toBeTruthy();
    expect(within(facts).getByText("3 days ago")).toBeTruthy();
    expect(within(facts).getByText("Visible")).toBeTruthy();
    expect(within(facts).getByText("Made-up note")).toBeTruthy();
    expect(asked("investors:get")).toContainEqual({ id: "inv1" });
  });

  test("the sync history: when, what became of it, and why in words, nothing else", () => {
    as("owner", ["us"]);
    const history = screen.getByRole("table", { name: "Sync history" });
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Queued");
    expect(rows[1]!.textContent).toContain("Failed");
    expect(rows[1]!.textContent).toContain("Visible has no stage that matches");
  });

  test("Retry queues a failed send again", async () => {
    const user = userEvent.setup();
    as("owner", ["us"]);
    await user.click(screen.getByRole("button", { name: "Retry sending Example Ventures to Visible" }));
    expect(convex.mutation(api.investors.retrySync)).toHaveBeenCalledWith({ id: "inv1" });
  });

  test("Edit opens the board's editor with its rules: name and amount yes, contact no", async () => {
    const user = userEvent.setup();
    as("owner", ["us"]);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Investor or firm")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Contact")).toBeNull();
    await user.clear(within(dialog).getByLabelText("Cheque (USD)"));
    await user.type(within(dialog).getByLabelText("Cheque (USD)"), "300000");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.investors.update)).toHaveBeenCalledWith({ id: "inv1", amount: 300_000 });
  });

  test("Archive asks first; an archived investor says so and offers Restore, not Edit", async () => {
    const user = userEvent.setup();
    as("owner", ["us"]);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Archive it" }));
    expect(convex.mutation(api.investors.archive)).toHaveBeenCalledWith({ id: "inv1" });
    cleanup();
    convex.setQuery(api.investors.get, investor({ archived: true }));
    as("owner", ["us"]);
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(convex.mutation(api.investors.restore)).toHaveBeenCalledWith({ id: "inv1" });
  });

  test("its Outcomes are asked for as an investor's", () => {
    as("owner", ["us"]);
    expect(screen.getByRole("heading", { name: "Outcomes" })).toBeTruthy();
    expect(asked("outcomes:forSubject")).toContainEqual({ kind: "investor", id: "inv1" });
  });

  test("an id that is no investor is said in one line", () => {
    convex.setQuery(api.investors.get, null);
    as("owner", ["us"], "gone");
    expect(screen.getByRole("heading", { name: "This investor is not here" })).toBeTruthy();
  });

  test("someone not on Startup is told so, and nothing is asked for", () => {
    as("cofounder", ["kz"]);
    expect(screen.getByRole("heading", { name: "Nothing here for Globex" })).toBeTruthy();
    expect(asked("investors:get")).toEqual([]);
    expect(asked("investors:syncHistory")).toEqual([]);
  });
});
