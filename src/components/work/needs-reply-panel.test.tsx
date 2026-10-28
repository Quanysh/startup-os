// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { NeedsReplyPanel } from "./needs-reply-panel";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed clock: the shared one is read once per module and would drift between tests.
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;

// Every name, address and subject here is made up.
const thread = (threadId: string, group: string, hoursAgo: number, over: object = {}) => ({
  kind: "mail",
  threadId,
  fromName: "Ada Example",
  fromAddress: "ada@example-fund.test",
  subject: `Made-up subject ${threadId}`,
  lastMessageAt: NOW - hoursAgo * HOUR,
  group,
  ...over,
});
const read = (over: object = {}) => ({ state: "ok", message: null, lastOkAt: NOW - 5 * 60_000, ...over });

let convex: ReturnType<typeof mockConvex>;
const show = (threads: object[], source: object = read()) => {
  convex.setQuery(api.workTools.needsReply, { source, threads });
  return render(<NeedsReplyPanel />);
};
const paragraphs = (container: HTMLElement) =>
  [...container.querySelectorAll("p")].map((p) => p.textContent?.replace(/\s+/g, " ").trim());

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("NeedsReplyPanel", () => {
  test("is titled, and shows a skeleton while loading", () => {
    render(<NeedsReplyPanel />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Mail to reply to");
    expect(screen.getByTestId("needs-reply-loading")).toBeTruthy();
  });

  test("never read: says so and links to the settings", () => {
    const { container } = show([], { state: null, message: null, lastOkAt: null });
    expect(paragraphs(container)).toEqual(["Gmail has not been read yet. Set it up"]);
    expect(screen.getByRole("link", { name: "Set it up" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    // Not "nothing is waiting": nothing is known.
    expect(screen.queryByText("No mail is waiting on a reply.")).toBeNull();
  });

  test("turned off or disconnected (no good read on record) reads the same way", () => {
    const { container } = show([], {
      state: "not_configured",
      message: "Connect Google under Settings → Work tools.",
      lastOkAt: null,
    });
    expect(paragraphs(container)[0]).toBe("Gmail has not been read yet. Set it up");
  });

  test("nothing waiting, with the footer", () => {
    const { container } = show([]);
    expect(paragraphs(container)).toEqual([
      "No mail is waiting on a reply.",
      "Read 5m ago. Senders and subjects only; archive or reply in Gmail to clear a thread.",
    ]);
  });

  test("groups in the order Investors, Customers, Other, each oldest first, with counts", () => {
    show([
      thread("0c", "other", 30),
      thread("0a", "investor", 20),
      thread("0d", "customer", 9),
      thread("0b", "investor", 2),
      thread("0e", "other", 1),
    ]);
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Investors (2)",
      "Customers (1)",
      "Other (2)",
    ]);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href")?.split("/").pop())).toEqual([
      "0a",
      "0b",
      "0d",
      "0c",
      "0e",
    ]);
  });

  test("a group with nothing in it is not rendered", () => {
    show([thread("0a", "customer", 2)]);
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Customers (1)",
    ]);
  });

  test("a row shows sender, subject and age, and links to the thread by its id alone", () => {
    show([thread("19a0b1c2", "investor", 3)]);
    const link = screen.getByRole("link");
    expect(within(link).getByText("Ada Example").getAttribute("title")).toBe("ada@example-fund.test");
    expect(within(link).getByText("Made-up subject 19a0b1c2")).toBeTruthy();
    expect(within(link).getByText("3h ago")).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://mail.google.com/mail/#inbox/19a0b1c2");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    // Nothing about the sender or the subject travels in the address.
    expect(link.getAttribute("href")).not.toContain("ada");
    expect(link.getAttribute("href")).not.toContain("Made-up");
  });

  test("a sender with no name is shown by address", () => {
    show([thread("0a", "other", 3, { fromName: "" })]);
    expect(screen.getByText("ada@example-fund.test").getAttribute("title")).toBe(
      "ada@example-fund.test",
    );
  });

  test("an id that is not a Gmail thread id is shown but never made into a link", () => {
    show([thread("../../settings", "other", 3)]);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Made-up subject ../../settings")).toBeTruthy();
  });

  test.each([["error"], ["empty"], ["not_configured"]])(
    "when the last read did not succeed (%s) it says the list may be out of date, before the footer",
    (state) => {
      const { container } = show(
        [thread("0a", "other", 3)],
        read({ state, message: "Gmail answered 500 for the inbox.", lastOkAt: NOW - 2 * HOUR }),
      );
      expect(paragraphs(container)).toEqual([
        "The last read failed, so this list may be out of date.",
        "Read 2h ago. Senders and subjects only; archive or reply in Gmail to clear a thread.",
      ]);
      // The run's message stays on the settings page; this panel does not repeat it.
      expect(container.textContent).not.toContain("answered 500");
    },
  );

  test("a good read carries no warning", () => {
    show([thread("0a", "other", 3)]);
    expect(screen.queryByText("The last read failed, so this list may be out of date.")).toBeNull();
  });
});
