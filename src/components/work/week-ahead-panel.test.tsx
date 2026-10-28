// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { timeLabel } from "@/lib/work/days";
import { WeekAheadPanel } from "./week-ahead-panel";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// 11:00 on Monday 12 October 2026 in Almaty (UTC+5).
const { NOW, clock } = vi.hoisted(() => {
  const NOW = Date.UTC(2026, 9, 12, 6);
  return { NOW, clock: { now: NOW as number | null } };
});
vi.mock("@/hooks/use-now", () => ({ useNow: () => clock.now }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TODAY = Date.UTC(2026, 9, 11, 19); // local midnight in Almaty

// Every title and person here is made up.
const event = (eventId: string, startsAt: number, over: object = {}) => ({
  kind: "event",
  eventId,
  title: `Made-up meeting ${eventId}`,
  startsAt,
  endsAt: startsAt + HOUR,
  allDay: false,
  attendees: [],
  attendeeCount: 0,
  hasMeetingLink: false,
  ...over,
});
const read = (over: object = {}) => ({ state: "ok", message: null, lastOkAt: NOW - 5 * 60_000, ...over });

let convex: ReturnType<typeof mockConvex>;
const show = (events: object[], source: object = read()) => {
  convex.setQuery(api.workTools.events, { source, events });
  return render(<WeekAheadPanel />);
};
const paragraphs = (container: HTMLElement) =>
  [...container.querySelectorAll("p")].map((p) => p.textContent?.replace(/\s+/g, " ").trim());

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Almaty");
  clock.now = NOW;
  convex = mockConvex();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("WeekAheadPanel", () => {
  test("is titled, and shows a skeleton while loading", () => {
    render(<WeekAheadPanel />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("This week");
    expect(screen.getByTestId("week-ahead-loading")).toBeTruthy();
  });

  test("asks for today and the seven days after it, by the device's own days", () => {
    show([]);
    expect(vi.mocked(useQuery)).toHaveBeenCalledWith(api.workTools.events, {
      from: TODAY,
      to: TODAY + 8 * DAY,
    });
  });

  test("asks for nothing until the clock is known", () => {
    clock.now = null;
    show([]);
    expect(vi.mocked(useQuery)).toHaveBeenCalledWith(api.workTools.events, "skip");
    expect(screen.getByTestId("week-ahead-loading")).toBeTruthy();
  });

  test("never read: says so and links to the settings", () => {
    const { container } = show([], { state: null, message: null, lastOkAt: null });
    expect(paragraphs(container)).toEqual(["Google Calendar has not been read yet. Set it up"]);
    expect(screen.getByRole("link", { name: "Set it up" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    // Not eight days of "No meetings.": nothing is known.
    expect(screen.queryByText("No meetings.")).toBeNull();
  });

  test("eight day sections: Today, Tomorrow, then weekday and date; an empty day says so", () => {
    const { container } = show([]);
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent ?? "");
    expect(headings).toHaveLength(8);
    expect(headings[0]).toBe("Today");
    expect(headings[1]).toBe("Tomorrow");
    expect(headings[2]).toMatch(/Wednesday/);
    expect(headings[7]).toMatch(/Monday/);
    expect(screen.getAllByText("No meetings.")).toHaveLength(8);
    expect(paragraphs(container).at(-1)).toBe(
      "Read 5m ago. Times are in this device's time zone.",
    );
  });

  test("a timed meeting: times in the device's zone, title, people and a video call", () => {
    const at = TODAY + 15 * HOUR;
    show([
      event("a", at, {
        attendees: [
          { name: "Ada Example", address: "ada@example-fund.test" },
          { name: "", address: "bo@clinic.test" },
        ],
        attendeeCount: 5,
        hasMeetingLink: true,
      }),
    ]);
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getByText(`${timeLabel(at)} – ${timeLabel(at + HOUR)}`)).toBeTruthy();
    expect(timeLabel(at)).toMatch(/^(3:00\s?PM|15:00)$/);
    expect(within(today).getByText("Made-up meeting a")).toBeTruthy();
    expect(within(today).getByText("Ada Example, bo@clinic.test and 3 more")).toBeTruthy();
    expect(within(today).getByText("Video call")).toBeTruthy();
    expect(screen.getAllByText("No meetings.")).toHaveLength(7);
  });

  test("a meeting without a link says nothing about a call", () => {
    show([event("a", TODAY + 15 * HOUR)]);
    expect(screen.queryByText("Video call")).toBeNull();
  });

  test("an all-day event reads All day, on each of its days", () => {
    show([
      event("offsite", Date.UTC(2026, 9, 13), {
        title: "Made-up offsite",
        allDay: true,
        startDate: "2026-10-13",
        endDate: "2026-10-15",
        endsAt: Date.UTC(2026, 9, 15),
      }),
    ]);
    const tomorrow = screen.getByRole("region", { name: "Tomorrow" });
    expect(within(tomorrow).getByText("All day")).toBeTruthy();
    expect(within(tomorrow).getByText("Made-up offsite")).toBeTruthy();
    expect(screen.getAllByText("Made-up offsite")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Today" })).getByText("No meetings.")).toBeTruthy();
  });

  test("a private event reads Busy with its time and nothing else", () => {
    const at = TODAY + 10 * HOUR;
    show([event("p", at, { title: "Busy" })]);
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getByText("Busy")).toBeTruthy();
    expect(within(today).getByText(`${timeLabel(at)} – ${timeLabel(at + HOUR)}`)).toBeTruthy();
    expect(within(today).getAllByRole("listitem")).toHaveLength(1);
  });

  test("meetings are listed in order within their day", () => {
    show([
      event("late", TODAY + 16 * HOUR),
      event("early", TODAY + 9 * HOUR),
      event("tomorrow", TODAY + DAY + 9 * HOUR),
    ]);
    const today = within(screen.getByRole("region", { name: "Today" }));
    expect(today.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Made-up meeting early"),
      expect.stringContaining("Made-up meeting late"),
    ]);
    expect(
      within(screen.getByRole("region", { name: "Tomorrow" })).getByText("Made-up meeting tomorrow"),
    ).toBeTruthy();
  });

  test.each([["error"], ["empty"], ["not_configured"]])(
    "when the last read did not succeed (%s) it says this may be out of date",
    (state) => {
      const { container } = show(
        [],
        read({ state, message: "Google Calendar answered 500 for events.", lastOkAt: NOW - 2 * HOUR }),
      );
      expect(paragraphs(container).slice(-2)).toEqual([
        "The last read failed, so this may be out of date.",
        "Read 2h ago. Times are in this device's time zone.",
      ]);
      expect(container.textContent).not.toContain("answered 500");
    },
  );

  test("a good read carries no warning", () => {
    show([]);
    expect(screen.queryByText("The last read failed, so this may be out of date.")).toBeNull();
  });
});
