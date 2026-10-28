import { describe, expect, test } from "vitest";
import type { ObligationRow } from "@convex/lib/obligationShape";
import { complianceSummary, dueState, dueText } from "./due";
import { obligation } from "./fixtures";

const TODAY = "2026-10-12";
const NOW = Date.UTC(2026, 9, 12, 12);

const confirmed = (due: string, patch: Partial<ObligationRow> = {}) =>
  obligation({ due, dueConfirmed: true, ...patch });

describe("dueState and dueText", () => {
  test.each([
    [confirmed("2026-10-09"), "overdue", -3, "Overdue by 3 days · was due Oct 9"],
    [confirmed("2026-10-11"), "overdue", -1, "Overdue by 1 day · was due Oct 11"],
    [confirmed("2026-10-12"), "due_soon", 0, "Due today"],
    [confirmed("2026-10-13"), "due_soon", 1, "Due tomorrow"],
    [confirmed("2026-10-24"), "due_soon", 12, "Due in 12 days · Oct 24"],
    [confirmed("2026-11-11"), "due_soon", 30, "Due in 30 days · Nov 11"],
    [confirmed("2026-11-12"), "upcoming", 31, "Due Nov 12"],
    [confirmed("2027-03-01"), "upcoming", 140, "Due Mar 1, 2027"],
    [obligation(), "no_date", null, "No date yet"],
    [obligation({ due: "2027-03-01" }), "unconfirmed", null, "Unconfirmed: Mar 1, 2027"],
    [confirmed("2026-01-01", { status: "done" }), "done", null, "Done"],
    [confirmed("2026-01-01", { status: "not_applicable" }), "not_applicable", null, "Not applicable"],
    [confirmed("2026-10-09", { status: "in_progress" }), "overdue", -3, "Overdue by 3 days · was due Oct 9"],
  ])("%#: %s", (row, state, days, text) => {
    expect(dueState(row, TODAY)).toEqual({ state, days });
    expect(dueText(row, TODAY, NOW)).toBe(text);
  });

  test("an unconfirmed date is never overdue, however old", () => {
    expect(dueState(obligation({ due: "2020-01-01" }), TODAY)).toEqual({
      state: "unconfirmed",
      days: null,
    });
  });
});

describe("complianceSummary", () => {
  test("sorts what needs acting on, and counts the rest", () => {
    const rows = [
      confirmed("2026-10-09", { title: "Late" }),
      confirmed("2026-09-01", { title: "Later still" }),
      confirmed("2026-11-01", { title: "Soon" }),
      confirmed("2026-10-20", { title: "Sooner" }),
      confirmed("2027-06-01", { title: "Far" }),
      obligation({ due: "2026-01-01", title: "Guess" }),
      obligation({ title: "Undated" }),
      obligation({ title: "Undated too" }),
      confirmed("2026-01-01", { status: "done", title: "Finished" }),
      obligation({ status: "not_applicable", title: "Skipped" }),
    ];
    const summary = complianceSummary(rows, TODAY);
    // Oldest first: it has waited longest.
    expect(summary.overdue.map((o) => o.title)).toEqual(["Later still", "Late"]);
    // Nearest first.
    expect(summary.dueSoon.map((o) => o.title)).toEqual(["Sooner", "Soon"]);
    expect(summary.unconfirmed.map((o) => o.title)).toEqual(["Guess"]);
    expect(summary.noDate).toBe(2);
    expect(summary.done).toBe(1);
    expect(summary.total).toBe(10);
  });
});
