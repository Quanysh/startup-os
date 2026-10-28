import { describe, expect, test } from "vitest";
import {
  NEEDS_YOU_AFTER_MS,
  finOf,
  isWaitingOnPerson,
  needsYou,
  percentile,
  supportFigures,
  waitsOf,
  type SupportRowView,
} from "./supportMetrics";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Saturday 2026-10-17, 09:00 UTC: the week began on Monday the 12th. */
const NOW = Date.parse("2026-10-17T09:00:00Z");

let next = 1;
function chat(over: Partial<SupportRowView> = {}): SupportRowView {
  return {
    intercomId: String(next++),
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 4 * HOUR,
    state: "open",
    open: true,
    waitingSince: null,
    origin: "customer",
    pageArea: "studies",
    finParticipated: true,
    finOutcome: "escalated",
    humanRepliedAt: null,
    timeToHumanReply: null,
    lastCustomerReplyAt: NOW - 4 * HOUR,
    lastHumanReplyAt: null,
    assigneeId: null,
    assigneeName: null,
    articles: [],
    ...over,
  };
}

describe("isWaitingOnPerson", () => {
  // State table: a customer's open chat that Fin handed on (or could not
  // help with, or never answered), and no person has answered since the
  // customer last wrote. First failing row says why not.
  test.each([
    ["escalated by Fin, nobody answered", {}, true],
    ["negative feedback to Fin", { finOutcome: "negative_feedback" as const }, true],
    ["Fin never answered", { finParticipated: false, finOutcome: null }, true],
    ["Fin resolved it (assumed)", { finOutcome: "assumed_resolution" as const }, false],
    ["Fin resolved it (confirmed)", { finOutcome: "confirmed_resolution" as const }, false],
    ["Fin still on it, no outcome yet", { finOutcome: null }, false],
    ["closed", { state: "closed" as const, open: false }, false],
    ["snoozed", { state: "snoozed" as const }, false],
    ["a test chat", { origin: "test" as const }, false],
    ["another product's", { origin: "other" as const }, false],
    ["no page known", { origin: "unknown" as const }, false],
    ["a person answered after the customer", { lastHumanReplyAt: NOW - 3 * HOUR }, false],
    ["the customer wrote again after a person", { lastHumanReplyAt: NOW - 6 * HOUR }, true],
  ])("%s → %s", (_why, over, waiting) => {
    expect(isWaitingOnPerson(chat(over))).toBe(waiting);
  });
});

describe("waitsOf", () => {
  test("oldest first, waited since Intercom's waiting_since, else the customer's last message, else the start", () => {
    const a = chat({ waitingSince: NOW - 2 * HOUR, lastCustomerReplyAt: NOW - 3 * HOUR });
    const b = chat({ waitingSince: null, lastCustomerReplyAt: NOW - 10 * HOUR });
    const c = chat({ waitingSince: null, lastCustomerReplyAt: null, createdAt: NOW - 30 * HOUR });
    const done = chat({ finOutcome: "assumed_resolution" });
    const waits = waitsOf([a, b, done, c], NOW);
    expect(waits.map((w) => [w.intercomId, w.since, w.waitedMs])).toEqual([
      [c.intercomId, NOW - 30 * HOUR, 30 * HOUR],
      [b.intercomId, NOW - 10 * HOUR, 10 * HOUR],
      [a.intercomId, NOW - 2 * HOUR, 2 * HOUR],
    ]);
  });

  test("a wait is counted to the time of the last push, not to the browser's clock", () => {
    const pushedAt = NOW - 10 * HOUR;
    const a = chat({ waitingSince: NOW - 12 * HOUR });
    expect(waitsOf([a], pushedAt)[0]!.waitedMs).toBe(2 * HOUR);
    expect(needsYou([a], pushedAt)).toEqual([]);
    expect(supportFigures([a], NOW, pushedAt).waiting[0]!.waitedMs).toBe(2 * HOUR);
  });

  test("a wait never reads as negative when a clock is behind", () => {
    expect(waitsOf([chat({ waitingSince: NOW + HOUR })], NOW)[0]!.waitedMs).toBe(0);
  });
});

describe("needsYou: what goes to Today", () => {
  test("a wait of more than four hours, not four exactly", () => {
    const over = chat({ waitingSince: NOW - NEEDS_YOU_AFTER_MS - 1 });
    const at = chat({ waitingSince: NOW - NEEDS_YOU_AFTER_MS });
    expect(NEEDS_YOU_AFTER_MS).toBe(4 * HOUR);
    expect(needsYou([over, at], NOW).map((w) => w.intercomId)).toEqual([over.intercomId]);
  });
});

describe("percentile (nearest rank)", () => {
  test.each([
    [[], 0.5, null],
    [[10], 0.5, 10],
    [[10], 0.9, 10],
    [[30, 10, 20], 0.5, 20],
    [[1, 2, 3, 4], 0.5, 2],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9, 9],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9, 10],
  ])("%j at %d is %s", (values, p, expected) => {
    expect(percentile(values, p)).toBe(expected);
  });
});

describe("finOf: Fin's outcome in the page's words", () => {
  test.each([
    [{ finParticipated: false, finOutcome: null }, "no_fin"],
    [{ finOutcome: "assumed_resolution" as const }, "resolved"],
    [{ finOutcome: "confirmed_resolution" as const }, "resolved"],
    [{ finOutcome: "escalated" as const }, "escalated"],
    [{ finOutcome: "negative_feedback" as const }, "negative_feedback"],
    [{ finOutcome: null }, "pending"],
  ])("%j → %s", (over, outcome) => {
    expect(finOf(chat(over))).toBe(outcome);
  });
});

describe("supportFigures", () => {
  test("with no chat at all, counts are zero and what needs a chat is not known", () => {
    const figures = supportFigures([], NOW);
    expect(figures.openCustomer).toBe(0);
    expect(figures.waiting).toEqual([]);
    expect(figures.firstReply).toEqual({ median: null, p90: null, replied: 0, chats: 0 });
    expect(figures.fin.chats).toBe(0);
    expect(figures.fin.resolvedShare).toBeNull();
    expect(Object.values(figures.fin.rates).every((rate) => rate === null)).toBe(true);
    expect(figures.articles).toEqual([]);
    expect(figures.hygiene).toEqual({ testOpen: 0, openOver30Days: 0 });
    expect(figures.weeks).toHaveLength(8);
    expect(figures.weeks.every((w) => w.customer === 0 && w.test === 0)).toBe(true);
  });

  test("open customer chats count customers only, snoozed included", () => {
    const rows = [
      chat(),
      chat({ state: "snoozed" }),
      chat({ state: "closed", open: false }),
      chat({ origin: "test" }),
    ];
    expect(supportFigures(rows, NOW).openCustomer).toBe(2);
  });

  test("first human reply over the last thirty days of customer chats: median and p90 in seconds", () => {
    const rows = [
      chat({ timeToHumanReply: 60, humanRepliedAt: NOW - HOUR }),
      chat({ timeToHumanReply: 600, humanRepliedAt: NOW - HOUR }),
      chat({ timeToHumanReply: 3600, humanRepliedAt: NOW - HOUR }),
      chat({ timeToHumanReply: null }),
      // Older than thirty days, and a test chat: neither counts.
      chat({ createdAt: NOW - 31 * DAY, timeToHumanReply: 5 }),
      chat({ origin: "test", timeToHumanReply: 5 }),
    ];
    expect(supportFigures(rows, NOW).firstReply).toEqual({ median: 600, p90: 3600, replied: 3, chats: 4 });
  });

  test("Fin's outcomes over the last thirty days of customer chats, and the resolved share of those Fin answered", () => {
    const rows = [
      chat({ finOutcome: "assumed_resolution" }),
      chat({ finOutcome: "confirmed_resolution" }),
      chat({ finOutcome: "escalated" }),
      chat({ finOutcome: "negative_feedback" }),
      chat({ finParticipated: false, finOutcome: null }),
      chat({ finOutcome: null }),
      chat({ origin: "test", finOutcome: "assumed_resolution" }),
      chat({ createdAt: NOW - 40 * DAY, finOutcome: "escalated" }),
    ];
    const { fin } = supportFigures(rows, NOW);
    expect(fin.chats).toBe(6);
    expect(fin.finChats).toBe(5);
    expect(fin.counts).toEqual({ resolved: 2, escalated: 1, negative_feedback: 1, no_fin: 1, pending: 1 });
    expect(fin.rates.resolved).toBeCloseTo(2 / 6);
    expect(fin.rates.no_fin).toBeCloseTo(1 / 6);
    expect(fin.resolvedShare).toBeCloseTo(2 / 5);
  });

  test("with chats but none Fin answered, the resolved share is not known, not zero", () => {
    const { fin } = supportFigures([chat({ finParticipated: false, finOutcome: null })], NOW);
    expect(fin.resolvedShare).toBeNull();
    expect(fin.rates.no_fin).toBe(1);
  });

  test("chats a week for eight weeks, by origin, oldest first; the week in progress is marked", () => {
    const rows = [
      chat({ createdAt: Date.parse("2026-10-13T10:00:00Z") }),
      chat({ createdAt: Date.parse("2026-10-12T00:00:00Z"), origin: "test" }),
      chat({ createdAt: Date.parse("2026-10-11T23:59:59Z") }),
      chat({ createdAt: Date.parse("2026-08-24T10:00:00Z"), origin: "other" }),
      chat({ createdAt: Date.parse("2026-08-23T10:00:00Z") }),
      chat({ createdAt: Date.parse("2026-10-14T10:00:00Z"), origin: "unknown" }),
    ];
    const { weeks } = supportFigures(rows, NOW);
    expect(weeks.map((w) => w.weekStart)).toEqual([
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(weeks[0]).toEqual({ weekStart: "2026-08-24", customer: 0, test: 0, other: 1, unknown: 0, inProgress: false });
    expect(weeks[6]).toMatchObject({ customer: 1, test: 0 });
    expect(weeks[7]).toEqual({ weekStart: "2026-10-12", customer: 1, test: 1, other: 0, unknown: 1, inProgress: true });
  });

  test("the help articles Fin used most in customer chats, most first, then by title", () => {
    const rows = [
      chat({ articles: ["Upload", "Billing"] }),
      chat({ articles: ["Upload"] }),
      chat({ articles: ["Accounts", "Billing"] }),
      chat({ origin: "test", articles: ["Testing only"] }),
      chat({ createdAt: NOW - 45 * DAY, articles: ["Old"] }),
    ];
    expect(supportFigures(rows, NOW).articles).toEqual([
      { title: "Billing", chats: 2 },
      { title: "Upload", chats: 2 },
      { title: "Accounts", chats: 1 },
    ]);
  });

  test("inbox hygiene: test chats still open, and any chat open more than thirty days", () => {
    const rows = [
      chat({ origin: "test" }),
      chat({ origin: "test", state: "snoozed" }),
      chat({ origin: "test", state: "closed", open: false }),
      chat({ createdAt: NOW - 31 * DAY }),
      chat({ origin: "other", createdAt: NOW - 60 * DAY }),
      chat({ createdAt: NOW - 31 * DAY, state: "closed", open: false }),
      chat({ createdAt: NOW - 30 * DAY }),
    ];
    expect(supportFigures(rows, NOW).hygiene).toEqual({ testOpen: 2, openOver30Days: 2 });
  });
});
