import { describe, expect, test } from "vitest";
import { doctorWeekOf, trialOutcomeOf } from "@convex/lib/kzProductDetail";
import { cardDoctors, doctorOver, nextSort, readDoctorsView, sortDoctors, trialDoctors, type Doctor } from "./kz-doctors";

const doctor = (name: string, more: Partial<Doctor> = {}): Doctor =>
  ({
    customerId: "c1",
    doctorId: name,
    name,
    weekStart: "2026-10-05",
    week: "usual",
    weekBefore: "usual",
    actions: 10,
    previous: 10,
    usual: 10,
    activeDays: 3,
    lastActiveOn: "2026-10-09",
    lastEvent: null,
    mainModule: "intake",
    plan: "paid",
    trialEndedOn: null,
    trialOutcome: null,
    actionsBeforeTrialEnd: null,
    actionsAfterTrialEnd: null,
    modules: {},
    modulesPrevious: {},
    history: [],
    ...more,
  }) as Doctor;

describe("a doctor's segment, the weekly report's rules in order", () => {
  test.each([
    [{ actions: 5, usual: 0, days: 1, firstWeek: true }, "new"],
    [{ actions: 0, usual: 2, days: 0, firstWeek: false }, "stopped"],
    [{ actions: 0, usual: 0, days: 0, firstWeek: false, lastWeek: 3 }, "stopped"],
    [{ actions: 0, usual: 0.5, days: 0, firstWeek: false }, "dormant"],
    [{ actions: 4, usual: 10, days: 2, firstWeek: false }, "less"],
    [{ actions: 6, usual: 6, days: 2, firstWeek: false, lastWeek: 20 }, "less"],
    [{ actions: 25, usual: 10, days: 5, firstWeek: false }, "more"],
    [{ actions: 12, usual: 10, days: 4, firstWeek: false }, "daily"],
    [{ actions: 12, usual: 10, days: 2, firstWeek: false }, "usual"],
  ] as const)("%o is %s", (input, week) => {
    expect(doctorWeekOf(input)).toBe(week);
  });

  test("a trial's outcome: paid, then kept on after the day it ended, then left, then never used", () => {
    const base = { paid: false, lastActiveOn: null, endedOn: "2026-10-01", before: 0, after: 0 };
    expect(trialOutcomeOf({ ...base, paid: true })).toBe("paid");
    expect(trialOutcomeOf({ ...base, lastActiveOn: "2026-10-02" })).toBe("kept");
    expect(trialOutcomeOf({ ...base, lastActiveOn: "2026-10-01", before: 3 })).toBe("left");
    expect(trialOutcomeOf(base)).toBe("never");
  });
});

describe("the Doctors tab", () => {
  const roster = [
    doctor("A", { previous: 12, actions: 0, week: "stopped" }),
    doctor("B", { previous: 30, actions: 0, week: "stopped" }),
    doctor("C", { previous: 20, actions: 4, usual: 22, week: "less" }),
    doctor("D", { previous: 2, actions: 25, week: "more" }),
    doctor("E", { previous: null, actions: 7, week: "new", weekBefore: null }),
  ];

  test("each card's doctors in the report's order", () => {
    expect(cardDoctors(roster, "stopped").map((d) => d.name)).toEqual(["B", "A"]);
    expect(cardDoctors(roster, "less").map((d) => d.name)).toEqual(["C"]);
    expect(cardDoctors(roster, "more").map((d) => d.name)).toEqual(["D"]);
    expect(cardDoctors(roster, "new").map((d) => d.name)).toEqual(["E"]);
  });

  test("the list opens with the biggest drop; a new column starts A–Z for words", () => {
    const view = readDoctorsView(new URLSearchParams(""));
    expect(sortDoctors([...roster], view.sort, () => "").map((d) => d.name)).toEqual(["B", "C", "A", "E", "D"]);
    expect(nextSort(view.sort, "doctor")).toEqual({ key: "doctor", dir: "asc" });
    expect(nextSort({ key: "doctor", dir: "asc" }, "doctor")).toEqual({ key: "doctor", dir: "desc" });
  });

  test("the address holds the filter, the sort and the trials list; anything else is the default", () => {
    expect(readDoctorsView(new URLSearchParams("who=card-less&sort=clinic&dir=asc&trials=left"))).toEqual({
      who: { kind: "card", card: "less" },
      sort: { key: "clinic", dir: "asc" },
      trials: "left",
    });
    expect(readDoctorsView(new URLSearchParams("who=daily")).who).toEqual({ kind: "segment", week: "daily" });
    expect(readDoctorsView(new URLSearchParams("who=nope&sort=nope&trials=nope"))).toEqual({
      who: null,
      sort: { key: "loss", dir: "desc" },
      trials: "recent",
    });
  });

  test("trials: newest first; the last two weeks from the Monday before last", () => {
    const ended = [
      doctor("Old", { trialEndedOn: "2026-09-10", trialOutcome: "left" }),
      doctor("Recent", { trialEndedOn: "2026-10-02", trialOutcome: "paid" }),
    ];
    expect(trialDoctors(ended, "all", "2026-09-28").map((d) => d.name)).toEqual(["Recent", "Old"]);
    expect(trialDoctors(ended, "recent", "2026-09-28").map((d) => d.name)).toEqual(["Recent"]);
    expect(trialDoctors(ended, "left", "2026-09-28").map((d) => d.name)).toEqual(["Old"]);
  });
});

describe("a doctor over a period", () => {
  const weeks = (values: number[]) =>
    values.map((actions, i) => ({
      weekStart: new Date(Date.UTC(2026, 6, 20 + 7 * i)).toISOString().slice(0, 10),
      actions,
      days: actions === 0 ? 0 : 2,
      modules: { search: actions },
    }));

  test("one week, as stored", () => {
    const d = doctor("A");
    expect(doctorOver(d, 1)).toBe(d);
  });

  test("over 4 weeks: actions add up, against the 4 before, usual from the spans before", () => {
    // 13 weeks: 12 spans of 1 → three spans of 4 (weeks 2–5, 6–9, 10–13).
    const d = doctor("A", { history: weeks([9, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1, 1]) });
    const over = doctorOver(d, 4);
    expect([over.actions, over.previous, over.usual, over.week]).toEqual([4, 20, 20, "less"]);
    expect(over.modules).toEqual({ search: 4 });
    expect(over.modulesPrevious).toEqual({ search: 20 });
  });

  test("a custom end reads the weeks up to it; new when nothing came before", () => {
    const d = doctor("A", { history: weeks([0, 0, 0, 0, 3, 3, 0, 0]) });
    const over = doctorOver(d, 2, "2026-08-24");
    expect([over.actions, over.previous, over.week]).toEqual([6, 0, "new"]);
  });
});
