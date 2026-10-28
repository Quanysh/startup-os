// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import AssistantPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => Date.UTC(2026, 9, 14, 6) }));
// The chat keeps the open conversation in the address.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("the Assistant page", () => {
  test("chat first, then the briefs, the week and the switches: no approvals of its own", () => {
    render(<AssistantPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Assistant");
    expect(document.body.textContent).toContain("Only you can open this page.");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Chat",
      "Brief archive",
      "This week",
      "Agents",
    ]);
  });

  test("what waits is one line to /approvals, with the one count of both companies", () => {
    convex.setQuery(api.assistant.inbox, [{ id: "p1" }, { id: "a1" }]);
    render(<AssistantPage />);
    const link = screen.getByRole("link", { name: /2 waiting/ });
    expect(link.getAttribute("href")).toBe("/approvals");
    expect(link.textContent).toContain("Approvals");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  test("one chat: no second Ask section, and one field to ask in", () => {
    convex.setQuery(api.chat.threads, []);
    convex.setQuery(api.chat.runner, { checkedInAt: null, everyMs: null });
    render(<AssistantPage />);
    expect(screen.queryByRole("heading", { name: "Ask" })).toBeNull();
    expect(screen.getAllByRole("textbox", { name: "Your question" })).toHaveLength(1);
  });

  test("whether Claude's Mac is there is said in the page's header", () => {
    convex.setQuery(api.chat.runner, { checkedInAt: null, everyMs: null });
    render(<AssistantPage />);
    const header = within(document.querySelector("header")!);
    expect(header.getByTestId("runner-status")).toBeTruthy();
    expect(screen.getAllByTestId("runner-status")).toHaveLength(1);
  });

  test("it ships only what works: no section that says something is coming", () => {
    render(<AssistantPage />);
    expect(document.body.textContent).not.toMatch(/coming soon|next step|not yet available|arrives/i);
  });

  test("the connection and the record of calls are a link away, not on this page", () => {
    render(<AssistantPage />);
    const link = screen.getByRole("link", { name: "Connected clients and recent calls" });
    expect(link.getAttribute("href")).toBe("/settings/connections");
    expect(screen.queryByRole("heading", { name: "Connect Claude" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recent calls" })).toBeNull();
  });
});
