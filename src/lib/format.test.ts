import { describe, expect, test } from "vitest";
import {
  dayLabel,
  formatChange,
  formatExact,
  formatMinor,
  formatPeriod,
  formatUsd,
  formatValue,
  monthRange,
} from "./format";

describe("formatValue", () => {
  test("small counts are written in full with separators", () => {
    expect(formatValue(1284, "count")).toBe("1,284");
    expect(formatValue(14, "count")).toBe("14");
  });

  test("large counts are compacted to one decimal", () => {
    expect(formatValue(12_900, "count")).toBe("12.9K");
  });

  test("dollars carry the symbol and compact past ten thousand", () => {
    expect(formatValue(3_400, "currency", "USD")).toBe("$3,400");
    expect(formatValue(4_200_000, "currency", "USD")).toBe("$4.2M");
  });

  test("tenge uses its own symbol", () => {
    expect(formatValue(4_200_000, "currency", "KZT")).toBe("₸4.2M");
  });

  test("a negative amount keeps the sign in front of the symbol", () => {
    expect(formatValue(-18_500, "currency", "USD")).toBe("−$18.5K");
  });

  test("percent values are already in percent units", () => {
    expect(formatValue(8.24, "percent")).toBe("8.2%");
  });

  test("months and ratios", () => {
    expect(formatValue(14.3, "months")).toBe("14.3 mo");
    expect(formatValue(1.456, "ratio")).toBe("1.46");
    expect(formatValue(500.25, "ratio")).toBe("500.25");
  });
});

describe("formatValue edge cases", () => {
  test("a value that rounds to zero carries no minus sign", () => {
    expect(formatValue(-0.4, "count")).toBe("0");
    expect(formatValue(-0.04, "percent")).toBe("0%");
  });
});

describe("formatExact", () => {
  test("money is written out in full, so a compact tile can still be checked", () => {
    expect(formatExact(1_234_567, "currency", "USD")).toBe("$1,234,567");
    expect(formatExact(1_234_567.89, "currency", "USD")).toBe("$1,234,567.89");
    expect(formatExact(5_000_000, "currency", "KZT")).toBe("₸5,000,000");
  });

  test("counts are written out in full", () => {
    expect(formatExact(12_900, "count")).toBe("12,900");
  });

  test("other units match the tile", () => {
    expect(formatExact(8.24, "percent")).toBe("8.2%");
    expect(formatExact(500.25, "ratio")).toBe("500.25");
  });
});

describe("formatChange", () => {
  test("a rise is signed with a plus", () => {
    expect(formatChange(0.082)).toBe("+8.2%");
  });

  test("a fall uses a real minus sign", () => {
    expect(formatChange(-0.031)).toBe("−3.1%");
  });

  test("no change has no sign", () => {
    expect(formatChange(0)).toBe("0%");
  });

  test("large swings drop the decimal", () => {
    expect(formatChange(2.4)).toBe("+240%");
  });
});

describe("formatPeriod", () => {
  test("a month reads as month and year", () => {
    expect(formatPeriod("month", "2026-10-01")).toBe("Oct 2026");
  });

  test("a week is named by its Monday", () => {
    expect(formatPeriod("week", "2026-10-12")).toBe("Week of Oct 12");
  });

  test("a day reads as month and day", () => {
    expect(formatPeriod("day", "2026-10-12")).toBe("Oct 12");
  });

  test("the short form is for 'vs' labels", () => {
    expect(formatPeriod("month", "2026-09-01", "short")).toBe("Sep");
    expect(formatPeriod("week", "2026-10-05", "short")).toBe("Oct 5");
    expect(formatPeriod("day", "2026-10-11", "short")).toBe("Oct 11");
  });
});

describe("monthRange", () => {
  test("a run of months inside one year names the year once", () => {
    expect(monthRange("2026-07-01", "2026-09-01")).toBe("Jul–Sep 2026");
  });

  test("a run across a year boundary names both years", () => {
    expect(monthRange("2025-11-01", "2026-01-01")).toBe("Nov 2025–Jan 2026");
  });

  test("a single month is just that month", () => {
    expect(monthRange("2026-09-01", "2026-09-01")).toBe("Sep 2026");
  });
});

describe("dayLabel", () => {
  const NOW = Date.UTC(2026, 9, 12);

  test("a day in the current year needs no year", () => {
    expect(dayLabel("2026-09-30", NOW)).toBe("Sep 30");
  });

  test("a day in another year says which", () => {
    expect(dayLabel("2025-12-31", NOW)).toBe("Dec 31, 2025");
  });
});

describe("formatUsd", () => {
  test("dollars as a tile shows them: in full up to 9,999, compact beyond", () => {
    expect(formatUsd(3_400)).toBe("$3,400");
    expect(formatUsd(12_500)).toBe("$12.5K");
    expect(formatUsd(-4_200_000)).toBe("−$4.2M");
  });

  test("is the currency form of formatValue, never a second opinion", () => {
    for (const n of [0, 0.4, 999.5, 10_000, 410_123.4]) {
      expect(formatUsd(n)).toBe(formatValue(n, "currency", "USD"));
    }
  });
});

describe("formatMinor: an exact amount from its minor units", () => {
  test("dollars always show cents", () => {
    expect(formatMinor(123_450, "USD")).toBe("$1,234.50");
    expect(formatMinor(900_000, "USD")).toBe("$9,000.00");
    expect(formatMinor(7, "USD")).toBe("$0.07");
    expect(formatMinor(0, "USD")).toBe("$0.00");
  });

  test("whole tenge are shown without tiyn; a part tenge keeps both digits", () => {
    expect(formatMinor(45_000_000, "KZT")).toBe("₸450,000");
    expect(formatMinor(45_000_050, "KZT")).toBe("₸450,000.50");
    expect(formatMinor(0, "KZT")).toBe("₸0");
  });

  test("never compacted, however large", () => {
    expect(formatMinor(1_234_567_890_12, "USD")).toBe("$1,234,567,890.12");
  });

  test("a negative keeps the sign in front of the symbol", () => {
    expect(formatMinor(-25_000, "USD")).toBe("−$250.00");
    expect(formatMinor(-25_000_00, "KZT")).toBe("−₸25,000");
  });
});
