import { describe, expect, test } from "vitest";
import { UNREAD_COUNT_CAP } from "@convex/lib/limits";
import { badgeText, bellLabel, sentenceOf, whoOf, type Notification } from "./notifications";

const NOW = Date.UTC(2026, 9, 13, 12);

const row = (over: Partial<Notification>): Notification =>
  ({
    id: "n1",
    kind: "assigned",
    actor: { type: "user", name: "Olga Owner" },
    title: "Call the clinic",
    company: null,
    taskId: "t1",
    column: null,
    to: null,
    due: null,
    createdAt: NOW,
    read: false,
    ...over,
  }) as Notification;

const said = (over: Partial<Notification>) => {
  const { who, lead, title, tail } = sentenceOf(row(over), NOW);
  return `${who} ${lead} ${title}${tail}`;
};

describe("what each kind reads like", () => {
  test.each([
    [{ kind: "assigned" }, "Olga Owner gave you Call the clinic"],
    [{ kind: "reassigned", to: "Cora Founder" }, "Olga Owner moved Call the clinic to Cora Founder"],
    [{ kind: "reassigned", to: null }, "Olga Owner moved Call the clinic to someone else"],
    [{ kind: "unassigned" }, "Olga Owner took you off Call the clinic"],
    [{ kind: "mentioned" }, "Olga Owner mentioned you in Call the clinic"],
    [{ kind: "moved", column: "doing" }, "Olga Owner moved Call the clinic to Doing"],
    [{ kind: "moved", column: "this_week" }, "Olga Owner moved Call the clinic to This week"],
    [{ kind: "moved", column: "done" }, "Olga Owner moved Call the clinic to Done"],
    [{ kind: "finished" }, "Olga Owner finished Call the clinic"],
    [{ kind: "due", due: "2026-10-20" }, "Olga Owner set Call the clinic due Oct 20"],
    [{ kind: "due", due: "2027-01-05" }, "Olga Owner set Call the clinic due Jan 5, 2027"],
    [{ kind: "due", due: null }, "Olga Owner cleared the due date of Call the clinic"],
  ] as [Partial<Notification>, string][])("%o", (over, sentence) => {
    expect(said(over)).toBe(sentence);
  });
});

describe("a bot's handoff to the person", () => {
  test("is said as the bot handing it over, by the bot's id", () => {
    expect(said({ kind: "handoff", actor: { type: "bot", name: "support" }, taskId: null })).toBe(
      "support handed you Call the clinic",
    );
    expect(whoOf({ type: "bot", name: "support" })).toBe("support");
  });
});

describe("a decision due for its revisit", () => {
  test("is said as a reminder, by no person", () => {
    expect(
      said({ kind: "decision_revisit", actor: { type: "system", source: "memory" }, taskId: null }),
    ).toBe("Reminder: time to revisit Call the clinic");
    expect(whoOf({ type: "system", source: "memory" })).toBe("Reminder:");
  });
});

describe("who did it", () => {
  test("a person the viewer is told of, by name", () => {
    expect(whoOf(row({}).actor)).toBe("Olga Owner");
  });
  test("a person the viewer is not told of", () => {
    expect(whoOf({ type: "user", name: null })).toBe("A teammate");
  });
  test("the standup and Telegram, when no person is behind it", () => {
    expect(whoOf({ type: "system", source: "standup" })).toBe("The standup");
    expect(whoOf({ type: "system", source: "telegram" })).toBe("Telegram");
    expect(said({ actor: { type: "system", source: "standup" } })).toBe(
      "The standup gave you Call the clinic",
    );
  });
  test("the owner's Claude, by whose it is where the viewer may be told", () => {
    expect(whoOf({ type: "agent", name: "Olga Owner" })).toBe("Claude (for Olga)");
    expect(whoOf({ type: "agent", name: null })).toBe("The owner's Claude");
    expect(said({ actor: { type: "agent", name: "Olga Owner" } })).toBe(
      "Claude (for Olga) gave you Call the clinic",
    );
  });
});

describe("the bell", () => {
  test("no badge for nothing, the number to nine, then 9+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(UNREAD_COUNT_CAP)).toBe("9+");
  });

  test("its label says how many are unread, and never a number the server stopped counting at", () => {
    expect(bellLabel(undefined)).toBe("Notifications");
    expect(bellLabel(0)).toBe("Notifications, none unread");
    expect(bellLabel(1)).toBe("Notifications, 1 unread");
    expect(bellLabel(12)).toBe("Notifications, 12 unread");
    expect(bellLabel(UNREAD_COUNT_CAP)).toBe(`Notifications, ${UNREAD_COUNT_CAP - 1}+ unread`);
  });
});
