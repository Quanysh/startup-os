import { describe, expect, test } from "vitest";
import { pushedSnapshotProblems } from "./pushRules";
import type { SnapshotInput } from "./snapshotRules";

// A Wednesday. The week in progress began on Monday 2026-10-12.
const NOW = Date.UTC(2026, 9, 14, 6);

const week = (key: string, scope: string, periodStart: string): SnapshotInput => ({
  key,
  scope,
  period: "week",
  periodStart,
  value: 3,
});

describe("pushedSnapshotProblems", () => {
  test("PostHog: a week that has ended is accepted", () => {
    expect(
      pushedSnapshotProblems("posthog", [week("signups", "startup_insights", "2026-10-05")], NOW),
    ).toEqual([]);
  });

  test("PostHog: the week in progress is refused, by row, in fixed words", () => {
    const rows = [
      week("signups", "startup_insights", "2026-10-05"),
      week("signups", "startup_insights", "2026-10-12"),
    ];
    expect(pushedSnapshotProblems("posthog", rows, NOW)).toEqual([
      {
        index: 1,
        field: "periodStart",
        message: "This week has not ended. Only finished weeks are stored.",
      },
    ]);
  });

  test("PostHog: the week ends at Monday 00:00 UTC, not a moment before", () => {
    const row = [week("signups", "startup_insights", "2026-10-05")];
    expect(pushedSnapshotProblems("posthog", row, Date.UTC(2026, 9, 11, 23, 59))).toHaveLength(1);
    expect(pushedSnapshotProblems("posthog", row, Date.UTC(2026, 9, 12, 0, 0))).toEqual([]);
  });

  test("Apollo: totals to date go in the week they were read in", () => {
    expect(
      pushedSnapshotProblems("apollo", [week("outbound_delivered", "us", "2026-10-12")], NOW),
    ).toEqual([]);
  });

  test("Apollo: an earlier week is refused: today's totals are not last week's", () => {
    expect(
      pushedSnapshotProblems("apollo", [week("outbound_delivered", "us", "2026-10-05")], NOW),
    ).toEqual([
      {
        index: 0,
        field: "periodStart",
        message: "Totals to date belong to the week they are read in.",
      },
    ]);
  });

  test("Apollo: a read just before Monday may arrive just after it", () => {
    const row = [week("outbound_delivered", "us", "2026-10-05")];
    expect(pushedSnapshotProblems("apollo", row, Date.UTC(2026, 9, 12, 3))).toEqual([]);
    expect(pushedSnapshotProblems("apollo", row, Date.UTC(2026, 9, 13, 3))).toHaveLength(1);
  });

  test("Apollo: the new levels are totals to date too, filed under the week they are read in", () => {
    for (const key of ["apollo_contacts", "apollo_accounts", "apollo_tasks_open", "apollo_tasks_overdue"]) {
      expect(pushedSnapshotProblems("apollo", [week(key, "us", "2026-10-12")], NOW), key).toEqual([]);
      expect(pushedSnapshotProblems("apollo", [week(key, "us", "2026-10-05")], NOW), key).toEqual([
        {
          index: 0,
          field: "periodStart",
          message: "Totals to date belong to the week they are read in.",
        },
      ]);
    }
  });

  test("Apollo: a week's own count is stored once the week has ended, however far back", () => {
    for (const key of ["apollo_contacts_added", "apollo_calls"]) {
      const rows = [week(key, "us", "2026-10-05"), week(key, "us", "2026-08-17")];
      expect(pushedSnapshotProblems("apollo", rows, NOW), key).toEqual([]);
    }
  });

  test("Apollo: a week's own count for the week in progress is refused, in fixed words", () => {
    for (const key of ["apollo_contacts_added", "apollo_calls"]) {
      const rows = [week(key, "us", "2026-10-05"), week(key, "us", "2026-10-12")];
      expect(pushedSnapshotProblems("apollo", rows, NOW), key).toEqual([
        {
          index: 1,
          field: "periodStart",
          message: "This week has not ended. Only finished weeks are stored.",
        },
      ]);
    }
  });

  test("other sources have no rule here: the registry's are the whole of it", () => {
    const month: SnapshotInput = {
      key: "cash_in",
      scope: "us",
      period: "month",
      periodStart: "2026-10-01",
      value: 10,
      currency: "USD",
    };
    expect(pushedSnapshotProblems("mercury", [month], NOW)).toEqual([]);
    expect(
      pushedSnapshotProblems("cfo_workbook", [week("signups", "startup_insights", "2026-10-12")], NOW),
    ).toEqual([]);
  });
});
