// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@convex/_generated/api";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { RecentMeetingsPanel } from "./recent-meetings-panel";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// 11:00 on 12 October 2026 in Almaty (UTC+5).
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 6) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;

// Every title, person and summary here is made up.
const meeting = (meetingId: string, over: object = {}) => ({
  kind: "meeting",
  meetingId,
  title: `Made-up meeting ${meetingId}`,
  heldAt: Date.UTC(2026, 9, 10, 9),
  durationMinutes: 45,
  participants: [
    { name: "Ada Example", address: "ada@example-fund.test" },
    { name: "", address: "bo@clinic.test" },
  ],
  overview: "A made-up summary.",
  actionItems: ["Send the made-up deck", "Book a made-up follow-up"],
  ...over,
});
const read = (over: object = {}) => ({ state: "ok", message: null, lastOkAt: NOW - 5 * 60_000, ...over });

let convex: ReturnType<typeof mockConvex>;
const show = (meetings: object[], source: object = read()) => {
  convex.setQuery(api.workTools.meetings, { source, meetings });
  return render(<RecentMeetingsPanel />);
};
const paragraphs = (container: HTMLElement) =>
  [...container.querySelectorAll("p")].map((p) => p.textContent?.replace(/\s+/g, " ").trim());

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Almaty");
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
  convex.setQuery(api.meetingNotes.list, []);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("RecentMeetingsPanel", () => {
  test("is titled, and shows a skeleton while loading", () => {
    render(<RecentMeetingsPanel />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Recent meetings");
    expect(screen.getByTestId("recent-meetings-loading")).toBeTruthy();
  });

  test("never read: says so and links to the settings", () => {
    const { container } = show([], { state: null, message: null, lastOkAt: null });
    expect(paragraphs(container)).toEqual(["Fireflies has not been read yet. Set it up"]);
    expect(screen.getByRole("link", { name: "Set it up" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(screen.queryByText("No meetings in the last 90 days.")).toBeNull();
  });

  test("none, with the footer", () => {
    const { container } = show([]);
    expect(paragraphs(container)).toEqual([
      "No meetings in the last 90 days.",
      "Read 5m ago.",
    ]);
  });

  test("a meeting is its title and day: no summary, people or action items (those are in Memory)", () => {
    show([meeting("a")]);
    const item = screen.getByRole("heading", { level: 4, name: "Made-up meeting a" }).closest("li")!;
    expect(within(item).getByText("Oct 10")).toBeTruthy();
    expect(item.textContent).not.toContain("A made-up summary.");
    expect(item.textContent).not.toContain("Ada Example");
    expect(item.textContent).not.toContain("Send the made-up deck");
    expect(screen.queryByRole("button", { name: /Add to board/ })).toBeNull();
  });

  test("the owner: a meeting made into notes opens them; any other offers to add notes in Memory", () => {
    convex.setQuery(api.meetingNotes.list, [
      { id: "n1", company: "us", kind: "investor", heldOn: "2026-10-10", title: "Edited title", attendeeCount: 0, actionItems: 2, onBoard: 0, firefliesId: "a" },
    ]);
    show([meeting("a"), meeting("b")]);
    const [a, b] = screen.getAllByRole("listitem");
    expect(within(a!).getByRole("link", { name: "Open notes" }).getAttribute("href")).toBe(
      "/memory?tab=meetings&meeting=n1",
    );
    expect(within(b!).getByRole("link", { name: "Add notes in Memory" }).getAttribute("href")).toBe(
      "/memory?tab=meetings&import=b",
    );
  });

  test("a teammate: titles and days only, and the company's notes are not asked for", () => {
    convex.setQuery(api.workTools.meetings, { source: read(), meetings: [meeting("a")] });
    render(
      <ViewerProvider
        viewer={{ role: "cofounder", companies: ["us"], areas: ["today", "memory"], email: "c@example.test", name: null }}
      >
        <RecentMeetingsPanel />
      </ViewerProvider>,
    );
    expect(screen.getByText("Made-up meeting a")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    const asked = vi
      .mocked(useQuery)
      .mock.calls.filter(([, args]) => args !== "skip")
      .map(([ref]) => getFunctionName(ref as never));
    expect(asked).not.toContain("meetingNotes:list");
  });

  test("the day is the device's own: late evening UTC is already the next day in Almaty", () => {
    show([meeting("a", { heldAt: Date.UTC(2026, 9, 10, 20) })]);
    expect(screen.getByText(/^Oct 11$/)).toBeTruthy();
  });

  test("a meeting from another year says which", () => {
    show([meeting("a", { heldAt: Date.UTC(2025, 11, 30, 9) })]);
    expect(screen.getByText(/^Dec 30, 2025$/)).toBeTruthy();
  });

  test("meetings are listed in the order the query returns them, newest first", () => {
    show([meeting("new"), meeting("old", { heldAt: Date.UTC(2026, 9, 1, 9) })]);
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Made-up meeting new",
      "Made-up meeting old",
    ]);
  });

  test.each([["error"], ["empty"], ["not_configured"]])(
    "when the last read did not succeed (%s) it says this may be out of date, before the footer",
    (state) => {
      const { container } = show(
        [],
        read({ state, message: "Fireflies answered 429 for meetings.", lastOkAt: NOW - 3 * HOUR }),
      );
      expect(paragraphs(container).slice(-2)).toEqual([
        "The last read failed, so this may be out of date.",
        "Read 3h ago.",
      ]);
      expect(container.textContent).not.toContain("answered 429");
    },
  );

  test("a good read carries no warning", () => {
    show([meeting("a")]);
    expect(screen.queryByText("The last read failed, so this may be out of date.")).toBeNull();
  });
});
