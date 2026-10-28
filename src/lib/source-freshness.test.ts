import { describe, expect, test } from "vitest";
import type { Cadence } from "@convex/lib/cadence";
import {
  dayWords,
  STATE_TONE,
  agoWords,
  atWords,
  boardLastChange,
  classify,
  headline,
  lastChange,
  type Reading,
} from "./source-freshness";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12);

const DAILY: Cadence = { kind: "daily", hourUtc: 6, minuteUtc: 0 };
// A daily read is on time for a day and an hour (convex/lib/cadence.ts).
const LIMIT = DAY + HOUR;

const reading = (over: Partial<Reading> = {}): Reading => ({
  id: "mercury",
  label: "Mercury",
  cadence: DAILY,
  lastOkAt: NOW - HOUR,
  lastRunAt: NOW - HOUR,
  failureKey: null,
  ...over,
});

describe("classify", () => {
  test("fresh within the cadence", () => {
    expect(classify(reading(), NOW)).toBe("fresh");
  });
  test("exactly at the cadence is still fresh", () => {
    expect(classify(reading({ lastOkAt: NOW - LIMIT }), NOW)).toBe("fresh");
  });
  test("a moment past the cadence is late", () => {
    expect(classify(reading({ lastOkAt: NOW - LIMIT - 1 }), NOW)).toBe("late");
  });
  test("exactly twice the cadence is still late", () => {
    expect(classify(reading({ lastOkAt: NOW - 2 * LIMIT }), NOW)).toBe("late");
  });
  test("past twice the cadence is out of date", () => {
    expect(classify(reading({ lastOkAt: NOW - 2 * LIMIT - 1 }), NOW)).toBe("stale");
  });
  test("never read", () => {
    expect(classify(reading({ lastOkAt: null, lastRunAt: null }), NOW)).toBe("never");
  });
  test("a failed run after a success is failed, however recent the success", () => {
    expect(classify(reading({ failureKey: "failed", lastOkAt: NOW - MINUTE }), NOW)).toBe("failed");
    expect(classify(reading({ failureKey: "empty" }), NOW)).toBe("failed");
  });
  test("a failed run with no success ever is failed too", () => {
    expect(classify(reading({ failureKey: "failed", lastOkAt: null }), NOW)).toBe("failed");
  });
  test("typed in is never late, whatever its age", () => {
    const typed = reading({ cadence: { kind: "typed" }, lastOkAt: NOW - 400 * DAY });
    expect(classify(typed, NOW)).toBe("typed");
    expect(classify({ ...typed, lastOkAt: null }, NOW)).toBe("never");
  });
  test("each state has its tone: good, watch, weak; never and typed are neutral", () => {
    expect(STATE_TONE).toEqual({
      fresh: "good",
      late: "watch",
      stale: "weak",
      failed: "weak",
      never: "neutral",
      typed: "neutral",
    });
  });
});

describe("the words", () => {
  test("how long ago", () => {
    expect(agoWords(NOW, NOW - 10_000)).toBe("just now");
    expect(agoWords(NOW, NOW - MINUTE)).toBe("1 minute ago");
    expect(agoWords(NOW, NOW - 5 * MINUTE)).toBe("5 minutes ago");
    expect(agoWords(NOW, NOW - 2 * HOUR)).toBe("2 hours ago");
    expect(agoWords(NOW, NOW - DAY)).toBe("1 day ago");
    expect(agoWords(NOW, NOW - 3 * DAY)).toBe("3 days ago");
    expect(agoWords(NOW, NOW - 90 * DAY)).toBe("3 months ago");
  });
  test("when, in the viewer's time zone", () => {
    expect(atWords(Date.UTC(2026, 9, 14, 6, 2), NOW, "Asia/Almaty")).toBe("Oct 14, 11:02");
    expect(atWords(Date.UTC(2025, 11, 31, 23, 0), NOW, "UTC")).toBe("Dec 31, 2025, 23:00");
  });
});

describe("the header's line", () => {
  test("nothing to say for a page with no source", () => {
    expect(headline([], NOW)).toBeNull();
  });

  test("one source on time: when, and nothing more", () => {
    expect(headline([reading({ lastOkAt: NOW - 2 * HOUR })], NOW)).toEqual({
      text: "Updated 2 hours ago",
      note: null,
      tone: "good",
      sentence: "Updated 2 hours ago, on time. Show where this page's figures come from.",
    });
  });

  test("one source late says so in words beside the dot", () => {
    const line = headline([reading({ lastOkAt: NOW - 2 * DAY })], NOW)!;
    expect([line.text, line.note, line.tone]).toEqual(["Updated 2 days ago", "late", "watch"]);
  });

  test("one source never read", () => {
    const line = headline([reading({ lastOkAt: null, lastRunAt: null })], NOW)!;
    expect([line.text, line.note, line.tone]).toEqual(["Not read yet", null, "neutral"]);
  });

  test("one source that failed keeps the age of its last good read", () => {
    const line = headline([reading({ failureKey: "failed", lastOkAt: NOW - 3 * HOUR })], NOW)!;
    expect([line.text, line.note, line.tone]).toEqual(["Updated 3 hours ago", "failed", "weak"]);
  });

  test("several: the oldest in the words, the worst in the dot, and how many are not on time", () => {
    const line = headline(
      [
        reading({ id: "a", lastOkAt: NOW - HOUR, failureKey: "failed" }),
        reading({ id: "b", lastOkAt: NOW - 3 * DAY }),
        reading({ id: "c", lastOkAt: NOW - 2 * HOUR }),
      ],
      NOW,
    )!;
    expect(line).toEqual({
      text: "Oldest source updated 3 days ago",
      note: "1 failed, 1 out of date",
      tone: "weak",
      sentence:
        "Oldest source updated 3 days ago, 1 failed, 1 out of date. Show where this page's figures come from.",
    });
  });

  test("several, one never read: that is the oldest", () => {
    const line = headline(
      [reading({ id: "a" }), reading({ id: "b", lastOkAt: null, lastRunAt: null })],
      NOW,
    )!;
    expect([line.text, line.note, line.tone]).toEqual(["1 source not read yet", null, "neutral"]);
  });

  test("typed-in figures beside read sources are listed but leave the line to the read ones", () => {
    const line = headline(
      [
        reading({ id: "a", lastOkAt: NOW - HOUR }),
        reading({ id: "manual", cadence: { kind: "typed" }, lastOkAt: NOW - 200 * DAY }),
      ],
      NOW,
    )!;
    expect([line.text, line.note, line.tone]).toEqual(["Updated 1 hour ago", null, "good"]);
  });

  test("only typed in: the last change, with no colour", () => {
    const line = headline(
      [reading({ id: "manual", cadence: { kind: "typed" }, lastOkAt: NOW - 5 * DAY })],
      NOW,
    )!;
    expect([line.text, line.note, line.tone]).toEqual(["Typed in · last change 5 days ago", null, "neutral"]);
  });

  test("only typed in, nothing typed yet", () => {
    const line = headline(
      [reading({ id: "manual", cadence: { kind: "typed" }, lastOkAt: null })],
      NOW,
    )!;
    expect([line.text, line.note, line.tone]).toEqual(["Nothing typed in yet", null, "neutral"]);
  });
});

describe("boardLastChange", () => {
  test("the newest activity among the cards made here; a mirrored card's is its source's", () => {
    const card = (mirrored: boolean, lastActivityAt: number | null) => ({ mirrored, lastActivityAt });
    expect(
      boardLastChange({ lead: [card(false, 3), card(true, 99)], won: [card(false, 7), card(false, null)] }),
    ).toBe(7);
    expect(boardLastChange({ lead: [card(true, 5)] })).toBeNull();
  });
});

describe("lastChange", () => {
  test("the newest of the rows' change times", () => {
    expect(lastChange([{ changedAt: 3 }, { changedAt: 9 }, { changedAt: 5 }])).toBe(9);
  });
  test("null with no rows", () => {
    expect(lastChange([])).toBeNull();
  });
});

describe("a source pushed once a day reads by the day", () => {
  const H = 60 * 60 * 1000;
  // Saturday 2026-10-17, 15:00 UTC.
  const NOW = Date.parse("2026-10-17T15:00:00Z");

  test.each([
    [Date.parse("2026-10-17T06:00:00Z"), "this morning"],
    [Date.parse("2026-10-17T13:00:00Z"), "this afternoon"],
    [Date.parse("2026-10-16T20:00:00Z"), "yesterday"],
    [Date.parse("2026-10-16T01:00:00Z"), "yesterday"],
    [Date.parse("2026-10-14T09:00:00Z"), "3 days ago"],
  ])("%d is %s (in UTC)", (at, words) => {
    expect(dayWords(NOW, at, "UTC")).toBe(words);
  });

  test("the header says the day, not the hours, for one such source; any other keeps its hours", () => {
    const daily = headline(
      [{ id: "intercom", label: "Intercom", cadence: { kind: "pushed", everyDays: 1 }, lastOkAt: NOW - 2 * H, lastRunAt: NOW - 2 * H, failureKey: null }],
      NOW,
    );
    expect(daily?.text).toMatch(/^Updated (this morning|this afternoon|this evening|yesterday)$/);
    const pulled = headline(
      [{ id: "mercury", label: "Mercury", cadence: { kind: "daily", hourUtc: 6, minuteUtc: 0 }, lastOkAt: NOW - 2 * H, lastRunAt: NOW - 2 * H, failureKey: null }],
      NOW,
    );
    expect(pulled?.text).toBe("Updated 2 hours ago");
  });
});
