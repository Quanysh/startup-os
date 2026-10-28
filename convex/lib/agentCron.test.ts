import { describe, expect, test } from "vitest";
import { CRON_WORDS, cronProblem, minGapMinutes, nextRuns, parseCron } from "./agentCron";

// A declarative agent's schedule (Agents Protocol v1.3): a 5-field cron in
// UTC, checked by the OS before it is published, with its next runs shown.

const at = (iso: string) => Date.parse(iso);
const iso = (times: number[]) => times.map((t) => new Date(t).toISOString());

describe("parseCron", () => {
  test("takes the usual forms: *, a number, a range, a step and a list", () => {
    expect(cronProblem("* * * * *")).toBeNull();
    expect(cronProblem("0 6 * * 1-5")).toBeNull();
    expect(cronProblem("*/15 8-18/2 1,15 1-12 0,6")).toBeNull();
    expect(cronProblem("  30   7 * * 7 ")).toBeNull();
  });

  test("refuses anything but five fields of numbers in range", () => {
    expect(cronProblem("")).toBe(CRON_WORDS.fields);
    expect(cronProblem("* * * *")).toBe(CRON_WORDS.fields);
    expect(cronProblem("* * * * * *")).toBe(CRON_WORDS.fields);
    expect(cronProblem("60 * * * *")).toBe(CRON_WORDS.field("minute"));
    expect(cronProblem("* 24 * * *")).toBe(CRON_WORDS.field("hour"));
    expect(cronProblem("* * 0 * *")).toBe(CRON_WORDS.field("day of the month"));
    expect(cronProblem("* * * 13 *")).toBe(CRON_WORDS.field("month"));
    expect(cronProblem("* * * * 8")).toBe(CRON_WORDS.field("day of the week"));
    expect(cronProblem("5-1 * * * *")).toBe(CRON_WORDS.field("minute"));
    expect(cronProblem("*/0 * * * *")).toBe(CRON_WORDS.field("minute"));
    expect(cronProblem("@daily")).toBe(CRON_WORDS.fields);
    expect(cronProblem("0 9 * JAN MON")).toBe(CRON_WORDS.field("month"));
    expect(cronProblem("1,,2 * * * *")).toBe(CRON_WORDS.field("minute"));
    expect(cronProblem(`${"1,".repeat(60)}1 * * * *`)).toBe(CRON_WORDS.tooLong);
  });

  test("refuses a schedule that can never run", () => {
    expect(cronProblem("0 0 30 2 *")).toBe(CRON_WORDS.never);
    expect(cronProblem("0 0 31 4,6,9,11 *")).toBe(CRON_WORDS.never);
  });

  test("Sunday is 0 or 7", () => {
    const sunday0 = parseCron("0 0 * * 0");
    const sunday7 = parseCron("0 0 * * 7");
    expect(sunday0).not.toBeNull();
    expect(sunday0?.weekdays).toEqual(sunday7?.weekdays);
  });
});

describe("nextRuns", () => {
  test("the next three times after a moment, in UTC, never the moment itself", () => {
    expect(iso(nextRuns("0 6 * * *", at("2026-10-17T06:00:00Z"), 3))).toEqual([
      "2026-10-18T06:00:00.000Z",
      "2026-10-19T06:00:00.000Z",
      "2026-10-20T06:00:00.000Z",
    ]);
    expect(iso(nextRuns("*/20 * * * *", at("2026-10-17T06:05:30Z"), 3))).toEqual([
      "2026-10-17T06:20:00.000Z",
      "2026-10-17T06:40:00.000Z",
      "2026-10-17T07:00:00.000Z",
    ]);
  });

  test("weekdays only: 2026-10-17 is a Saturday", () => {
    expect(iso(nextRuns("30 8 * * 1-5", at("2026-10-17T12:00:00Z"), 3))).toEqual([
      "2026-10-19T08:30:00.000Z",
      "2026-10-20T08:30:00.000Z",
      "2026-10-21T08:30:00.000Z",
    ]);
  });

  test("a day of the month and a day of the week both set: either one runs it", () => {
    // The 1st, or any Monday.
    expect(iso(nextRuns("0 0 1 * 1", at("2026-10-27T00:00:00Z"), 3))).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
      "2026-11-09T00:00:00.000Z",
    ]);
  });

  test("a leap day is found years ahead; nothing for a bad cron", () => {
    expect(iso(nextRuns("0 12 29 2 *", at("2026-10-17T00:00:00Z"), 2))).toEqual([
      "2028-02-29T12:00:00.000Z",
      "2032-02-29T12:00:00.000Z",
    ]);
    expect(nextRuns("not a cron", at("2026-10-17T00:00:00Z"), 3)).toEqual([]);
  });
});

describe("minGapMinutes", () => {
  test("the shortest time between two runs, across hours and midnight", () => {
    expect(minGapMinutes("* * * * *")).toBe(1);
    expect(minGapMinutes("*/5 * * * *")).toBe(5);
    expect(minGapMinutes("0,3 9 * * 1-5")).toBe(3);
    expect(minGapMinutes("0 6 * * *")).toBe(1440);
    expect(minGapMinutes("0 0,12 * * *")).toBe(720);
    // 23:58 and the next day's 00:00.
    expect(minGapMinutes("0,58 0,23 * * *")).toBe(2);
    expect(minGapMinutes("not a cron")).toBeNull();
  });
});
