import { describe, expect, test } from "vitest";
import { formatRate, moneyInput, monthOf, parseMoney, parsePercent, percentInput } from "./input";

describe("parseMoney: what was typed, as a whole number of minor units", () => {
  test.each([
    ["1234.50", 123_450],
    ["1,234.5", 123_450],
    ["450 000", 45_000_000],
    ["450 000", 45_000_000],
    ["0", 0],
    ["0.07", 7],
    [" 12 ", 1_200],
    [".5", 50],
  ])("%j is %i", (text, minor) => {
    expect(parseMoney(text)).toBe(minor);
  });

  test.each(["", "  ", "abc", "1.234", "1.2.3", "-5", "+5", "1e3", "12,34.5.", "٣", "."])(
    "%j is not an amount",
    (text) => {
      expect(parseMoney(text)).toBeNull();
    },
  );

  test("a sign is read only where one is allowed", () => {
    expect(parseMoney("-250.00", { signed: true })).toBe(-25_000);
    expect(parseMoney("−250", { signed: true })).toBe(-25_000); // U+2212
    expect(parseMoney("+250", { signed: true })).toBe(25_000);
    expect(parseMoney("-0", { signed: true })).toBe(0);
  });

  test("past what a whole number holds exactly is not an amount", () => {
    expect(parseMoney("99999999999999999999")).toBeNull();
  });
});

describe("moneyInput", () => {
  test("an amount as it is typed back: no separators, cents only when there are some", () => {
    expect(moneyInput(123_450)).toBe("1234.50");
    expect(moneyInput(45_000_000)).toBe("450000");
    expect(moneyInput(7)).toBe("0.07");
    expect(moneyInput(-25_000)).toBe("-250");
    expect(moneyInput(0)).toBe("0");
  });

  test("round trip", () => {
    for (const minor of [0, 1, 99, 100, 123_456_789, 500_000_00]) {
      expect(parseMoney(moneyInput(minor))).toBe(minor);
    }
  });
});

describe("parsePercent: a rate typed as a percentage, in basis points", () => {
  test.each([
    ["10", 1000],
    ["12.5", 1250],
    ["0", 0],
    ["100", 10_000],
    ["3.25", 325],
    [" 9.5 % ", 950],
    ["0.01", 1],
    [".5", 50],
  ])("%j is %i bp", (text, bp) => {
    expect(parsePercent(text)).toBe(bp);
  });

  test.each(["", "abc", "12.345", "-1", "100.01", "101", "1,5", "1e1"])(
    "%j is not a rate",
    (text) => {
      expect(parsePercent(text)).toBeNull();
    },
  );
});

describe("percentInput and formatRate", () => {
  test("basis points back as a percentage", () => {
    expect(percentInput(1250)).toBe("12.5");
    expect(percentInput(1000)).toBe("10");
    expect(percentInput(1)).toBe("0.01");
    expect(percentInput(0)).toBe("0");
    expect(formatRate(1250)).toBe("12.5%");
    expect(formatRate(325)).toBe("3.25%");
  });

  test("round trip", () => {
    for (const bp of [0, 1, 10, 99, 100, 1234, 10_000]) expect(parsePercent(percentInput(bp))).toBe(bp);
  });
});

describe("monthOf", () => {
  test("the first day of the month where the user is", () => {
    // Built from local parts, so the test holds in any time zone.
    expect(monthOf(new Date(2026, 9, 13, 23, 30).getTime())).toBe("2026-10-01");
    expect(monthOf(new Date(2027, 0, 1, 0, 5).getTime())).toBe("2027-01-01");
  });
});
