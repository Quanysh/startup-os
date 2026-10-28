// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import type { Reading } from "@/lib/source-freshness";
import { mockConvex } from "@/test-support/convex";
import { FreshnessIndicator, PageFreshness, TypedFreshness } from "./freshness-indicator";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const NOW = Date.UTC(2026, 9, 15, 12);
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeAll(() => {
  // Radix measures its popover; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const mercury: Reading = {
  id: "mercury",
  label: "Mercury",
  cadence: { kind: "daily", hourUtc: 6, minuteUtc: 0 },
  lastOkAt: NOW - 2 * HOUR,
  lastRunAt: NOW - 2 * HOUR,
  failureKey: null,
};
const workbook: Reading = {
  id: "cfo_workbook",
  label: "CFO workbook",
  cadence: { kind: "pushed", everyDays: 31 },
  lastOkAt: NOW - 40 * DAY,
  lastRunAt: NOW - 40 * DAY,
  failureKey: null,
};

const OWNER: ViewerProfile = { role: "owner", companies: ["us", "kz"], areas: ["finance", "settings", "today"], email: null, name: null };
const SALES: ViewerProfile = { role: "sales", companies: ["kz"], areas: ["sales"], email: null, name: null };

function wrap(node: ReactNode, viewer: ViewerProfile = OWNER, allowed: ("us" | "kz")[] = ["us", "kz"]) {
  return render(
    <ViewerProvider viewer={viewer}>
      <CompanyProvider allowed={allowed}>{node}</CompanyProvider>
    </ViewerProvider>,
  );
}

const trigger = () => screen.getByRole("button", { name: /Show where this page's figures come from/ });

describe("FreshnessIndicator", () => {
  test("nothing until there is something to say", () => {
    const { container } = wrap(<FreshnessIndicator readings={undefined} />);
    expect(container.textContent).toBe("");
    cleanup();
    expect(wrap(<FreshnessIndicator readings={[]} />).container.textContent).toBe("");
  });

  test("one source on time: when, and the full sentence for a screen reader", () => {
    wrap(<FreshnessIndicator readings={[mercury]} />);
    expect(trigger().textContent).toBe("Updated 2 hours ago");
    expect(trigger().getAttribute("aria-label")).toBe(
      "Updated 2 hours ago, on time. Show where this page's figures come from.",
    );
  });

  test("several: the oldest, and the late one said in words beside the dot", () => {
    wrap(<FreshnessIndicator readings={[mercury, workbook]} />);
    expect(trigger().textContent).toBe("Oldest source updated 40 days ago · 1 late");
  });

  test("opens with the keyboard and lists each source, oldest first, with its cadence and state", async () => {
    const user = userEvent.setup();
    wrap(<FreshnessIndicator readings={[mercury, { ...workbook, failureKey: "failed" }]} />);
    await user.tab();
    expect(document.activeElement).toBe(trigger());
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    const items = within(dialog).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByText(/Mercury|CFO workbook/).textContent)).toEqual([
      "CFO workbook",
      "Mercury",
    ]);
    expect(within(items[0]!).getByText("Failed")).toBeTruthy();
    expect(
      within(items[0]!).getByText("The last read failed, so what is shown is from the last good read."),
    ).toBeTruthy();
    expect(within(items[0]!).getByText("Pushed, expected monthly.")).toBeTruthy();
    expect(within(items[1]!).getByText("On time")).toBeTruthy();
    expect(within(items[1]!).getByText(/^Read daily at about \d\d:00\.$/)).toBeTruthy();
    expect(within(items[1]!).getByText(/^Last good read Oct 15, \d\d:00, 2 hours ago\.$/)).toBeTruthy();
    // A holder of `settings` is shown where the runs are.
    expect(within(items[1]!).getByRole("link", { name: "Settings › Sources" }).getAttribute("href")).toBe(
      "/settings/sources",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("no link to Settings › Sources for a viewer without it", async () => {
    const user = userEvent.setup();
    wrap(<FreshnessIndicator readings={[mercury]} />, SALES, ["kz"]);
    await user.click(trigger());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  test("a work tool on Today leads to the viewer's own Connections", async () => {
    const user = userEvent.setup();
    const gmail: Reading = { ...mercury, id: "gmail", label: "Gmail", cadence: { kind: "pushed", everyDays: 1 } };
    const teammate: ViewerProfile = { ...SALES, areas: ["today"] };
    wrap(<FreshnessIndicator readings={[gmail]} page="today" />, teammate, ["kz"]);
    await user.click(trigger());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Settings › Connections" })).toBeTruthy();
  });
});

test("the shared Linear board's source is the owner's connection: a teammate is shown no link to it", async () => {
  const user = userEvent.setup();
  const linear: Reading = { ...mercury, id: "linear", label: "Linear", cadence: { kind: "every", minutes: 15 } };
  // Today and the board: their own Connections page is not where the shared board is read.
  const teammate: ViewerProfile = { ...SALES, areas: ["board", "today"] };
  wrap(<FreshnessIndicator readings={[linear]} page="board_linear" />, teammate, ["kz"]);
  await user.click(trigger());
  expect(within(await screen.findByRole("dialog")).queryByRole("link")).toBeNull();
  cleanup();
  // The owner, whose it is, is.
  wrap(<FreshnessIndicator readings={[linear]} page="board_linear" />);
  await user.click(trigger());
  expect(
    within(await screen.findByRole("dialog")).getByRole("link", { name: "Settings › Connections" }),
  ).toBeTruthy();
});

describe("PageFreshness", () => {
  test("asks for the page in the company in view, and adds what the page worked out", () => {
    convex.setQueryBy(api.freshness.forPage, (args) =>
      (args as { company: string }).company === "kz" ? [workbook] : [mercury],
    );
    wrap(<PageFreshness page="finance" />, OWNER, ["kz"]);
    expect(trigger().textContent).toBe("Updated 40 days ago · late");
  });

  test("a page typed in here alone: the last change, with no colour", () => {
    convex.setQuery(api.freshness.forPage, []);
    wrap(<PageFreshness page="sales" extra={[{ ...workbook, id: "typed", label: "Deals", cadence: { kind: "typed" }, lastOkAt: NOW - 3 * DAY }]} />);
    expect(trigger().textContent).toBe("Typed in · last change 3 days ago");
  });
});

describe("TypedFreshness", () => {
  test("says when the newest row changed", () => {
    wrap(<TypedFreshness label="Cost lines" at={NOW - 5 * HOUR} />);
    expect(trigger().textContent).toBe("Typed in · last change 5 hours ago");
  });
  test("and that nothing is typed in yet", () => {
    wrap(<TypedFreshness label="Cost lines" at={null} />);
    expect(trigger().textContent).toBe("Nothing typed in yet");
  });
  test("nothing while the rows load", () => {
    expect(wrap(<TypedFreshness label="Cost lines" at={undefined} />).container.textContent).toBe("");
  });
});
