// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { OutcomesTimeline } from "./outcomes-timeline";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const row = (over: Record<string, unknown>) => ({
  id: "o1",
  company: "us",
  by: "growth",
  subject: { kind: "deal", id: "d1" },
  play: "cold email v2",
  channel: "email",
  result: "worked",
  signal: "no_reply",
  evidence: "<b>Made-up</b> reply.",
  actedOn: "2026-10-10",
  observedOn: null,
  proposalId: null,
  updatedAt: 1,
  ...over,
});

describe("OutcomesTimeline", () => {
  test("each outcome, newest first as sent: its result, play, bot, signal and evidence as text", () => {
    convex.setQuery(api.outcomes.forSubject, [row({}), row({ id: "o2", result: "pending", play: "intro call", signal: null })]);
    render(<OutcomesTimeline kind="deal" id="d1" />);
    expect(screen.getByRole("heading", { name: "Outcomes" })).toBeDefined();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Worked");
    expect(items[0]!.textContent).toContain("cold email v2");
    expect(items[0]!.textContent).toContain("no reply");
    // Markup a bot wrote is shown as its characters.
    expect(screen.getAllByText("<b>Made-up</b> reply.")).toHaveLength(2);
    expect(items[1]!.textContent).toContain("Pending");
  });

  test("none yet says so", () => {
    convex.setQuery(api.outcomes.forSubject, []);
    render(<OutcomesTimeline kind="partner" id="p1" />);
    expect(screen.getByText(/No outcomes logged yet/)).toBeDefined();
  });

  test("someone without the outcomes area is shown nothing", () => {
    convex.setQuery(api.outcomes.forSubject, [row({})]);
    const { container } = render(
      <ViewerProvider viewer={{ role: "sales", companies: ["us"], areas: ["sales"], email: null, name: null }}>
        <OutcomesTimeline kind="deal" id="d1" />
      </ViewerProvider>,
    );
    expect(container.textContent).toBe("");
  });
});
