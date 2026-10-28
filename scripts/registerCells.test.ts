import { describe, expect, test } from "vitest";
import { dayOfText, numberOfText } from "./registerCells";

describe("numberOfText", () => {
  test.each([
    ["200000", 200_000],
    [" 200000 ", 200_000],
    ["0", 0],
    ["200 000", 200_000],
    ["1 200 000", 1_200_000],
    ["200 000,5", 200_000.5],
    ["1500.50", 1500.5],
    ["1500,5", 1500.5],
    ["-5", -5],
  ])("%j is %d", (text, value) => {
    expect(numberOfText(text)).toBe(value);
  });

  test.each([
    // A thousands mark or a decimal mark? Not guessed.
    ["200,000"],
    ["1.234"],
    ["200,000.50"],
    ["1 2345"],
    ["₸200000"],
    ["200000 тг"],
    ["12e3"],
    ["0x10"],
    [""],
    ["  "],
    ["SECRET CLINIC"],
  ])("%j is not a number this script will guess at", (text) => {
    expect(numberOfText(text)).toBeNull();
  });
});

describe("dayOfText", () => {
  test.each([
    ["2026-10-01", "2026-10-01"],
    [" 2026-10-01 ", "2026-10-01"],
    ["01.10.2026", "2026-10-01"],
    ["29.02.2028", "2028-02-29"],
  ])("%j is %s", (text, day) => {
    expect(dayOfText(text)).toBe(day);
  });

  test.each([
    // January or October? Not guessed.
    ["10/01/2026"],
    ["31.02.2026"],
    ["2026-02-30"],
    ["1.10.2026"],
    ["01.10.26"],
    ["45000"],
    ["2026-10-01T00:00:00Z"],
    ["soon"],
    [""],
  ])("%j is not a date this script will guess at", (text) => {
    expect(dayOfText(text)).toBeNull();
  });
});
